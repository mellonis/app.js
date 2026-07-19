# Internals — how the framework actually works

This is the map for reading the source. The framework is five files under
`packages/app.js/src/` — and five ideas.

| File | What lives there |
|---|---|
| `app.ts` | The engine: bindings, the dependency graph, the flush, list reconciliation, and the component lifecycle. One class, connected through `#private` fields, deliberately kept whole. |
| `expression.ts` | The expression language — tokenizer, parser, evaluator. Self-contained. |
| `ghost.ts` | The reactive store. Reaches the engine through two hooks it is handed, `record` and `notify`, and knows nothing else about it. |
| `definition.ts` | How a component file becomes a definition, plus the three type-level caches (template text, parsed definition, injected `<style>`). |
| `support.ts` | Types, message strings, and pure helpers shared by the above. |

Each section below names the idea, the reason it exists, and where to read it.
The git history is the long-form version: the engine grew feature by feature,
and every stage still runs if you check it out.

## 1. The ghost — state that notices reads and writes

Your `data` object is wrapped in a "ghost": every key becomes a getter/setter
pair over the original value, and every plain-object value recurses into a
nested ghost. Each getter knows its full dot path from the root
(`user.address.city`). Arrays and primitives are leaves — you update them by
replacement, and `data.todos = data.todos` (self-assignment of the SAME
reference) is the sanctioned way to say "I mutated this in place, re-render".
Ghosts are non-extensible: the shape of your state is fixed the moment the
component constructs, which is why dynamic collections belong in replaceable
arrays, not in objects that grow keys.

Writes pass a gate first: assigning an equal primitive (or `null` over `null`)
does nothing at all — no notification, no render. Equal object, array, or
function references pass through deliberately: same-reference assignment IS the
in-place-mutation signal. Read the gate in `createGhost` (ghost.ts) — it is
three lines, and most of reactivity's efficiency lives in them.

The store reaches the rest of the framework through exactly two operations it
is handed at construction: `record(path)` when a getter fires, `notify(path)`
when a write clears the gate. That is the entire contract, which is why the
file can be read start to finish without knowing anything about the DOM.

## 2. The dependency graph — who re-renders, and why

Every binding — a `${}` text hole, a directive, a list block, a component
prop — evaluates inside a **tracking frame**. While the frame is open, every
ghost getter that fires records its path; when the evaluation finishes (even
by throwing — partially collected reads still count), the recorded set becomes
that binding's subscriptions, replacing whatever it read last time. That
re-collection is what keeps `flag ? a : b` honest: the untaken branch's path
is dropped the moment `flag` flips.

A write that clears the gate notifies the subscribers of its exact path and of
every registered descendant path (`user = user` wakes `user.address.city`) —
never ancestors, because nothing above the written path changed identity. A
binding that read nothing tracked — a pure literal, an expression that threw
before its first read — subscribes to nothing and renders exactly once,
forever. Methods called at event time run with no frame open, so a handler
peeking at state subscribes nothing.

Read `#trackEvaluation`, `#record`, `#resubscribe`, and `#notify` together
(app.ts, the tracking section) — the whole graph is four small functions and
two maps.

## 3. The flush — batching, ordering, and the loop that gives up loudly

Notified bindings do not re-render immediately. They land in a dirty set, and
the first write in a tick schedules one microtask flush — minting that flush's
`updated()` promise at the same moment, so `await app.updated()` after any
number of same-tick writes means "the DOM has settled". The store itself is
synchronous: reading `data.x` right after writing it always shows the new
value; only the DOM work batches.

The flush drains the dirty set in a fixed phase order — list blocks first
(structure before content), then visibility, display, disabled, values, text,
and finally component prop re-seeds — and loops while a phase leaves new dirty
bindings behind (a handler run during the drain may write more state). A
binding that keeps dirtying itself — a formatter that writes what it reads —
would loop forever; after 64 iterations the drain stops and logs an error
naming that exact mistake. That error replacing a stack overflow is the whole
design in miniature: fail loudly, teach the cause, keep the page alive.

Two-way inputs get one subtlety: the drain skips writing any form control
whose current state already equals what it would write. During typing that is
precisely the input you are typing into — its caret survives — and a derived
write (a normalizer producing a different value) still lands.

