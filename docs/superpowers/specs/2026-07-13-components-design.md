# Design: components as child instances — single-file components, props, events (issue #7)

**Date:** 2026-07-13
**Branch:** `issue-7-components`
**Issues:** implements [#7](https://github.com/mellonis/app.js/issues/7); lifts the per-item-component ban from the #6 design; builds on `destroy()` (#13) and the eval channels (#11/#12)

## Decisions made with the maintainer

| Decision | Choice |
|---|---|
| Component model | **A component is a child instance of the framework class** — state + logic + template = the class we already have; no parallel scope-chain system |
| Class name | **`App` → `Component`** (class only; file, package, repo stay `app.js`; hello-world becomes `import Component from '/app.js'`) |
| Definition location | **Single-file components**: the component's `.html` file holds `<template>` + optional `<script>` |
| Script execution | **ES-module dynamic `import()`** of the script text (see §C for the `data:`-URL transport and why not Blob) |
| Compat discriminator | **No `<script>` → legacy include semantics** (today's behavior, zero breakage); `<script>` present → child component |
| Parent surface | **Events-only bus** — a child's logic gets subscribe access to its parent's events, never a parent object reference |
| Props reactivity | **Re-seed on value change** — parent update passes re-evaluate prop expressions; change is gated on `Object.is` inequality (audit-4: `!==` treats NaN as ever-changing, falsifying convergence) |
| Props vs data | **Separate namespaces** (post-audit maintainer decision): `this.props` is a getters-only, non-extensible reactive store (child writes throw); `this.data` is fully child-owned; a factory key colliding with a prop name rejects that instance's construction (definition cache untouched) |
| Prop subscriptions | **Prop changes are one batched event**: each batch dispatches a single `props` event with a change map (`detail: {todo: {value, previous}, ...}` — changed props only); the child subscribes in `mounted()` (`events.on('props', ...)`) and may update `this.data` — the explicit derived-state escape hatch. Lit-style change records; `props` is the one reserved event name |
| Communication | **Bidirectional events** (prior dossier; transport superseded — dedicated `EventTarget` per instance, NOT wrapper dispatch): child emits up, parent subscribes (declarative `data-component-on-*` sugar — split from DOM `data-on-*`, maintainer decision); parent emits down, child subscribes |
| Lifecycle | **`mounted()` returning optional cleanup** — one hook; the returned function runs at `destroy()` (no separate `destroyed` key) |
| DOM refs | **`data-ref="name"` → `this.refs.name`** — per instance, banned inside `data-for` in v1; `data-show-if` is NOT a conflict (same-element detach/reattach; refs mean identity, visibility is `isConnected`) |
| Refs carry no state wrapper | **Bare elements** — connectedness is the platform's `Node.isConnected`; no snapshot, no wrapper |
| Handler read contract | Changed history → `event.detail`; any current value → `this.props` (live); no deeper history (copy into `data` deliberately) |
| Item recursion | A component whose items instantiate itself is rejected as a cycle in v1 (block-captured ancestor chain), even when data-terminated |

## A. The model

`export default class Component` (renamed from `App`; `AppMethod`/`AppOptions` →
`ComponentMethod`/`ComponentOptions`). One instance = one component: `data` (state) +
`methods` (logic) + template. The root is simply the component the user constructs
with an `element`. Child components are full instances: own ghost, own binding maps,
own list blocks, own `#evaluate` channels, own `AbortController`, own `destroy()`.

Everything that was per-App is now per-component *by construction* — no map
splitting, no scope chains.

## B. Single-file component files

```html
<template>
    <p>${label}: ${count}</p>
    <button data-on-click="increment">+</button>
</template>
<script>
    export default {
        data: () => ({label: 'Count', count: 0}),
        methods: {
            increment() {
                this.data.count += 1;
                this.events.emit('changed', this.data.count);
            },
        },
    };
</script>
```

- `<template>` must be the first child **node** (existing rule — leading whitespace before `<template>` is already an error today; unchanged). `<script>` is optional and
  must be `<template>`'s next *element* sibling — whitespace-only text nodes and
  comments between them are ignored (`</template>\n<script>` is every real file).
  Structural strictness applies only to script-bearing files: when `<script>` is
  present, other stray content is a loud error; files WITHOUT a script keep today's
  tolerance (trailing junk silently ignored) — preserving the zero-breakage claim
  exactly.
- **Parse ownership:** the parent parses the fetched text once to discover the
  script and load the definition; the child's own mount re-parses the same cached
  text for its template (fetch free via the template cache; the duplicate parse is
  accepted — no pre-parsed handoff in v1).
- **`data` is a factory** (`() => ({...})`), not an object — each instance calls it;
  two instances never share state. A non-function `data` in a definition is a loud
  error naming the fix (the classic shared-state lesson, enforced); a THROWING
  `data()` factory rejects that instance's construction (same phase as the
  collision check).
- `methods` is a plain object; methods are bound per instance at construction
  (existing behavior). `ComponentMethod` gains its correct `this: Component` typing
  (closing the note recorded on #7).
- **No `<script>` → the file is a legacy include**: rendered by the parent instance
  exactly as today (shared data/methods, no own scope). All existing templates,
  tests, and examples remain valid unchanged.

## C. Definition loading — `data:`-URL ES modules

The script text becomes a real ES module via dynamic import of a
`data:text/javascript;charset=utf-8,<encodeURIComponent(text)>` URL.

- **Why `data:` and not Blob:** identical module semantics in the browser, but
  `data:` module imports also work in Node — so the vitest suite exercises the real
  import path; Blob URLs would fail under Node and force a test-only seam. No
  `URL.revokeObjectURL` bookkeeping either.
- **Caching:** a static `Map<componentName, Promise<ComponentDefinition>>` beside the
  template cache, same eviction-on-failure semantics (#9). The module — and therefore
  the definition object and its `methods` — is evaluated **once per component type**;
  per-instance state safety comes from the `data` factory. `clearTemplateCache()`
  clears both caches (docs updated).
- Loading is async and joins the existing `#loadComponent` promise chain; `ready`
  settles after all mount-time child components (including their own children) have
  mounted — and one broken child rejects the whole `ready`.
- **Partial mount on child failure (implementation-review amendment, Task 4):** the
  "rejects the whole `ready`" sentence binds the PROMISE, not the DOM. Mounting
  uses settled-results semantics: successfully-mounted subtrees stay live in the
  DOM; the failed child's wrapper remains empty; the failing level's own
  `mounted()` does NOT run (the rejection skips it — diagnostic state, mind it in
  lifecycle reasoning); the surfaced rejection reason is the FIRST failure in DOM
  order (deterministic, an improvement over the racy fail-fast reason). This
  replaces the pre-#7 all-or-nothing include behavior deliberately — partial mount
  is consistent with the framework's loud-but-non-fatal posture (#4, #12); no
  prior test fenced the old suppression.
- **Definitions are immutable:** frozen on load (`Object.freeze`, shallow on the
  definition and `methods`). The host module registry caches `data:` URLs
  permanently — byte-identical scripts under different component names share one
  module namespace and definition object (harmless: the `data` factory isolates
  instance state; methods are copied and bound per instance), and module-level
  script state (`let n = 0` outside the export) is per-URL: shared across identical
  scripts and immortal across `clearTemplateCache()`. Tests may rely on re-*fetch*
  (changed text → new URL → new module), never on re-*evaluation* of unchanged text.
- Failure semantics: a throwing/erroring module import rejects that component's load
  with the original error — surfacing through the parent chain into `ready` (#5).
- **CSP note (documented):** `data:` module imports are blocked by strict CSP, same
  practical class as the expression engine's `unsafe-eval` (#15 does not change the
  script-loading story). Fine for the teaching context; stated honestly in README.
- Definition shape validation: unknown keys are a loud warning; a non-factory `data`
  or non-object `methods` is a loud error and the component's load rejects. The
  legacy-include path applies **only** when `<script>` is entirely absent — a broken
  script is an error, never a silent downgrade.

## D. Instantiation

`data-component="name"` on an element, during the parent's `#renderTemplate`:

1. `loadTemplate(name)` (existing static cache) → parse template + optional script.
2. No script → legacy include (existing recursive `#loadComponent` inside the parent
   instance, unchanged, cycle guard included).
3. Script → load definition (§C) → construct the child:
   - `element`: the `data-component` wrapper element (stamped as today);
   - `data`: `definition.data()` result (child-owned, no prop keys in it — §E);
     `props`: the attribute-derived store, seeded per §E, collision-checked against
     the factory keys (loud rejection);
   - `methods`: from the definition;
   - internal wiring (parent events view, ancestor chain for the cycle guard, props
     re-seed registration) passes through a **private static factory**
     (`static #instantiate(...)`) so the public constructor keeps its current
     four-option surface.
4. The parent records the child instance; **`destroy()` cascades**: destroying a
   component destroys its child components first (post-order), then aborts its own
   controller (#13 semantics per instance).
5. Cycle guard: the #1 per-branch ancestor-name chain carries into child
   instantiation unchanged (`a → b → a` rejected; sibling reuse fine). For
   per-item children see §G (chain captured in the block at extraction).
6. **Directive collisions on the wrapper of a script-bearing component** (audit
   SC-11): `data-value` on the wrapper falls under the #18
   form-controls-only rule — and to keep that airtight, `data-component` on a form
   control (`<select data-component="x">`) is itself a loud setup error (audit-3
   SC-6), enforced **synchronously at `#renderTemplate`, for includes too** —
   universal, because script presence is async knowledge (§G) and a form-control
   wrapper is wrong in every variant. This is the one deliberate dent in the
   zero-breakage claim, confined to a pathological corner (a form control as an
   include wrapper). Wrappers are structural elements; the pre-#18
   textContent-wipe hazard is structurally gone; `data-show-if` on the
   wrapper is allowed and documented — it detaches/reattaches the wrapper with the
   live child inside (identity preserved, same reasoning as refs); `data-display-if`
   on the wrapper is likewise allowed (toggles the child's visibility without
   detaching — E2 row 6 covers both); wrapper
   *content* in the template (`<div data-component="x">${title}</div>`) is
   parent-owned, wired by the parent, and precedes the child's appended content —
   documented as such (content projection/slots stay out of scope, §J).

## E. Props — `data-component-prop-*`

```html
<div data-component="counter"
     data-component-prop-label="'Clicks'"
     data-component-prop-start="$item.count"></div>
```

- Attribute → prop name via the platform's dataset camelCase rule minus the
  `componentProp` prefix: `data-component-prop-start-value` → `startValue`.
- Each prop's value is an **expression evaluated in the parent's scope** — including
  item scope inside `data-for` (per the binding recorded in the #6 spec: `$item`
  et al. do not leak into the child; they are *passed* explicitly here).
- **Props are a separate namespace — `this.props`, not keys in `this.data`**
  (maintainer decision, post-audit): a flat reactive store whose shape is the prop
  attribute names (statically known at wiring). Every key is a leaf by construction
  — object-valued props (`$item`) seed and re-seed trivially, which retires audit
  MUST-FIX 1's special ghost rule. The public `props` object exposes **getters
  only**; the framework re-seeds through a private backing store and triggers the
  child's update pass. A child writing `this.props.x = ...` throws a strict-mode
  `TypeError` — the platform itself enforces "props are inputs, not state" (the
  lesson). In-place mutation of a prop *object* still doesn't re-render (replace-only
  model, documented).
- **Seed:** evaluated at instantiation into the backing store, **committing
  `lastSeeded` at the same moment** (audit-3 SC-3 — otherwise the first parent
  pass after mount sees the gate fail against an uncommitted `lastSeeded` and
  fires a spurious `props` event).
  A throwing seed expression leaves that prop `undefined` with
  `lastSeeded = undefined` — the first later successful evaluation of a
  non-`undefined` value dispatches (an `undefined` result passes the `Object.is`
  gate silently; nothing observably changed). Its key always exists (shape is attribute-derived, no reservation
  hacks needed).
- **Collision is an authoring error — checked per instance, at construction**
  (audit-2 MF-3): a factory `data()` key matching a prop name rejects **that
  instance's construction** (its `ready` rejects; for per-item children the
  built-in catch surfaces it). The **definition cache is untouched** — this is an
  instantiation error, not a load failure; prop shapes are per use site, so another
  site using the same component with different props is unaffected. Expressions see data keys and prop
  keys as bare identifiers (props declared after data in the prologue — order moot
  given the ban, but deterministic).
- **The store is non-extensible** (audit-2 SC-2): `preventExtensions` like the
  ghost — writing an *unknown* key (`this.props.zzz = 5`) also throws in strict
  mode, instead of silently creating a dead pseudo-prop.
- **Two-way form controls cannot bind props** (audit-2 MF-2): a form-control `data-value` (`input`/`textarea`/`select`, #18)
  in a child template whose root identifier is a prop name is a **loud setup error
  at wiring** (prop shapes are statically known) — otherwise the write-back path
  (`this.data.<expr> = ...`) would throw an uncaught `TypeError` per keystroke
  against the non-extensible ghost. Error text teaches the idiom: props are inputs;
  copy into `data` to edit (§E2.1).
- **Pre-`mounted()` re-seeds dispatch to zero listeners by design** (audit-2 SC-3):
  handlers register in `mounted()`; the store always carries the latest value, and
  mount-time code reads `this.props.<name>` directly.
- **Name mapping precision:** the `componentProp` dataset prefix is stripped only
  when followed by an uppercase letter (`data-component-propfoo` is NOT prop `foo` —
  it is ignored with a loud error); an empty prop name is a loud error; a prop name
  that is not a valid, non-reserved JS identifier (`class`, `for`, `new`, …) is a
  loud error and the prop is skipped (audit-2 MF-6: it would otherwise inject
  `var class = ...` into the prologue and brick every expression in the child with
  per-binding `SyntaxError` spam).
- **Re-seed:** the parent registers each prop expression in a dedicated prop-binding
  registry — **keyed by child instance**: `Map<Component, PropBinding[]>` with
  `PropBinding = {propName, expression, scopeRef?, lastSeeded}` (audit-2 SC-6: a
  prop binding has no single element, so the element-keyed shape of
  `#valueElementToDataMap` doesn't transfer; child-keyed lookup makes the eviction
  sweep a single `delete`); per-item prop bindings
  carry the entry's `scopeRef` and **ride the existing `(block, key)` eviction
  sweep** (audit MUST-FIX 4 — without this, evicted items leave dead-scope prop
  bindings erroring every pass). Props evaluate as the **fourth phase** of the
  parent's update pass: lists → visibility → values → props. When a re-evaluated
  value fails `Object.is` equality with the last seeded value (NOT `!==` —
  audit-4 MF-1: `NaN !== NaN`, so a NaN prop would re-dispatch every pass and
  re-enter infinitely through the emit path; `Object.is(NaN, NaN)` is true and
  closes the loop, and the 0/−0 dispatch it admits is harmless), the framework
  writes the backing store; all of a child's changes in one pass ride ONE
  **`props`** event (`detail: {<name>: {value, previous}, ...}`) followed by one
  child update pass. An empty change set short-circuits: no dispatch, no child
  pass. A later child in the same outer phase-4 iteration evaluates against
  then-current parent state; children a re-entrant pass already converged are
  no-ops on resume (the gate compares against the freshly committed `lastSeeded`).
  One-way, live; the child cannot write props at all (getters-only surface).
- **Subscribing to prop changes** (maintainer decision): the child reacts via its
  own emitter — `this.events.on('props', event => { if (event.detail.todo) {
  this.data.x = derive(event.detail.todo.value); } })`, typically from `mounted()`.
  Only re-seeds dispatch; the initial seed does not (read `this.props.<name>`
  directly — `mounted` runs after seeding). Handler data-writes trigger passes
  normally (the #6 no-recursion proof covers this: the write targets the child's
  own maps outside any parent-map iteration). **`props` is the one reserved event
  name** — `events.emit('props', ...)` from user code is a loud error.
- **Re-seed ordering and re-entrancy — BATCHED per child (maintainer decision,
  superseding the per-prop sequence; audit-2 MF-1's commit-before-dispatch
  invariant preserved and strengthened):** in phase 4, for each child: evaluate
  ALL its prop expressions → write the backing store and commit `lastSeeded` for
  every changed prop → dispatch ONE `props` event carrying the change map → run
  ONE child update pass. All commits land before ANY user code runs: a `props`
  handler may emit an event whose parent-side `data-component-on-<event>` method
  writes parent data, triggering a fully re-entrant parent pass mid-iteration —
  with every `lastSeeded` already committed, the re-entrant pass sees converged
  values and re-dispatches nothing (an uncommitted commit would loop infinitely on
  a CONVERGED value). Safety of the re-entrant pass itself: JS `Map` iteration
  tolerates deletions mid-walk (evictions are safe); no synchronous insertions can
  occur (child construction is always at least a microtask behind the definition
  load); and a genuinely divergent prop → emit → parent-data → prop loop is a user
  feedback loop — the same failure class as a side-effecting expression, documented,
  not guarded.
- **Dispatch model: one event, consistent snapshot**: the single `props` event's
  `detail` is a change map —
  `{<name>: {value, previous}}` for changed props only — and every handler
  observes ALL props at their new values. Handlers filter by key:
  `if (event.detail.todo) { ... }`. Multi-prop derivations run once per batch.
- **The read contract inside a handler** (maintainer question, stated so nobody
  derives it): previous values of changed props → `event.detail.<name>.previous`;
  current values of ANY prop (changed or not) → `this.props.<name>` (the store is
  fully committed before dispatch — always the complete new snapshot); previous
  values of unchanged props → `this.props.<name>` (unchanged means current IS
  previous). `detail` is the immutable record of ITS batch; `this.props` is live
  and may already reflect a nested re-seed the handler itself caused (audit-4
  SC-2). The framework retains no deeper history — a handler needing it copies
  into `this.data` (ordinary derived state).
- **Fresh-identity footgun (documented):** a prop expression that constructs a new
  object per evaluation (`data-component-prop-cfg="{a: 1}"`) fails the `Object.is` gate every pass
  and re-dispatches per keystroke — same class as the replace-only model's other
  identity rules; pass stable references or primitives. (NaN is NOT this footgun's
  primitive sibling — the `Object.is` gate converges it.)
- Props on a template-only (legacy include) component: loud setup error — there is no
  child state to seed.
- Prop expressions are guarded per binding; a throwing expression skips that
  prop for the pass, and the error follows the **#12 once-while-broken cadence**
  (phase 4 runs per keystroke — same console-drowning rationale as list errors;
  the per-child registry carries the reported-kinds set).

### E-amendment (implementation review, Task 5): object self-assignment escape hatch

The ghost's object keys gained an identity-checked setter: `data.user = data.user`
(same reference) triggers an update pass — the same sanctioned escape hatch arrays
have had since #6 — while wholesale replacement (`data.user = {...}`) still throws,
now as an explicit loud `TypeError` (stronger than the old silent-in-sloppy-mode
non-writable property). Driven by the props suite's in-place-mutation test;
harmonizes objects with the array leaf rule. Docs follow-through lands in Task 8
(CLAUDE.md reactivity paragraph currently names the escape hatch for arrays only).

## E2. Parent ↔ child data flows — the complete map

Every **framework-provided** channel between a parent and a script-bearing child,
in one table. The guarantee (audit-2 SC-4): no framework channel exists beyond
these. The platform itself adds three the framework neither provides nor blocks,
listed after the non-flows.

| # | Direction | Channel | Trigger | Mechanism | Cleanup |
|---|---|---|---|---|---|
| 1 | ↓ | Prop seed | Instantiation | Parent-scope expressions → props backing store (before `mounted()`) | — (one-shot) |
| 2 | ↓ | Prop re-seed | Parent update pass, phase 4, `Object.is` gate fails vs last seeded | Batched per child: all changed props written + committed → ONE `props` event (change map) → ONE child pass | Prop binding evicted with `(block, key)` sweep / parent destroy |
| 3 | ↓ | Parent broadcast | Parent code calls `events.emit(name, payload)` | Child subscribed via `events.onParent(name, handler)` | Child's signal (dies with child destroy) |
| 4 | ↑ | Child event | Child code calls `events.emit(name, payload)` | Parent's `data-component-on-<event>` method, payload in `event.detail` | Per-wiring controller riding the parent's signal AND the child's OWN signal (fires inside destroy(), after cleanup — final-emit guarantee) |
| 5 | ↓ | Destroy cascade | Parent `destroy()` | Post-order child `destroy()` before parent teardown | — (is the cleanup) |
| 6 | ↓ | Wrapper visibility | Parent `data-show-if`/`data-display-if` on the wrapper | Detach/reattach, or display toggle, of the wrapper with the live child inside (§D.6) | Parent's binding |
| 7 | ↓ | Parent's own prop traffic | Grandparent re-seeds the parent | Child's `events.onParent('props', ...)` observes the parent's framework-dispatched `props` event | Child's signal |

### E2.1 Worked example — prop → data derivation (`todo-editor`)

The two sanctioned prop→data idioms in one component: a **read-copy** in a method
(deliberate snapshot) and a **subscription re-derive** in `mounted()` (stay in sync
with parent replacements).

`/templates/todo-editor.html`:

```html
<template>
    <p data-show-if="!editing">${todo.title} <button data-on-click="startEdit">edit</button></p>
    <form data-show-if="editing" data-on-submit="save">
        <input data-value="draft">
        <button type="submit">save</button>
    </form>
</template>
<script>
    export default {
        data: () => ({editing: false, draft: ''}),
        methods: {
            startEdit() {
                this.data.draft = this.props.todo.title;   // idiom 1: read-copy
                this.data.editing = true;
            },
            save(event) {
                event.preventDefault();
                this.data.editing = false;
                this.events.emit('save', {id: this.props.todo.id, title: this.data.draft});
            },
        },
        mounted() {
            // idiom 2: subscription re-derive — the parent replaced the todo
            // (immutable update) while we were editing; refresh the draft.
            // Cleanup is automatic (child signal); no return value needed.
            this.events.on('props', event => {
                if (event.detail.todo && this.data.editing) {
                    this.data.draft = event.detail.todo.value.title;
                }
            });
        },
    };
</script>
```

Parent usage (inside a `data-for` block):

```html
<li data-for="todos" data-key="$item.id">
    <div data-component="todo-editor"
         data-component-prop-todo="$item"
         data-component-on-save="applySave"></div>
</li>
```

```js
// the parent's methods object
const methods = {
    applySave(event) {
        const {id, title} = event.detail;
        this.data.todos = this.data.todos.map(todo => todo.id === id ? {...todo, title} : todo);
    },
};
```

Flow walk (E2 channel numbers): seed `$item` → `props.todo` (①); *edit* click
copies prop→data explicitly; typing drives `draft` via the child's own two-way
input (child-internal — legal here: the #6 in-item input ban concerns `data-for`
item templates, and the child's template is the child's root); *save* emits up (④);
`applySave` replaces the array immutably; reconciliation reuses the entry (stable
key), re-seed detects the gate failing for `todo` → store write → `props` event with `{todo}` in its change map (②) →
the subscription re-derives `draft`; child re-renders.

**Deliberate non-flows** (each enforced, not just documented): the child cannot
write props (getters-only → `TypeError`); the child cannot see parent `data`,
`methods`, or `refs` (events-only bus — no parent object reference exists); the
parent cannot reach into child `data`/`refs` (no public child handle; the instance
lives behind the wrapper); `$item`/`$index`/`$array` never cross the boundary
except explicitly via prop expressions (#6 rule); the shared definition object is
frozen. Template-only includes are outside this table entirely — they are the
legacy shared-everything model, unchanged.

**Platform channels** (exist regardless of the framework; documented, not
guarded): DOM events bubbling from child-rendered content into parent `data-on-*`
listeners on or above the wrapper (a real ↑ flow — sugar-free and sometimes
useful); the shared DOM tree itself (parent code *can* traverse into
child-rendered nodes — discouraged, undocumented surface); and event payloads
(`emit('x', anything)` can smuggle any reference across — "no parent reference" in
the non-flows means *not provided*, not unforgeable).

## F. Events

Each component owns an **`EventTarget`** — the platform's own emitter, giving
`CustomEvent` payloads and native `{signal}` cleanup (the #13 pattern) for free.
**The emitter is a dedicated `new EventTarget()` instance — NOT the wrapper
element** (audit-3 MF-2; this supersedes the issue-dossier's bubbling-on-wrapper
sketch): component events never enter the DOM tree and never bubble — which is
exactly why a component event named `click` cannot collide with the wrapper's DOM
`click`, and why grandparents cannot overhear a child's events.

Public surface on every instance — `events`:

- `events.emit(name, payload)` → dispatches `CustomEvent(name, {detail: payload})`
  on the component's own target.
- `events.on(name, handler)` → subscribes to the component's own target, auto-bound
  to the instance's abort signal (dies with `destroy()`).

Child ↔ parent wiring:

- **Parent subscribes to child (declarative):** `data-component-on-<event>` on a
  `data-component` element wires the parent's method to the *child's* emitter:
  `<div data-component="todo-item" data-component-on-removed="onRemoved">` →
  `onRemoved(event, item, index)` — payload in `event.detail`, and inside a
  `data-for` block the item/index arrive exactly like every other in-item handler
  (resolved at event time; `undefined` outside blocks). **Split from DOM events
  by attribute family, not by name** (maintainer decision, replacing the audited
  "not in `eventNameList`" rule and its reclassification trap): `data-on-*` means
  DOM events uniformly — on wrappers too (a wrapper click is a click) — and any
  component event name is legal, including `click`. (With #20's wildcard rule,
  `data-on-<event>` binds ANY DOM event verbatim and `eventNameList` is deleted;
  the split is what makes that safe.) Symmetric with `data-component-prop-*`:
  props down, events up, one prefix family.
- **Wiring timing** (audit SC-8): the parent wires child-emitter listeners
  synchronously after the child constructor returns, before awaiting `child.ready` —
  so `mounted()`-time emits are always received, and module-evaluation-time emits
  are impossible (no instance exists yet). No queue.
- **Disposal:** these listeners are subscribed via a per-child-wiring
  `AbortController` whose abort chains to BOTH the parent's signal and the child's
  **own abort signal** — never aborted eagerly at eviction detection (audit-3
  SC-2): the child's signal fires inside `destroy()` AFTER the cleanup phase, so a
  `mounted()` cleanup's final emit is still received by the parent. A destroyed
  child leaves no parent-held listener behind (audit MUST-FIX 4).
- `data-component-on-*` on a **template-only include** (no emitter exists): loud
  setup error, like props on includes. (`data-on-*` on an include wrapper stays a
  plain DOM listener, as anywhere.)
- **`data-component-on-props` is a loud setup error** (audit-4 SC-3): a parent
  declaratively subscribing to the child's framework-dispatched `props` event is
  a misreading of the model (the parent CAUSED those re-seeds); banning it also
  keeps §E's "pre-`mounted()` re-seeds dispatch to zero listeners" literally true.
- **Documented student trap** (audit-3 SC-4, README note): typing
  `data-on-removed` on a component wrapper (instead of `data-component-on-removed`)
  silently binds a DOM event named `removed` that never fires — undetectable at
  wiring, especially under #20's wildcard. The docs teach the rule of thumb:
  component events always ride the `data-component-` prefix family. (#20 lands
  separately; until it does, the trap manifests as a silently IGNORED attribute —
  current `eventNameList` — rather than a silently bound one. Either way: silent.)
- **Child subscribes to parent:** the child's `events.onParent(name, handler)` —
  subscribe-only view of the parent's target, bound to the **child's** signal (a
  destroyed child never leaks a listener into a living parent). `onParent` on the
  root is a loud no-op (`console.error`, nothing registered). **`onParent('props')`
  is legal and intended** (audit-4 MF-2): "reserved" restricts *emitting* only —
  subscription is how framework events are consumed wherever subscription is
  legal; a child may observe its parent's own prop re-seeds (names/values the
  grandparent passes down). Listed in E2.
- Discipline note in docs: props down / events up is the pattern;
  `events.onParent` is the deliberate escape hatch.

## F2. Lifecycle — `mounted()`

A definition may declare `mounted()`. It is bound to the instance and runs when the
component's own subtree mount settles (the moment its `ready` would resolve —
children included). **This is the instance's entry point**: without it, the
events-only-bus decision has no call site — a definition module runs once per type,
and methods only run on events. `events.onParent(...)`, timers, and ref access all
start here.

- `mounted()` may return a **cleanup function**; it runs during `destroy()` — after
  the children cascade, before the listener abort (so cleanup can still emit a final
  event if it must).
- A throwing `mounted()` logs (`console.error`, #4 convention) and does not abort the
  mount; a throwing cleanup logs and does not abort the destroy.
- `mounted` is an **SFC-definition key only** — the public constructor gains no new
  option in v1; root-level code keeps using `ready` (audit MUST-FIX 6: the earlier
  draft claimed both).
- **Destroy-before-mounted** (audit SC-13): a destroyed instance never runs
  `mounted()` (gated on the destroyed flag, like the append gate); a cleanup
  function can only exist if `mounted()` ran. Destroy order: children cascade →
  cleanup → listener abort → map/ref clears.

## F3. DOM refs — `data-ref`

`data-ref="input"` on a template element registers it in the owning instance's
readonly `refs` object: `this.refs.input`, available from `mounted()` onward, cleared
on `destroy()`.

- **Per component instance** — a child SFC's refs never collide with the parent's.
- **Inside `data-for` items: loud setup error in v1** (multiple elements per name is
  its own design — arrays/keyed maps — deferred).
- **`data-show-if` is not a conflict** (maintainer question, resolved): the directive
  detaches and reattaches the *same element instance* via its anchor (the #8
  machinery), so a ref captured at wiring stays correct while the element is hidden;
  what fluctuates is `isConnected`. Same story for refs deeper inside a toggled
  subtree; `data-display-if` never detaches at all.
- **Refs are bare elements — deliberately no connected-state wrapper** (maintainer
  question, resolved): the platform already exposes live connectedness as
  `Node.isConnected`, so `this.refs.input.isConnected` is the supported check
  (documented in README/CLAUDE.md). A snapshot boolean would go stale on the first
  `data-show-if` toggle; a live wrapper would only add `.element` unwrapping to
  reach information the node itself carries — and would teach a framework wrapper
  where a platform primitive exists.
- Duplicate `data-ref` names in one component: loud error, first wins.

## G. Per-item components — lifting the #6 ban

The #6 design banned `data-component` inside `data-for` blocks because components had
no per-item identity. Child instances give them one; the ban is lifted **for
script-bearing components** (template-only includes inside items stay banned — they'd
share root scope, the trap the ban existed for):

- **Enforcement moves** (audit MUST-FIX 2 — script-presence is async knowledge, the
  old ban check is sync): extraction now ADMITS `[data-component]` inside item
  subtrees (`data-for` + `data-component` on the *same element* stays banned at
  extraction, unchanged); the template-only-in-items ban is enforced at
  instantiation time, after the definition fetch resolves, as a loud error **once
  per entry creation** (implementation-review amendment, Task 7: the check runs per
  entry wiring, not per reconcile pass, so the #12 console-drowning hazard cannot
  arise structurally — the observable cadence contract holds: once while
  persisting, re-arms via the fresh-entry-on-re-add path). The entry's wrapper
  renders empty in the meantime and on error.
- **Pending-child lifecycle** (audit MUST-FIX 3): instantiation is async inside a
  sync reconciler. Rules: the wrapper clone inserts immediately and stays empty
  until the child mounts; **eviction calls `destroy()` on a still-pending child**
  (#13's pre-mount gate makes this safe — the load rejects quietly, no DOM ever
  appends); prop seeds are evaluated at construction time with the then-current
  values (latest wins — no buffering of intermediate values); re-adding an evicted
  key creates a **fresh instance** — "reuse for stable keys" applies only to
  entries that survived the pass, never across an eviction.
- **Pre-construction eviction window** (audit-2 MF-5): between entry insertion and
  the definition load resolving there is no instance to destroy — so the
  construction continuation **gates on the parent's destroyed flag AND entry
  liveness** (a generation token on the entry; identity comparison on resolve). On
  mismatch it abandons silently: nothing constructed, no prop bindings registered,
  no listeners wired, nothing appended. Same gate covers a non-item child whose
  parent was destroyed mid-definition-load.
- `#wireItemElement` instantiates the child per item entry; prop expressions evaluate
  in that item's scope (`data-component-prop-todo="$item"`).
- The entry's registry records the child instance; **eviction destroys it**
  (cascade), covering the child's own listeners, bindings, and children — and the
  *parent-side* artifacts are released with it: the entry's prop bindings via the
  `(block, key)` sweep (§E); the `data-component-on-<event>` listeners via the
  child's OWN signal per §F — never eagerly at eviction detection, preserving the
  cleanup final-emit guarantee.
- Keyed reconciliation reuses child instances for stable keys (re-seed handles item
  object replacement); a moved entry moves the child's DOM without reconstruction.
- **Cycle guard for late children** (audit MUST-FIX 5): the #1 ancestor chain is a
  call-stack parameter that no longer exists when a later pass creates an entry —
  so `ForBlock` **captures the chain at extraction** and per-item instantiation
  threads it. Deliberate v1 consequence, stated as a decision: recursion through
  items (a component whose items instantiate itself — tree views) is rejected as a
  cycle even when data-terminated; documented limitation, revisit on demand.
- **Late children have no awaiting surface** (parent `ready` has long settled; the
  reconciler is sync): their `mounted()` runs when their own load settles; failures
  surface through the instance's built-in `ready` catch. Tests use the
  `vi.waitFor` settling idiom for every per-item assertion.
- The todo example gets its payoff: `todo-item` becomes a real component with
  `data-component-prop-todo="$item"` and `removed`/`toggled` events — and the
  long-deferred `display: contents` styling demonstration finally lands with it
  (per-item component wrappers inside the list layout).

## H. Rename mechanics

- `src/app.ts`: `export default class Component`; `AppOptions` → `ComponentOptions`,
  `AppMethod` → `ComponentMethod` (with `this: Component`). File and package names
  unchanged; `import Component from '/app.js'` everywhere (examples, docs, tests).
- The `ready` rejection message is reworded to `The component was destroyed`
  (const renamed to match; the destroy test updated accordingly).
- No alias export: in-repo consumers only; one name, one lesson.
- **Enumerated rename targets** (audit SC-14 — "mechanical" is honest only
  enumerated): `src/app.ts` (class, both type renames, destroyed-message const +
  text); all framework test files + `tests/helpers.ts` (imports,
  `clearTemplateCache` call site); the destroy test's message assertion; the three
  example `index.html` files (`import App` → `import Component`, `new App` →
  `new Component`); `README.md` overview lines; `CLAUDE.md` architecture section
  (the "Everything is the `App` class" paragraph and the destroy quote); `app.d.ts`
  regenerates via build (never hand-edited). One beyond-mechanical claim to verify,
  not assume: `this: Component` on `ComponentMethod` must not break existing method
  literals (none currently use `this` in a way that narrows — verify in the plan's
  typecheck step).

## I. Testing

Framework unit suite additions (`tests/components.test.ts` grows, plus new
`tests/sfc.test.ts`):

- SFC parsing: template-only → legacy semantics (existing tests keep passing
  untouched — the compat proof); script → child instance; malformed files, non-factory
  `data`, broken module code → loud errors; definition cache hit/eviction-on-failure.
- Props: kebab→camel mapping (incl. reserved-identifier and prefix-boundary
  errors), parent-scope evaluation (incl. `$item`), re-seed on change only (`Object.is`
  gate proven by spy — including the NaN-converges case; `lastSeeded` committed
  before dispatch — the converged-value loop regression test), per-instance collision rejection (definition cache proven
  untouched by a second use site), input-on-prop wiring error, throwing prop expressions logging once while
  persisting and re-arming after a clean pass (#12 cadence).
- Events: emit up with `detail`; `data-component-on-<event>` sugar wiring; `data-component-on-click` and
  `data-on-click` coexisting on one wrapper and firing independently (the split
  test — no shadowing rule exists post-split); `onParent` down; both directions die with the correct side's
  `destroy()` (child destroyed → parent emitter has no leak; parent destroyed →
  cascade); root `onParent` no-op error.
- Lifecycle: `mounted()` timing (after own subtree, incl. nested children), binding
  (`this` = instance), cleanup-function execution order within `destroy()`, throwing
  hook/cleanup isolation.
- Refs: registration, availability in `mounted()`, per-instance isolation,
  `data-show-if` toggling keeps the ref valid (identity assertion across
  hide/show), duplicate-name error, `data-for` ban, cleared on destroy.
- Cascade: `destroy()` post-order through nested components; `ready` settles only
  after nested children mount; cycle guard through child instantiation — including
  the LATE-pass case (recursion-through-items rejected via the block-captured
  chain on a later reconcile, not just at mount).
- Loud-error sweep: form-control wrapper ban (include and SFC variants);
  `data-component-on-props`; `data-component-on-*` and props on template-only
  includes; empty prop name; unknown-key write on the non-extensible store
  (`this.props.zzz = 5` throws); definition-shape errors (non-object `methods`,
  unknown-key warning, frozen definition); throwing `data()` factory rejects
  construction; throwing-seed recovery (no dispatch on a later `undefined`
  evaluation; dispatch on the first non-`undefined`).
- Pre-construction windows: eviction mid-definition-load abandons silently
  (generation token — nothing constructed, no bindings registered, no errors on
  later passes); parent destroyed mid-definition-load likewise; destroy-before-
  mounted never runs `mounted()` and cleanup never exists.
- Per-item: instance per entry, reuse on stable key (surviving entries only),
  eviction destroys — including a **still-pending** child (no DOM ever appends, no
  errors accumulate across later passes); item-scope props re-seed on item
  replacement; prop bindings and parent-side custom listeners evicted with the
  entry (asserted behaviorally: post-eviction passes are error-free and
  listener-free); template-only-in-items errors at instantiation with #12 cadence;
  fresh-instance-on-re-add.
- Prop subscriptions: the `props` event dispatches on re-seed only (not on seed),
  `detail` = change map with `{value, previous}` per changed prop (unchanged props
  absent); a `mounted()`-registered handler deriving data re-renders; the
  reserved-name emit error; handler cleanup via the child signal; **batching**:
  two props changed in one parent pass → ONE event whose detail carries both, the
  handler observes the full new snapshot, and the child runs exactly ONE update
  pass (pass-count spy).
- Props namespace: `this.props` getters-only (child write → `TypeError`, asserted);
  object-valued props (`$item`) seed and re-seed through the backing store (the
  audit's MUST-FIX 1 scenario, now structural); data/prop collision rejects that
  instance's construction loudly; expressions resolve both namespaces as bare identifiers; in-place
  prop-object mutation does not re-render (documented behavior, asserted).
- Wrapper collisions: `data-value` on a script-bearing wrapper is a loud error;
  `data-show-if` on the wrapper toggles the live child by identity.
- Node-side `data:`-import proof: the unit suite itself exercises the real dynamic
  import path (no mocking of the module loader).

Smoke: todo example rewritten around the `todo-item` component (real `data:` module
import over real HTTP through happy-dom) — this is also the risk probe for
happy-dom's dynamic-import support; **risk register:** if happy-dom cannot import
`data:` modules, the smoke test pins the todo example to the unit-tested behavior
via its rendered output only, and the limitation is documented (unit suite still
covers the import path in Node).

## J. Out of scope

- Slot/children content projection; `emits` declarations/validation; computed/watch;
  any #15 interaction (the expression engine is unchanged); publishing; repo rename.

## Success criteria

1. Existing suites pass with only mechanical rename edits (the compat proof for
   template-only includes).
2. A `counter` SFC with its own state mounts twice on one page with independent
   counts (the #1 → #7 arc completed: reuse + own state).
3. Todo example: `todo-item` component with props + events, per-item instances
   destroyed on removal (observable: no listener/binding leaks, asserted
   behaviorally), `display: contents` demo present.
4. `ready` reflects the full nested mount; `destroy()` cascade verified.
5. CI green; no new dependencies; framework runtime dependencies still none.
