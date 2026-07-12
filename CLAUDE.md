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
npm run ex:todo     # serve the todo example on :8123
npm test -w app.js -- tests/components.test.ts   # single test file
```

Framework tests import `../src/app` directly; examples smoke tests drive the built `dist/` over real HTTP via `serve.mjs` + happy-dom's `Browser` (with `enableJavaScriptEvaluation: true`). Convention for newly found bugs: encode each as an `it.fails` case asserting the *desired* behavior (with its issue number in the test name) — once the bug is fixed, that test starts failing; remove the `.fails` modifier as part of the fix. No such markers are currently open.

Known upstream issue: happy-dom ≤ 20.10.6 silently drops falsy non-string `textContent` assignments (`el.textContent = 0` renders empty; browsers render `"0"`) — [capricorn86/happy-dom#2236](https://github.com/capricorn86/happy-dom/issues/2236), fix submitted as [PR #2237](https://github.com/capricorn86/happy-dom/pull/2237). The counter smoke test carries a documented workaround; when a fixed happy-dom ships, bump the pin, remove the workaround, and restore the zero-render assertions (see the comment in `packages/examples/tests/counter.smoke.test.ts`).

## Architecture

Everything is the `App` class in `packages/app.js/src/app.ts`. One instance = one component tree rooted at `element` (default `document.body`). Internals are native `#private`; the public surface is the constructor, `element`, `data`, `methods`, `componentName`, `ready` (a promise that settles when the initial mount finishes — rejections carry the original error, with a built-in `console.error` fallback), `destroy()` (aborts every listener via a single `AbortController` signal, clears the binding maps and list registries, gates further update passes, and rejects a still-pending `ready` quietly — rendered DOM is left in place), `static loadTemplate`, and `static clearTemplateCache`.

**Reactivity — `createGhost(data)`.** The constructor wraps `data` in a "ghost" object: each primitive key becomes a getter/setter pair over the original data, each object key recurses into a nested ghost; arrays are leaf values — replace them to update (`data.todos = [...data.todos, x]`; `push` alone doesn't trigger, and `data.todos = data.todos` is the sanctioned escape hatch after in-place mutation). Every set triggers `runUpdatePass()` — list reconciliation (`updateLists`), then `updateVisibility()`, then `updateValues()` — there is no dependency tracking; all bindings (and all list blocks) re-evaluate on any change. Ghosts are non-extensible, so the data shape is fixed at construction. A setter given an `HTMLInputElement` stores its `.value` instead (this is how two-way input binding writes back).

**Templates and components.** `loadComponent()` fetches `/templates/<componentName>.html`, renders it, and appends the result into the wrapper element. Template fetches are cached in a static `Map` (template-name → promise) shared by all `App` instances; a failed load — network error or non-`ok` HTTP response — rejects with the original error and is evicted from the cache so the next load retries. Each template file must have a `<template>` element as its first child — `renderTemplate` reads `divElement.firstChild.content`. Elements with `data-component="name"` inside a template recursively load that template as a sub-component; each recursion branch carries its own copy of the ancestor chain, so reuse across branches is fine while true cycles are rejected (issue #1). Sub-components share the root instance's `data`/`methods` — there is no per-component scope.

**Directives** (wired up once, in `renderTemplate`):
- `data-show-if="expr"` — element is swapped with an anchor comment node when the expression is falsy (`hideElement`/`showElement`), not CSS-hidden.
- `data-display-if="expr"` — toggles inline `style.display` (`none` ↔ the element's original inline value) while the element stays in the DOM — the CSS-friendly counterpart to `data-show-if` (stable siblings/`:nth-child`; stylesheet `display` applies when the original inline value is empty). Allowed on a `data-for` element itself (no anchor conflict) and inside items, with item scope.
- `data-value="expr"` — binds into `value` for `<input>` (two-way, via the `input` event) and `textContent` for everything else (one-way).
- `data-on-click` / `data-on-submit` — attribute value is a key in `methods`. Only these two events are supported; to add one, extend the module-level `eventNameList` in `app.ts`.
- `data-for="expr"` + required `data-key="expr"` — keyed list rendering. The element is the per-item template (replaced by an anchor-comment pair); clones are reconciled by `String(key)`: reuse/move/remove, first duplicate wins. Runtime list errors (throwing/non-array list expressions, throwing keys, duplicate keys) log once while they persist and re-arm after a clean pass. Item expressions see `$item`, `$index` (source-array index), `$array` (the list evaluated this pass). Not combinable with `data-show-if`/`data-component` on the same element; no nested `data-for`/`data-component` in the block; no `<input data-value>` inside items — all loud setup errors. Handlers inside items are invoked as `method(event, item, index)`, resolved at event time.

**Expression evaluation — `evaluate()`.** Directive expressions are arbitrary JavaScript, executed with `eval` after declaring every top-level `data` key as a local `var`. Consequently only top-level keys are directly referenceable (nested values via `parent.child`; inside `data-for` items, `$item`/`$index`/`$array` are also in scope and shadow same-named data keys), and an input's write-back works by `eval`-ing `this.data.<expression> = this.#evaluationElement` — rooted at the ghost object so its setter fires, with the input delivered through a `#private` field because both bare identifiers in that statement could otherwise be shadowed by same-named data keys.

**Methods.** Bound to the app instance at construction, so `this` inside a method is the `App` (giving access to `this.data`); they are invoked as `method(event, item, index)` — `item`/`index` carry values for handlers inside a `data-for` block (resolved at event time) and are `undefined` elsewhere.