Read `#scheduleFlush` and `#drain` (app.ts) — the scheduler is one function,
and swapping it is how the engine moved from synchronous to batched.

## 4. List reconciliation — keys, the sweep, and the guards that stay

`data-for` replaces its element with a pair of anchor comments and reconciles
clones between them, keyed by your `data-key` expression: existing entries are
reused and moved, missing ones are removed, new ones are wired. Item bindings
(`$item`, `$index`, `$array`) are never path-tracked — items are raw values
behind the array leaf — so every reconcile marks every surviving entry's
bindings dirty unconditionally. That unconditional marking is the only channel
through which `data.todos = data.todos` after an in-place item edit reaches
the DOM, which is why it is not an optimization opportunity.

The sweep iterates a snapshot and re-checks each entry's liveness, and the
stitching loop re-checks that each entry still belongs to the block before
inserting. Under the batched flush, handlers can no longer re-enter a
reconcile mid-sweep — those guards defend a path that mostly cannot happen
anymore. They stay anyway, as cheap insurance with the history to justify it:
before batching, cleanup events emitted during eviction could mutate the list
mid-sweep, and the guards were the fix. Read `#reconcileTrackedBlock` and
`#reconcileBlockWith` (app.ts).

## 5. The expression language — a real parser instead of eval

Directive and interpolation expressions run through a hand-written pipeline in
`expression.ts`: a tokenizer (strings, numbers, operators, the enumerated
escape set), a Pratt parser (one method per precedence level, from `|>` at the
loosest to member access at the tightest), and a tree-walking evaluator. No
`eval`, no `Function` — the todo example has a page that disables both and
still runs.

The language is a deliberate subset of JavaScript. Everything ambiguous is a
parse error with a message that teaches (`a |> b ? c : d` asks for
parentheses; `==` tells you to write `===`; `in` and `instanceof` say they are
not part of this language), and everything dangerous is unreachable
(`constructor`, `__proto__`, and `prototype` are blocked on every access
path). Identifiers resolve through one fixed chain — item scope, then props,
then data, then methods, then a small whitelist of globals — and a miss names
the whole chain in its error. Compiled expressions are cached by source text
forever: parsing is pure, so the cache never invalidates.

Write-back (`data-value`) accepts only a static dot path and assigns through
the ghost's own setters, so a typed character flows: input event → path
assignment → gate → notification → flush → every OTHER subscriber of that
path updates. Read `compile` and the parser class top to bottom — it is the
best single file in the repository to study.

## 6. Components — child instances, not scopes

A component file whose `<template>` is followed by a `<script>` mounts as a
full child instance: its own ghost, its own graph, its own flush, its own
`destroy()`. The script becomes a real ES module via a `data:` URL import,
evaluated once per component type and cached; per-instance state comes from
the `data` factory. Props are a separate getters-only store seeded and
re-seeded by the parent (one batched `props` event per change set); events
ride a dedicated per-instance `EventTarget` — never the DOM, never bubbling.
Template-only files stay simple includes sharing the parent's scope: adding a
`<script>` is the act that gives a component its own brain.

Definition loading also carries CSS: a `<style>` sibling in the file lands on
the cached definition, and the first instance of the type injects one
`@scope`-wrapped `<style>` element into `document.head`. Injection is
type-level, like the caches themselves — `clearTemplateCache()` evicts the
injected elements, `destroy()` leaves them alone.

Read `#mountChildOrInclude`, `#instantiate`, and `#reseedChild` (app.ts) with
the components section of the README beside them.

## Reading order

1. `expression.ts` end to end — self-contained, zero framework knowledge
   needed.
2. `ghost.ts` end to end — also self-contained; it is idea 1 whole, and short.
3. app.ts's tracking section (idea 2), then the flush (idea 3), then
   `data-for` (idea 4). The banner comments mark each one.
4. `definition.ts` when you want the SFC file format — it stands alone and can
   be read at any point.
5. Components (idea 6) last — they compose everything above.
6. Then the git history from the first commit: every subsystem landed as a
   reviewed chapter, and the engine you just read replaced a simpler one you
   can still run.
