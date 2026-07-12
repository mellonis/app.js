# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A tiny reactive framework written as a teaching project for students learning JavaScript and the DOM. The source of truth is `src/app.ts` (TypeScript 7, strict, native `#private` internals); `tsc` emits `app.js` + `app.d.ts` at the repo root, and both artifacts stay **committed** so a page can `import App from '/app.js'` with no build step. Never hand-edit the root artifacts — change `src/app.ts` and run the build; CI fails if they drift. Runtime dependencies: none — keep it that way.

## Commands

```sh
npm ci            # install dev deps (typescript, vitest, happy-dom)
npm run build     # tsc -p tsconfig.build.json → app.js + app.d.ts at root
npm run typecheck # tsc -p tsconfig.json (src + tests, no emit)
npm test          # vitest run (happy-dom environment)
npx vitest run tests/components.test.ts   # single file
```

Tests import `../src/app` directly. Known open bugs (#2, #8) are encoded as `it.fails` cases asserting the *desired* behavior — when you fix one, its `it.fails` starts failing; remove the `.fails` modifier as part of the fix.

To exercise the framework manually, serve the directory over HTTP (templates load via `fetch`, so `file://` won't work) with a host page and a `/templates` directory — see README.

## Architecture

Everything is the `App` class in `src/app.ts`. One instance = one component tree rooted at `element` (default `document.body`). Internals are native `#private`; the public surface is the constructor, `element`, `data`, `methods`, `componentName`, `ready` (a promise that settles when the initial mount finishes — rejections carry the original error, with a built-in `console.error` fallback), `static loadTemplate`, and the static template cache map.

**Reactivity — `createGhost(data)`.** The constructor wraps `data` in a "ghost" object: each primitive key becomes a getter/setter pair over the original data, each object key recurses into a nested ghost. Every set triggers `updateVisibility()` and `updateValues()` — there is no dependency tracking; all bindings re-evaluate on any change. Ghosts are non-extensible, so the data shape is fixed at construction. A setter given an `HTMLInputElement` stores its `.value` instead (this is how two-way input binding writes back).

**Templates and components.** `loadComponent()` fetches `/templates/<componentName>.html`, renders it, and appends the result into the wrapper element. Template fetches are cached in a static `Map` (template-name → promise) shared by all `App` instances; a failed load — network error or non-`ok` HTTP response — rejects with the original error and is evicted from the cache so the next load retries. Each template file must have a `<template>` element as its first child — `renderTemplate` reads `divElement.firstChild.content`. Elements with `data-component="name"` inside a template recursively load that template as a sub-component; each recursion branch carries its own copy of the ancestor chain, so reuse across branches is fine while true cycles are rejected (issue #1). Sub-components share the root instance's `data`/`methods` — there is no per-component scope.

**Directives** (wired up once, in `renderTemplate`):
- `data-show-if="expr"` — element is swapped with an anchor comment node when the expression is falsy (`hideElement`/`showElement`), not CSS-hidden.
- `data-value="expr"` — binds into `value` for `<input>` (two-way, via the `input` event) and `textContent` for everything else (one-way).
- `data-on-click` / `data-on-submit` — attribute value is a key in `methods`. Only these two events are supported; to add one, extend `eventNameList` in `renderTemplate`.

**Expression evaluation — `evaluate()`.** Directive expressions are arbitrary JavaScript, executed with `eval` after declaring every top-level `data` key as a local `var`. Consequently only top-level keys are directly referenceable (nested values via `parent.child`), and an input's write-back works by `eval`-ing `<expression> = element`, which lands in the ghost setter described above.

**Methods.** Bound to the app instance at construction, so `this` inside a method is the `App` (giving access to `this.data`); they receive the DOM event as their only argument.
