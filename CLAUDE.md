# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A tiny reactive framework written as a teaching project for students learning JavaScript and the DOM, structured as an npm-workspaces monorepo. The framework lives in `packages/app.js` (TypeScript 7, strict, native `#private` internals; source of truth `packages/app.js/src/app.ts`); its build output `dist/` is **generated and gitignored — never commit build output**. A `prepare` script rebuilds `dist/` on every `npm install`. Runnable examples live in `packages/examples`, each served as its own web root by the zero-dependency `serve.mjs` (which aliases `/app.js` to the framework build). Framework runtime dependencies: none — keep it that way.

## Commands

```sh
npm install         # dev deps + builds packages/app.js/dist via prepare
npm run build       # tsc → packages/app.js/dist
npm run typecheck   # all workspaces
npm test            # framework unit suite + examples smoke suite
npm run ex:counter  # serve the counter example on :8123
npm run ex:form     # serve the form example on :8123
npm test -w app.js -- tests/components.test.ts   # single test file
```

Framework tests import `../src/app` directly; examples smoke tests drive the built `dist/` over real HTTP via `serve.mjs` + happy-dom's `Browser` (with `enableJavaScriptEvaluation: true`). Convention for newly found bugs: encode each as an `it.fails` case asserting the *desired* behavior (with its issue number in the test name) — once the bug is fixed, that test starts failing; remove the `.fails` modifier as part of the fix. No such markers are currently open.

## Architecture

Everything is the `App` class in `packages/app.js/src/app.ts`. One instance = one component tree rooted at `element` (default `document.body`). Internals are native `#private`; the public surface is the constructor, `element`, `data`, `methods`, `componentName`, `ready` (a promise that settles when the initial mount finishes — rejections carry the original error, with a built-in `console.error` fallback), `static loadTemplate`, and `static clearTemplateCache`.

**Reactivity — `createGhost(data)`.** The constructor wraps `data` in a "ghost" object: each primitive key becomes a getter/setter pair over the original data, each object key recurses into a nested ghost. Every set triggers `updateVisibility()` and `updateValues()` — there is no dependency tracking; all bindings re-evaluate on any change. Ghosts are non-extensible, so the data shape is fixed at construction. A setter given an `HTMLInputElement` stores its `.value` instead (this is how two-way input binding writes back).

**Templates and components.** `loadComponent()` fetches `/templates/<componentName>.html`, renders it, and appends the result into the wrapper element. Template fetches are cached in a static `Map` (template-name → promise) shared by all `App` instances; a failed load — network error or non-`ok` HTTP response — rejects with the original error and is evicted from the cache so the next load retries. Each template file must have a `<template>` element as its first child — `renderTemplate` reads `divElement.firstChild.content`. Elements with `data-component="name"` inside a template recursively load that template as a sub-component; each recursion branch carries its own copy of the ancestor chain, so reuse across branches is fine while true cycles are rejected (issue #1). Sub-components share the root instance's `data`/`methods` — there is no per-component scope.

**Directives** (wired up once, in `renderTemplate`):
- `data-show-if="expr"` — element is swapped with an anchor comment node when the expression is falsy (`hideElement`/`showElement`), not CSS-hidden.
- `data-value="expr"` — binds into `value` for `<input>` (two-way, via the `input` event) and `textContent` for everything else (one-way).
- `data-on-click` / `data-on-submit` — attribute value is a key in `methods`. Only these two events are supported; to add one, extend `eventNameList` in `renderTemplate`.

**Expression evaluation — `evaluate()`.** Directive expressions are arbitrary JavaScript, executed with `eval` after declaring every top-level `data` key as a local `var`. Consequently only top-level keys are directly referenceable (nested values via `parent.child`), and an input's write-back works by `eval`-ing `this.data.<expression> = element` — rooted at the ghost object so its setter fires (a bare `<expression> = element` would assign the eval-local `var` instead).

**Methods.** Bound to the app instance at construction, so `this` inside a method is the `App` (giving access to `this.data`); they receive the DOM event as their only argument.
