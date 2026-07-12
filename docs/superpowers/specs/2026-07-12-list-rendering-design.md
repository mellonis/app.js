# Design: list rendering — `data-for` with keyed reconciliation (issue #6)

**Date:** 2026-07-12
**Branch:** `issue-6-list-rendering`
**Issues:** implements [#6](https://github.com/mellonis/app.js/issues/6); todo example deferred from #10 lands here

## Decisions made with the maintainer

| Decision | Choice |
|---|---|
| Architecture | **Keyed reconciliation in v1** — `data-key` exists from day one; DOM nodes are reused/moved/removed by key, so item state survives updates |
| Key contract | **`data-key` required** on every `data-for` element; missing key → `console.error`, list doesn't render; duplicate key in one render → `console.error`, first occurrence wins, duplicates skipped |
| Array reactivity | **Replace-only, immutable style** — arrays are leaf values in the ghost (getter/setter, no recursion); `data.todos = [...data.todos, item]` triggers updates; `push()` deliberately doesn't (documented) |
| Handlers in items | **`method(event, item, index)`** — `data-on-*` handlers on elements inside a repeated block receive the item and index as extra arguments, resolved at event time (never stale) |
| Item scope naming | **No microsyntax** — `data-for` takes a bare expression like every other directive; the framework provides `$item`, `$index`, and `$array` (the evaluated list for this pass) inside the block |

## A. Directive syntax and template semantics

```html
<ul>
    <li data-for="todos" data-key="$item.id">
        <span data-value="$item.title"></span>
        <button data-on-click="removeTodo">x</button>
    </li>
</ul>
```

- `data-for="<expression>"` — a bare JS expression over data keys, like every other
  directive (no `"x in xs"` microsyntax; the framework's attribute language stays
  uniform). Inside the block, expressions additionally see `$item`, `$index` (the
  item's index in the source array), and `$array` (the evaluated list for this
  render pass — possibly a filtered copy, not necessarily the raw data property).
- **Extraction order (load-bearing):** `#renderTemplate` processes `[data-for]`
  FIRST — before the `data-show-if`/`data-value`/`data-on-*`/`data-component`
  sweeps — replacing each block element with its anchor pair and detaching the
  template element from the fragment. Block subtrees are therefore invisible to
  root wiring (otherwise in-item bindings register scopeless: error spam on every
  pass, and a root-wired `data-show-if` inside the detached template would corrupt
  the clone source by swapping template children for anchors). This holds on error
  paths too: every `data-for` error below still removes the element and leaves an
  empty block between anchors — an errored element must never remain for the sweeps.
- At extraction, the template subtree is checked with `querySelectorAll` for
  `[data-component]` and `[data-for]` — either found → `console.error`, block
  renders empty (this is how the nesting/per-item-component bans are enforced).
- Directives on the `data-for` element itself: `data-value`/`data-on-*` are wired
  per clone in item scope; `data-for` and `data-key` attributes are stripped from
  clones.
- **In-item `<input data-value>` is a setup error in v1** (`console.error` at clone
  wiring, binding skipped; non-input `data-value` is fully supported). Rationale:
  the write-back path is deliberately rooted at `this.data` (the #2 fix), which has
  no `$item`; and even scope-rooted write-back would mutate the raw item in place —
  firing no setter, updating nothing, and violating the replace-only array model.
  Documented v1 limitation: there is no idiom for editable per-item fields yet
  (`eventNameList` has no `input` event either); that arrives with a future
  explicit-mutation design, not as a side effect here.
- The `data-for` element itself is the per-item template. At setup, `#renderTemplate`
  replaces it with a **start/end anchor comment pair** marking the block's position;
  clones of the template element are inserted between the anchors.
- `data-key` evaluates in item scope; its result is coerced with `String()`.
- Disallowed combinations in v1 (each a `console.error`, directive skipped):
  `data-for` + `data-component` or `data-show-if` on the same element; `data-for`
  nested inside another `data-for`. (`data-show-if` / `data-value` / `data-on-*`
  on elements *inside* the item template are fully supported and evaluate in item
  scope.) Nested `data-for` and per-item components are follow-ups (#7 territory —
  per-component scopes).

  Rationale for banning same-element `data-show-if` + `data-for`: the combination
  is ambiguous (per-item filter vs whole-block conditional — the same precedence
  confusion that led Vue to ban `v-if`+`v-for` in its style guide and reverse the
  precedence between Vue 2 and 3), and both directives want to replace the element
  with anchor comments, compounding the reconciler's trickiest bookkeeping. Both
  intents have first-class idioms instead:
  - whole-list conditional → `data-show-if` on the wrapper:
    `<ul data-show-if="todos.length"><li data-for="todos" ...>`
  - per-item filtering → filter in the expression (expressions are full JS):
    `data-for="todos.filter(t => !t.done)"`

## B. Ghost change (array support)

In `#createGhost`, check `Array.isArray(value)` **before** the object-recursion
branch: arrays become leaf getter/setter properties exactly like primitives — no
recursion, no index tracking, no more `Object.keys`-flattening corruption. Assigning
a new array triggers the standard update pass. This is ~5 lines and also applies to
arrays nested inside object ghosts.

## C. Item scope and expression evaluation

`#evaluate` gains an optional `scope` parameter (`Record<string, unknown>`). The
scope is exposed to evaluated code through a **`#private` field on the instance** —
`this.#evaluationScope` — set before the `eval` and cleared (to `undefined`) in a
`finally` afterwards so item references aren't retained. Generated code declares
data keys first, then scope keys — so the framework-provided names shadow same-named
data keys inside items (a `data: {$index: ...}` key would be shadowed there;
`$`-prefixed data keys are legal but discouraged):

```
var todos = this.data['todos'];              // data keys, as today
var $item = this.#evaluationScope['$item'];  // item scope, declared after → shadows
var $index = this.#evaluationScope['$index'];
var $array = this.#evaluationScope['$array'];
```

Why a `#private` field and not a parameter, WeakMap, or Symbol (maintainer question,
resolved by probe): evaluated code can only reach a WeakMap/Symbol/parameter through
an *identifier*, and any identifier can be shadowed by a same-named data key
(`var` hoisting defeats reordering). The single unshadowable root is the keyword
`this`, and private names are lexically visible inside direct `eval` — verified
empirically on Node 24 in module (strict) mode, including with deliberately shadowed
`Symbol`/`scope` identifiers. Nothing userland writes in a template or data object
can name, shadow, or reach `#evaluationScope`. The same pattern is the prescribed
fix for the pre-existing write-back shadowing bug ([#11](https://github.com/mellonis/app.js/issues/11):
emit `this.data.<expr> = this.#evaluationElement` instead of the shadowable
`element` parameter) — #11 stays out of scope here, but the mechanism lands with
this branch, making that fix a two-liner later.

Every binding inside an item (`data-value`, `data-show-if`, `data-key` itself)
evaluates with that item's scope — e.g. `data-show-if="$index === $array.length - 1"`
marks the last item. `$array` is expression-only; handler signatures stay
`(event, item, index)`.

## D. The reconciler (`#updateLists`)

Per `data-for` block, the framework keeps a registry:
`blockRegistry: { anchorStart, anchorEnd, templateElement, listExpression,
keyExpression, array, entries: Map<key, {element, item, index}> }` — `array` is the
list evaluated by the most recent `#updateLists` pass; it is the single source for
`$array` when `#updateVisibility`/`#updateValues` later resolve item scopes (never
re-evaluate the list expression outside `#updateLists`: filtered expressions return
fresh identities and impure ones would diverge).

On every update pass (and at first render), for each block:

1. Evaluate the list expression (guarded by the #4-style per-binding `try/catch` —
   a throwing expression logs and skips this block, the pass continues). Non-array
   result → `console.error`, block renders empty. The reconciler must NOT
   short-circuit on array identity: `data.todos = data.todos` (self-assignment
   after an in-place mutation) is the sanctioned escape hatch and performs a full
   reconcile. Docs recommend copy-based expressions (`[...todos].sort(...)`,
   `toSorted`) since `data-for="todos.sort(...)"` would mutate the raw data array
   through the ghost getter's escaped reference.
2. For each item, evaluate `data-key` in item scope → `String()` key. A throwing
   key expression → `console.error`, that item skipped, pass continues. Duplicate →
   `console.error`, first wins, duplicate item skipped. "First" means first in the
   NEW array's order, decided independently on every pass — deterministic across
   passes; the existing DOM entry for the key is reused by the first occurrence.
   Error cadence: the registry keeps a `reportedDuplicateKeys` set — a duplicate
   logs when it first appears, stays silent while it persists (reconciliation runs
   per keystroke; one broken key must not drown the console), leaves the set when
   it renders clean, and logs again if it re-breaks. `$index` in scope is always
   the item's SOURCE-array index (skipped items leave rendered gaps but don't
   renumber). Semantics to document (no runtime detection): `data-key="$index"`
   type-checks but silently degrades keying to positional reuse — the classic
   antipattern, warned against in docs; `String()` collisions (`1` vs `'1'`,
   objects → `'[object Object]'`) surface via the duplicate error; a key that
   changes for the same logical item is a remove-plus-create (DOM state lost —
   expected).
3. Reconcile against `entries`:
   - **New key** → clone the template element, wire its nested directives
     (`data-value`, `data-show-if`, `data-on-*`) with the item scope, register
     those bindings tagged with (block, key), insert.
   - **Existing key** → reuse the DOM element; update the entry's `item`/`index`.
   - **Removed key** → remove the element from the DOM and **evict every nested
     binding registered under (block, key)** from the binding maps — no stale
     updates, no leaks.
4. Order pass (exact algorithm): a cursor starts at `anchorStart.nextSibling`; for
   each element in desired order, if it IS the cursor, advance the cursor; else
   `insertBefore(element, cursor)` via `anchorEnd.parentNode`. Correct, O(n) moves,
   no LIS optimization (deliberate teaching simplification), and works while the
   block is still inside the `DocumentFragment` at first render.
5. Reused elements' nested bindings re-evaluate on the normal `#updateValues` /
   `#updateVisibility` passes, which now resolve each binding's scope through its
   block entry — so after an immutable update replaces the item object, bindings
   read the **new** item.

Update-pass order becomes: `#updateLists()` → `#updateVisibility()` →
`#updateValues()` (lists first, so newly created bindings join the same pass).

## E. Event handlers inside items

Listeners are attached once, at element creation. At event time the handler is
invoked as `method(event, item, index)` where `item`/`index` are read from the
block entry **at dispatch time** — reordering or replacing the array never leaves
a handler with a stale item. Elements outside any block keep today's
`method(event)` signature (`AppMethod` type widens to
`(event: Event, item?: unknown, index?: number) => void`).

## F. Public surface

Unchanged: everything new is `#private` (`#updateLists`, the block registry, scope
plumbing). `app.d.ts` changes only in the `AppMethod` signature widening.

## G. Todo example (`packages/examples/todo/`)

Per the plan recorded on #6: own `templates/root.html` + `index.html`, served by
`node serve.mjs todo`, root script `ex:todo`, smoke test at
`packages/examples/tests/todo.smoke.test.ts` (port 8233).

- Template: add-form (`<form data-on-submit="addTodo">` + `<input data-value="draft">`),
  `<li data-for="todos" data-key="$item.id">` containing two mutually
  exclusive title spans (`<span data-show-if="!$item.done" data-value="$item.title">`
  and `<s data-show-if="$item.done" data-value="$item.title">` — the done state renders
  struck through, demonstrating per-item `data-show-if`), a toggle button
  (`data-on-click="toggleTodo"`), a remove button (`data-on-click="removeTodo"`),
  and an empty-state `<p data-show-if="todos.length === 0">`.
- Methods use immutable updates exclusively: `addTodo` (`[...todos, {id, title, done}]`,
  id from a counter in data), `toggleTodo`/`removeTodo` (`map`/`filter` by `item.id`
  using the `(event, item)` signature).
- `style.css` for basic looks. **Correction to the #6 comment:** the
  `display: contents` demonstration assumed per-item *components*, which v1
  explicitly disallows inside `data-for` — that demo moves to the #7 (props)
  example work. The todo app's stylesheet stays ordinary.
- Smoke test: add two todos, toggle one, remove one, assert rendered list and
  empty-state behavior end-to-end over real HTTP.

## H. Tests (framework package)

New `tests/lists.test.ts` (+ a ghost case in `tests/ghost.test.ts`):

- Ghost: array value is readable, replaceable (triggers update), not recursed into;
  `null`-in-array and nested-array-in-object cases don't crash.
- Setup errors: missing `data-key`, forbidden combinations, nested `data-for`,
  non-array expression result — each logs and skips without killing the mount.
- Render: initial list renders in order; append/prepend/remove/reorder via array
  replacement produce correct order **and preserve DOM node identity for stable
  keys** (asserted by holding element references across updates).
- Duplicate keys: first occurrence (in new-array order) renders, duplicate skipped;
  the error logs exactly once while the duplicate persists across passes, and logs
  again after a clean pass re-breaks it.
- Item bindings: `data-value="$item.title"` updates after item replacement;
  `data-show-if` inside items toggles per-item; `$index` and `$array` usable in
  expressions (e.g. last-item detection via `$index === $array.length - 1`).
- Handlers: `(event, item, index)` correct at dispatch, **including after a reorder**
  (the stale-closure trap test); handlers outside blocks unchanged.
- Eviction: after removing an item, subsequent updates don't touch its detached
  element (behavioral stale-binding check).
- Audit-derived guards: a clean mount + update of a list with in-item bindings
  produces ZERO `console.error` calls (catches scopeless double-wiring); template
  integrity — an item containing `data-show-if` on an initially-falsy root
  expression, then toggle + append: the new clone must still contain the element
  (catches clone-source corruption); `<input data-value="$item.x">` inside an item
  is a loud setup error, and typing into an OUT-of-block input while a list is
  mounted stays error-free; self-assignment (`data.todos = data.todos`) after an
  in-place `push` reconciles and renders the pushed item.

`it.fails` convention: none needed — no known bugs ship with this design.

## I. Forward compatibility with #7 (component props/scopes)

Sequencing decision (maintainer): #6 lands before #7. Two integration points are
deliberately shaped for #7's later per-component-scope work:

- `#evaluate(expression, scope)`'s `scope` parameter is a plain object merged over
  data keys. #7 generalizes this into a scope *chain* (component props → parent →
  root data) that resolves to exactly such an object at each evaluation site — the
  call sites added by #6 will not change.
- The `data-for` block registry is keyed alongside the binding maps. When #7 splits
  the root-global maps into per-component ownership, block registries move with
  them mechanically — no reconciler logic changes.
- Scope visibility across component boundaries (binding for #7): `$item`/`$index`/
  `$array` are available at any DOM depth *within* the item template, but do **not**
  leak implicitly into a nested `data-component`. Prop expressions on the component
  element evaluate in the enclosing item scope, so the item is passed explicitly:
  `<div data-component="todo-item" data-component-prop-todo="$item">` — the
  component sees its declared props only, nothing ambient.

## J. Out of scope

- Nested `data-for`, per-item `data-component` (needs #7 scopes), inline handler
  expressions, LIS-optimal move minimization, array mutation tracking
  (`push`/`splice` interception), `data-key`-less fallbacks.

## Success criteria

1. `npm test` green: existing 29 unit + new list suite + 3 smoke (counter, form, todo).
2. Todo example: `npm install && npm run ex:todo` → working app; add/toggle/remove
   all function with immutable updates.
3. Node-identity preservation proven by unit test (reorder keeps elements for stable keys).
4. All setup errors are loud (`console.error`) and non-fatal to the mount.
5. CI green on the branch.
