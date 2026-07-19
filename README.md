# app.js
A tiny reactive framework

# Overview

- Templates should be placed in /templates directory
- Meaningful attributes in templates are: data-component, data-show-if, data-display-if, data-disabled-if, data-value, data-on-*, data-for + data-key, data-ref, data-slot
- Component needs to be constructed with parameters: element, data, methods and componentName, which is optional
- A Component instance exposes `ready` — a promise that resolves when the initial mount finishes (and rejects with the original error if it fails)
- `app.destroy()` stops the app: listeners are removed (one `AbortController` for everything), updates stop, the rendered DOM stays as-is
- A template that fails to load (network error or HTTP error status) is not cached — the next load retries the fetch
- Template text supports `${expression}` interpolation (escape a literal with `\${`)
- Lists render with `data-for` (a bare array expression) plus a required `data-key`; item expressions see `$item`, `$index`, `$array`
- Arrays update by replacement: `todos = [...todos, item]` — prefer copy-based expressions like `todos.filter(...)` / `[...todos].sort(...)`
- File inputs are never value-bound — a browser won't let script set `.files`, so `data-value` on `type="file"` is a loud error. Handle the `change` event directly and store only what you need from it:

  ```html
  <input type="file" data-on-change="pickFile">
  ```

  ```js
  pickFile(event) {
      const [file] = event.target.files;
      // read/upload; store derived primitives (name, size) in data — not the File itself
  }
  ```

# Reactivity

- A write to `data` schedules a render rather than running one immediately; every write that lands in the same microtask — one, or a dozen — coalesces into a single render.
- `await app.updated()` resolves once that pending render has settled onto the DOM — *this* component's render. Reach for it right after a write, in a test or inside a method, whenever you need to read the DOM back. If the write feeds a prop of a child component, the child re-renders on its own later microtask, so reading DOM that the **child** paints needs one more turn of the event loop after the `await` (`await new Promise(resolve => setTimeout(resolve))`). Everything your own template's bindings paint is settled as soon as `updated()` returns.
- Writing the same value a key already holds is free: a primitive (or `null`) write that doesn't actually change anything renders nothing at all.
- Arrays and plain objects still update by replacement, but mutating one in place and then reassigning the very same reference is a sanctioned escape hatch that does render: `data.todos = data.todos` after pushing into it in place, `data.user = data.user` after editing one of its keys, or reassigning partway down a chain (`data.user.address = data.user.address`) all work. Replacing a plain object with a genuinely different one is still a loud error — only self-assignment is allowed there.
- Inside a method, the idiom for "write, then read the DOM back" is: write `this.data`, `await this.updated()`, then read `this.refs` — your own elements are guaranteed settled by the time that `await` returns. (A child component you passed new props to is not: it flushes on its own later microtask.)

# Expressions

- Every directive attribute and every `${...}` placeholder shares one small expression language: numbers, strings, booleans, `null`/`undefined`, array literals with spreads; property access via `.`, `[]`, and `?.`; function calls; arrow functions; ternaries and logical operators (`&&`, `||`, `??`); and `|>` pipes. There is no assignment and no statements — an expression only ever produces a value.
- Names resolve through one fixed chain: item scope inside a `data-for` (`$item`, `$index`, `$array`) → component props → `data` → `methods` → a small whitelist of globals (`Math`, `JSON`, `Number`, `String`, `Boolean`, `Array`, `isNaN`, `isFinite`, `parseInt`, `parseFloat`).
- A pipe calls its right side with its left side as the sole argument, so a formatter is just a method: `<p>${todos |> left} left</p>` calls `methods.left(todos)` and renders the count.
- A malformed expression is caught when the template loads, not when it renders — the console gets the expression text with a caret under the character that broke parsing.
- Expressions are parsed and evaluated by the framework itself — no `eval`, no `unsafe-eval` CSP requirement; loading component `<script>`s still uses `data:` module imports.

# Components

- A component template file may carry a `<script>` after its `<template>` — a single-file component (SFC), with its own `data`, `methods`, `props`, `events`, `refs`, and `mounted()` lifecycle. A file with no `<script>` stays a template-only include, sharing the parent's `data`/`methods`.
- `mounted()` runs once the component's subtree is in the DOM. If it **returns a function**, that function is the component's cleanup and runs at `destroy()` — the other half of the lifecycle. It runs *before* listeners are severed, so a parting `this.events.emit(...)` still reaches the parent; a cleanup that throws is logged and does not stop the teardown. Use it to undo anything the framework does not own — a timer, a subscription, a listener on `window`:

  ```js
  export default {
      data: () => ({ticks: 0}),
      mounted() {
          const id = setInterval(() => { this.data.ticks += 1; }, 1000);

          return () => clearInterval(id);
      },
  };
  ```
- Props flow in, events flow out:

  ```html
  <div data-component="todo-item"
       data-component-prop-todo="$item"
       data-component-on-toggled="toggleTodo"></div>
  ```

