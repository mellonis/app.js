# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A tiny reactive framework in a single ES module (`app.js`), written as a teaching project for students learning JavaScript and the DOM. It is deliberately dependency-free vanilla JS: no build step, no bundler, no libraries. Keep it that way — the constraint is the point of the project.

## Commands

There is no build, lint, or test tooling (`npm test` is an unimplemented stub). To exercise the framework manually, serve the directory over HTTP (templates are loaded with `fetch`, so `file://` will not work):

```sh
python3 -m http.server   # or: npx serve
```

You need a host page that imports the framework as an ES module and a `/templates` directory at the server root (neither exists in this repo — the framework is the only artifact):

```html
<script type="module">
  import App from '/app.js';
  new App({ data: { ... }, methods: { ... } });
</script>
```

## Architecture

Everything is the `App` class in `app.js`. One instance = one component tree rooted at `element` (default `document.body`).

**Reactivity — `createGhost(data)`.** The constructor wraps `data` in a "ghost" object: each primitive key becomes a getter/setter pair over the original data, each object key recurses into a nested ghost. Every set triggers `updateVisibility()` and `updateValues()` — there is no dependency tracking; all bindings re-evaluate on any change. Ghosts are non-extensible, so the data shape is fixed at construction. A setter given an `HTMLInputElement` stores its `.value` instead (this is how two-way input binding writes back).

**Templates and components.** `loadComponent()` fetches `/templates/<componentName>.html`, renders it, and appends the result into the wrapper element. Template fetches are cached in a static `Map` (template-name → promise) shared by all `App` instances. Each template file must have a `<template>` element as its first child — `renderTemplate` reads `divElement.firstChild.content`. Elements with `data-component="name"` inside a template recursively load that template as a sub-component; cycles are detected via `parentComponentNameList` and rejected. Sub-components share the root instance's `data`/`methods` — there is no per-component scope.

**Directives** (wired up once, in `renderTemplate`):
- `data-show-if="expr"` — element is swapped with an anchor comment node when the expression is falsy (`hideElement`/`showElement`), not CSS-hidden.
- `data-value="expr"` — binds into `value` for `<input>` (two-way, via the `input` event) and `textContent` for everything else (one-way).
- `data-on-click` / `data-on-submit` — attribute value is a key in `methods`. Only these two events are supported; to add one, extend `eventNameList` in `renderTemplate`.

**Expression evaluation — `evaluate()`.** Directive expressions are arbitrary JavaScript, executed with `eval` after declaring every top-level `data` key as a local `var`. Consequently only top-level keys are directly referenceable (nested values via `parent.child`), and an input's write-back works by `eval`-ing `<expression> = element`, which lands in the ghost setter described above.

**Methods.** Bound to the app instance at construction, so `this` inside a method is the `App` (giving access to `this.data`); they receive the DOM event as their only argument.