- `data:` module imports (how a component's `<script>` is loaded) require a CSP without a strict `script-src` — fine for the teaching context.
- Student trap: component events always ride the `data-component-` prefix — `data-on-removed` on a component element binds a DOM event that will never fire.

## Slots (content projection)

- A script-bearing component's template can declare `<slot>` (default) and `<slot name="x">` (named) regions. The parent routes markup into them by marking a `data-component` wrapper's top-level children with `data-slot="x"`; everything else falls into the default slot. A slot's own children render as a fallback, but only when nothing was projected into it. Projected content keeps the parent's scope (its expressions and handlers still resolve through the parent); a rendered fallback is scoped to the child instead.

  ```html
  <!-- templates/card.html -->
  <template>
      <div class="card">
          <h2><slot name="title">Untitled</slot></h2>
          <div class="card-body"><slot>Nothing here yet.</slot></div>
      </div>
  </template>
  <script>export default {};</script>
  ```

  ```html
  <div data-component="card">
      <span data-slot="title">Hello</span>
      <p>Landed in the default slot.</p>
  </div>
  ```

- A component with no `<slot>` at all can't take wrapper content — putting markup inside its `data-component` element is a loud error, and the content is dropped.

- The cards example runs projection end to end: one card component filled three different ways — both slots projected, reactive parent-owned content, and nothing at all (fallbacks).

## Styles (per-component CSS)

- A single-file component may also carry one `<style>` after its `<template>` — one `<script>` and one `<style>`, in either order. The CSS is injected into `document.head` once per component type, wrapped in the platform's `@scope` rule, so it applies inside every instance of that component and stops at any nested single-file component — whose own file styles its own subtree. A template-only include is not a boundary: its markup is styled through the component that includes it, just as it shares that component's data and methods:

  ```html
  <!-- templates/card.html -->
  <template>
      <section class="card">...</section>
  </template>
  <style>
      .card { border: 1px solid #ddd; }
      :scope { display: block; }
  </style>
  <script>export default {};</script>
  ```

- `:scope { }` selects the component's own wrapper element (each instance's `data-component` element). Prefer this explicit form over bare declarations — it reads as a rule, and its 0-1-0 specificity matches the page-level attribute selector it replaces.
- Scoping follows geometry, not ownership: content the parent projects into a child's slot relocates inside the child's subtree, so the parent's scoped rules no longer reach it — the child's scoped rules do.
- A scoped rule beats an equal-specificity page rule regardless of source order: scoped rules have finite proximity, page rules infinite.
- At-rules ride along verbatim: `@media` nests fine; `@keyframes` and `@font-face` are valid, but their names are global — collisions across components are the author's to avoid; `@import` is silently invalid mid-sheet.
- Template-only includes have no style vocabulary — a `<style>` in a scriptless file is a loud error, and so is one in the root component's own file: root styles belong to the host page's stylesheet. One naming caveat: don't give an SFC the root's `componentName`, and don't mount the root on an element whose `data-component` names an SFC — the root mount would become a scoping root for that type's styles page-wide.

# Where to start

The examples form a ladder — each one introduces the next handful of ideas:

1. **counter** — a component, `${}` interpolation, `data-on-click`, state that
   re-renders when written.
2. **form** — two-way `data-value` on text inputs, selects, checkboxes, and a
   radio group; `data-on-submit`.
3. **todo** — keyed lists (`data-for` + `data-key`), `data-show-if`, and a
   single-file child component with props and events.
4. **cards** — content projection: named and default slots, fallbacks, and
   parent-owned reactive content (a list, an input, a toggle) living inside a
   child component's markup.
5. **registration** — everything at once: a revealed section, repeatable
   component rows, a submit button gated by `data-disabled-if`, pipes, and
   real Zod validation.

Read the framework the same way: `docs/internals.md` is the map, and the git
history is the long course — the engine grew one reviewed feature at a time,
and every stage still runs if you check it out.

# Quick start

Node 22 or newer is required (the framework itself ships no runtime
dependencies; Node is needed only to build it and to serve the examples).

```sh
git clone <this repository>
cd app.js
npm install        # installs dev deps and builds the framework
npm run ex:counter      # counter example → http://localhost:8123/
npm run ex:form         # form-submit example → http://localhost:8123/
npm run ex:todo         # todo example → http://localhost:8123/
npm run ex:cards        # slots example → http://localhost:8123/
npm run ex:registration # registration capstone → http://localhost:8123/
```

Each example is served as its own web root: `/app.js` is the freshly built framework, `/templates/` belongs to that example alone.

The registration example is the capstone: a heavier form that puts every recent feature to work at once — checkbox and radio bindings, a checkbox-revealed section, a repeatable list of contacts as per-item single-file components trading props and events with their parent, a submit button gated by `data-disabled-if`, and validation errors painted from a plain array via a method called from an expression. Its schema is validated with [Zod](https://zod.dev) — the framework composes with real libraries; Zod arrives as a plain ES module (`serve.mjs` aliases `/zod.js` to the installed package's own bundle), no bundler involved, and the framework itself stays dependency-free.

# Repository layout

- `packages/app.js` — the framework. TypeScript source in `src/`, tests in `tests/`, build output in `dist/` (generated by `npm run build` and by `npm install`; never committed).
- `packages/examples` — runnable teaching examples (`counter/`, `form/`, `todo/`, `cards/`, `registration/`) plus `serve.mjs`, a dependency-free static server, and smoke tests that drive the built framework over real HTTP.

# Development

```sh
npm run build       # compile packages/app.js/src → packages/app.js/dist
npm run typecheck   # all workspaces
npm test            # framework unit suite + examples smoke suite
```

# Styling component wrappers

A `data-component` element is a real box in layout, which gets in the way inside flex or grid containers. A single-file component can make its own wrapper transparent from its `<style>` — the recommended form, since the transparency then ships with the component:

```css
:scope {
    display: contents;
}
```

For template-only includes (which have no style vocabulary) and for components you don't own, the page-level rule does the same job:

```css
[data-component="widget"] {
    display: contents;
}
```

Two caveats: the wrapper's own background/border/padding stop rendering, and the page-level rule should target specific components — the app stamps `data-component` on its root element (often `<body>`), which must keep its box; the root component's file must not do this either.
