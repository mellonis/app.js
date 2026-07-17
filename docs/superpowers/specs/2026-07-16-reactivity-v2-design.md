# Design: reactivity v2 — path-tracked dependencies, microtask batching (issue #17)

**Date:** 2026-07-16
**Branch:** `issue-17-reactivity-v2`
**Issues:** implements [#17](https://github.com/mellonis/app.js/issues/17); builds on #15's resolver (the collection seam) and demotes the #22/#23 re-entrancy machinery to defense-in-depth

## Decisions made with the maintainer

| Decision | Choice |
|---|---|
| Engine mode | **Replace outright** — one engine on master; the coarse re-run-everything pass dies; git history is the chapter-1 archive |
| Substrate | **Homegrown subscriber maps** — per-path subscriber sets inside the engine, a tracking-frame stack around evaluation; no TC39 reimplementation, naming may nod to signals vocabulary where honest |
| Granularity | **Per nested path** (maintainer choice over the per-root recommendation) — bindings subscribe to the exact ghost paths they read (`user.name`), roots included; paths exist only along ghost chains (arrays/primitives terminate a path) |
| Batching | **Microtask flush** (maintainer choice over the synchronous recommendation) — non-suppressed writes mark dirty and queue one flush; the ghost STORE stays synchronous (reads-after-write unchanged); evaluation AND DOM work batch |
| Flush awaitable | **`app.updated(): Promise<void>`** — the one public API addition; resolves after the pending flush (immediately when idle); per instance |
| Notification algebra | A write to path P notifies subscribers of **P and P's descendants** (`P.*`) — never ancestors (identity above P did not change) |
| Re-entrancy | **Same-flush drain loop** with an iteration cap and a loud feedback-loop error — a teaching upgrade over today's stack overflow |

## A. The model

Every binding (show-if, display-if, value, text-interpolation, `data-for` block,
per-prop binding) becomes a **tracked subscriber**:

- **Paths.** Each ghost knows its prefix (threaded at `createGhost`: the root ghost
  is `''`; the nested ghost for `user` stamps `user`; its `name` getter records
  `user.name`). Prop stores stamp a `props:` tier prefix (`props:todo`) — the two
  namespaces never collide even before the construction-time collision ban.
  Arrays and primitives are leaves: `todos.length` tracks only the root `todos`
  read (the `.length` read is a plain property on the raw array — untracked, and
  correctly so: replacement is the only sanctioned array update).
- **Tracking frames.** Evaluation of one binding pushes a frame (a `Set<string>`);
  every ghost/prop getter fired while the frame is active adds its path; the frame
  pops with the binding's fresh dependency set — **in `finally`**, and a THROW
  mid-evaluation adopts the partial set collected before the throw (audit MF-1:
  `broken ? boomFn() : name` collects `{broken}` before failing, so the cadence
  contracts keep re-arming; "keep the old set" would orphan every mount-throwing
  binding). **Liveness invariant** (round-2 SC-1): a binding stays live iff each
  evaluation reads at least one tracked path before completing or throwing —
  guards must be tracked reads; a branch selected by an untracked source is
  unsupported under per-path tracking (throwing or not), except inside `data-for`
  items where dirty-on-reconcile neutralizes the freeze. Frames are per-component
  and
  stack-shaped (a prop re-seed evaluating in the parent while a child collects is
  impossible — collection is always synchronous within one component's evaluation
  — but the stack keeps composition honest and cheap). Methods called at EVENT
  time run with no frame → event-handler reads never subscribe anything.
- **Re-collection.** Every re-evaluation replaces the binding's subscriptions:
  unsubscribe the old set, subscribe the fresh one (dynamic dependencies —
  `flag ? a : b` — converge naturally). Arrow closures evaluate within the same
  synchronous evaluation (filter/map/pipes), so their reads land in the right
  frame; an arrow smuggled out and called later runs frameless (documented).
- **Registry.** Per component: `#subscribersByPath: Map<string, Set<TrackedBinding>>`
  plus each binding's own `dependencies: Set<string>` for cleanup. Eviction paths
  (list entries, child components, destroy) remove bindings from the registry —
  the existing eviction sweeps gain one unsubscribe call each.

## B. The write path

A ghost/prop setter for path P: store the value synchronously (reads-after-write
keep today's semantics), compute the dirty set = subscribers of P plus subscribers
of every registered path prefixed `P.` (descendants — this is what makes the
self-assignment escape hatches work: `data.user = data.user` means "something
inside changed", so `user.*` subscribers wake), mark those bindings dirty, and
schedule the flush if none is pending. **Never ancestors:** a `user.name` write
does not wake a binding that only read `user`'s identity.

**Worked example — arbitrary depth (maintainer question, resolved):**
`user.address.ip.address` tracks end-to-end when the initial data has that shape:
every level is a ghost with a stamped prefix, the leaf setter notifies exactly
`user.address.ip.address` subscribers (one text node wakes; every other `user.*`
binding sleeps — per-path's best case), the mid-chain hatch
(`data.user.address = data.user.address`) wakes the leaf via descendant
notification, and `data-value` write-back walks the same chain. Depth boundary:
ghost shapes are fixed at construction, so an object assigned into an
initially-null key is raw — tracking stops at the deepest ghosted ancestor and
the self-assign hatch there is the wake-up signal for everything below
(consistent with the existing null-leaf rule).

The `Object.is` gate on prop re-seeds stays; ghost setters gain the same gate
with a **code-shaped discriminator** (audit MF-4 + round-2 MF-C — arrays,
objects-in-null-keys, AND functions share the leaf-setter branch with numbers,
and `typeof null === 'object'`):

```
suppress iff Object.is(old, value)
         && (value === null || (typeof value !== 'object' && typeof value !== 'function'))
```

Equal OBJECT, ARRAY, or FUNCTION references are hatches by definition — notify P
plus descendants (functions keep today's any-set-triggers behavior); double-null
writes suppress (null has no interior — no hatch semantics). Checked against the
runtime value at write time, never the construction-time shape. The enumerated
flip stays: **equal-value primitive (and null) writes no longer cause DOM
work**.

## C. The flush

One pending flush per component, scheduled with `queueMicrotask`:

1. Drain loop over the dirty set until clean: **lists first** (dirty `ForBlock`s
   reconcile — structure before content, as today), then visibility, values, text,
   prop bindings — the existing pass order preserved within the dirty subset.
   Writes landed DURING the flush (a cleanup emit's handler, a `props` handler
   deriving data) just mark dirty and are drained in the same flush — **the
   mid-sweep re-entrant reconcile of the #22/#23 era is structurally gone**
   (handlers no longer re-enter `#reconcileBlock` synchronously mid-sweep; the
   generation guard and snapshot sweep REMAIN as defense-in-depth, documented as
   demoted).
   **Propagation walk (maintainer question, resolved):** the graph is flat
   (paths → bindings) but cascades propagate through writes: `data.todos = […]`
   dirties the list block → the flush reconciles it → per-item prop bindings
   re-evaluate and re-seed child stores → each child's writes queue the CHILD's
   flush (next microtask) → child DOM renders. Same-component derived writes
   (a `props` handler writing `this.data`) drain within the same flush. And the
   graph self-heals as it drains: every re-evaluation re-collects, so
   `flag ? a : b` swaps its subscription from `a` to `b` the moment `flag`
   flips — after any flush the graph reflects what expressions actually read
   last, never what they once read.
2. **Drain cap:** a pathological write-in-flush feedback loop (binding A's
   evaluation side-effects a write that dirties A) hits an iteration cap (64) and
   logs a loud teaching error naming the loop — replacing today's failure mode for
   the same bug (synchronous stack overflow).
3. **Write-back sources:** the input listener enrolls its element in a pending-
   sources set **only after a successful `assign` and only when a flush is
   actually pending** (round-2 MF-D: a gate-suppressed write — retyping the same
   character — schedules nothing, and a throwing assign updates nothing; either
   would strand the entry and make the NEXT programmatic write skip the rewrite,
   the exact disagreement this machinery prevents; no-enrollment-on-throw also
   reproduces today's `finally`-clear semantics, letting a later pass revert the
   input to data). Each enrolled source is **consumed at its first values-phase
   visit** — later drain iterations rewrite it normally (audit SC-6:
   flush-end clearing would let a mid-flush derived write to the input's own
   path leave input and data disagreeing until the next keystroke). Several
   inputs can write before one flush — hence a set, not a slot. Premise, stated
   (round-2 SC-2): user input events are TASKS — they cannot land mid-flush;
   the only mid-flush writers are the drain's own handlers.

   **§C.3 amendment (implementation review, final round):** the pending-sources
   mechanism (enrollment + first-visit consumption) is REPLACED by a value-equality
   write skip in the values phase: the DOM write is skipped when the element's
   current value already equals the evaluated string. This preserves the
   caret-safety purpose exactly (during typing, data equals the input's value by
   definition), closes both discovered strand scenarios (same-tick programmatic
   write; suppressed write with an unrelated pending flush), and deletes the
   enrollment bookkeeping wholesale — a strict simplification found when the
   second strand surfaced in the final review.
4. **`updated()` — the pinned state machine** (audit MF-3): the promise is
   created AT SCHEDULE TIME (the first dirtying write), so a same-tick
   `updated()` call after a write always returns the pending promise, never a
   stale resolved one. It resolves after the final drain iteration; the pending
   slot clears BEFORE resolution, so a write inside `updated().then` mints a new
   flush and a new promise; a handler calling `updated()` MID-DRAIN gets the
   current flush's promise (the slot is still occupied until after the final
   iteration). **Destroy with a flush pending resolves the
   already-issued promise** (no deadlocked awaiters), and the queued microtask
   gates on the destroyed flag exactly like today's pass. Idle and destroyed
   calls return a resolved promise. `updated()` covers THIS component's drain
   only — child flushes are their own microtasks (§E), deliberately not
   awaited; cross-tree settlement is a test concern served by the helper below.
5. **Test helper:** `tests/helpers.ts` gains `settle(app)` — `await
   app.updated()` then one MACROTASK yield (the existing `flush()` helper's
   `setTimeout 0` — all queued microtasks, at any chain depth, complete before
   the next task; audit SC-5 showed the two-consecutive-idle-checks idea
   under-waits chains deeper than two).

## D. Lists under tracking

- A `ForBlock` subscribes to its list expression's dependency set (collected like
  any binding). A dirty block reconciles with the existing keyed algorithm.
- **Item bindings** subscribe to whatever paths their expressions read (data/prop
  roots and nested paths). `$item`/`$index`/`$array` reads are NOT path-tracked
  (items are raw values behind the array leaf). Instead: **every reconcile marks
  every surviving entry's bindings dirty** — unconditionally, not just on
  item-identity change. This is load-bearing three ways: the array self-assign
  hatch (`data.todos = data.todos`) means "same reference, mutated contents", so
  skipping same-identity entries would break the hatch's whole purpose; `$array`
  and `$index` reads stay correct across neighbor changes; and the isolation win
  survives intact where it matters — a write to any path the LIST doesn't depend
  on never reconciles the block and never touches item bindings (the coarse
  engine re-evaluated every item on every keystroke; now items re-evaluate only
  when their block actually reconciled). "Every surviving entry's bindings"
  enumerates: text interpolations, show-if, display-if, AND the entry's per-item
  prop bindings (audit SC-7 — `data-component-prop-todo="$item"` collects an
  EMPTY set, so dirty-on-reconcile is its only re-seed trigger). Enumerated
  flip: **item expressions no longer re-evaluate on unrelated writes** — only on
  reconciles of their own block.
- **Key expressions run frameless** (they are per-item computations, not
  subscriptions) and reconcile holds no frame except around the list expression
  itself. Consequence, documented (audit SC-8): a key like `prefix + $item.id`
  no longer re-keys when `prefix` changes until the block reconciles for another
  reason — keys must derive from the item.
- Eviction unsubscribes the entry's bindings (one call in the existing sweep);
  child components under entries are untouched (their own registries die with
  `destroy()`).

## E. Components and props under batching

- The parent's flush evaluates dirty prop bindings per child, builds the change
  map behind the existing `Object.is` gates, writes the child's backing store,
  dispatches the ONE batched `props` event, and the child's own flush (queued by
  the child-store writes) renders the child DOM on its own microtask. The
  batched-event contract is unchanged; only the child's DOM timing shifts one
  microtask later than the parent's.
- `props` event handlers writing `this.data` dirty the child's own paths — same
  flush (child's) drains them; the audit-era commit-before-dispatch invariant
  keeps its proof shape (store writes and `lastSeeded` commits happen before
  dispatch, within the parent's flush).
- `mounted()`, `ready`, events, `destroy()` semantics are untouched. The initial
  mount renders synchronously as today (wiring evaluates each binding once — that
  IS the collection pass); **first paint needs no flush**, so `await ready` +
  synchronous DOM assertions keep working — `ready` must NEVER await flushes
  (audit SC-11: re-entangling it would undo the per-item-children decision).
  Writes inside `mounted()` queue a flush that FIFO-runs before the `ready`
  continuation. Per-item child seeding in the definition-load continuation is
  covered by evaluation-scoped frames — no special casing.
- `#writeBackSource`'s entry-consumption discipline transfers to the pending-
  sources set (§C.3) — consumed by the flush that covers the write, exception-safe
  clearing preserved.

## F. Public API delta

Exactly one addition: **`updated(): Promise<void>`** on every component instance.
Everything else — `data.count = 1`, templates, directives, events, props — is
unchanged. The README headline: writes batch into one render per microtask; await
`app.updated()` when you need the DOM settled (tests, imperative reads).

## G. Compatibility contract

The suite is the oracle, with FOUR enumerated flip classes (values never change;
timing and work-count do):

1. **DOM-after-write assertions** gain `await app.updated()` (or the `settle`
   helper) — mechanical, wide (most directive/list/interpolation/props/component
   tests). Data-after-write assertions need nothing (stores are synchronous).
   Two non-mechanical edges (audit SC-9/SC-10): a component METHOD that writes
   then imperatively reads the DOM (`refs.para.isConnected`) must itself
   `await this.updated()` — the refs-plus-methods idiom is where users will
   actually meet batching, taught in README; and same-tick write sequences
   collapse — intermediate list states never render, so transient entries'
   mount/cleanup side effects (a child's final emit for an item that existed
   for zero rendered frames) no longer fire.
2. **Equal-value writes no longer render** (the new `Object.is` gate on primitive
   setters): any test relying on a same-value write to force a pass switches to
   the self-assignment hatch or a real change (audit the suite for these — the
   error-cadence re-arm tests use distinct values already; enumerate any that
   don't).
3. **Zero-dependency bindings freeze after mount** (audit MF-2):
   a binding that reads NO tracked path — a pure expression (`'static'`,
   `0 / 0`), a method-only call, or an expression that throws before any read
   (`${oops()}`) — collects an empty set and never re-evaluates. Pure
   expressions rendering once is correct and teachable. The sharp edge is
   errors: **a resolve-throwing binding logs once at mount and never retries**
   (today it re-logs per pass) — a deliberate error-visibility change,
   enumerated; the cadence contracts survive because their expressions read a
   tracked guard first (partial adoption, §A). The corpus passes either way —
   which is exactly why this class is stated here rather than left to tests.
4. **Unrelated-write isolation:** tests that asserted a binding re-evaluated on an
   unrelated key's write (the coarse model's signature) flip meaning — the
   evicted-items tests ("stop being toggled, without errors" via unrelated `other`
   writes) still pass (no evaluation = no error = the assertion holds), but any
   test COUNTING evaluations of untouched bindings must be re-read. The `#12`
   error-cadence contracts survive: a persisting list error re-logs per RECONCILE
   of that block, and re-arms after ITS clean pass — cadence is per-block, not
   per-global-pass, which the existing tests already express.

Docs: the CLAUDE.md reactivity paragraph's "there is no dependency tracking; all
bindings re-evaluate on any change" identity sentence is replaced by the tracked
model (paths, batching, `updated()`, the drain cap); README gains the batching
paragraph; the O(everything) chapter lives in git history (stated in CLAUDE.md's
teaching note).

## H. Performance note (the payoff, stated honestly)

Keystroke into an input bound to `draft`: today = full pass over every binding and
every list block; after = the `draft` subscribers only (typically one text node),
zero list reconciles. The todo example's per-keystroke work drops from O(bindings)
to O(1). No benchmarks in scope; the teaching claim is the mechanism, not numbers.

## I. Testing

- New `tests/reactivity.test.ts`: path collection (root, nested, `props:` tier,
  dynamic `flag ? a : b` re-collection); PARTIAL adoption on throw (the
  guard-first pattern re-arms); zero-dependency freeze (pure binding renders
  once; a resolve-throw logs once and freezes); descendant notification
  (self-assign hatches wake `user.*` — including equal OBJECT/ARRAY references
  passing the gate discriminator; `user.name` write does NOT wake identity-only
  readers); no-ancestor rule; equal-value PRIMITIVE suppression; batching (two
  writes → one flush → one DOM update — `MutationObserver` counts DOM writes,
  verified viable in happy-dom, AND a formatter-method spy counts evaluations
  for the §H claim); `updated()` state machine (idle; same-tick-after-write
  returns pending; write-inside-then mints new; destroy-with-pending resolves);
  drain-cap loud error on a feedback loop; write-back sources (two inputs, one
  flush, neither re-written; first-visit consumption — a mid-flush derived
  write to the input's path DOES rewrite it); event-time reads subscribe
  nothing.
- List tracking: unrelated-key write reconciles nothing (spy on a key
  expression); ANY reconcile of a block dirties ALL surviving entries' bindings
  (unconditional — the §D rule; includes the array self-assign hatch driving an
  in-place item-content update end to end); a per-item prop binding with an
  empty dependency set re-seeds via the hatch → the child receives new props
  (round-2 SC-4); a key expression `prefix + $item.id` does NOT re-key on a
  `prefix` write until its block reconciles otherwise (the documented §D
  consequence); eviction unsubscribes (behavioral: post-eviction writes to the
  read paths produce no errors and no work).
- Components: parent flush → child flush ordering (`settle` helper); batched
  `props` event unchanged; commit-before-dispatch preserved under flush.
- Suite migration: flips 1–3 are the mechanical sweep (awaits, distinct values,
  isolation re-reads); flip 4 is enumeration-only (no migration — its corpus
  tests pass either way); every migrated test keeps its assertion VALUES.
- Smoke: all four pages green with `await`-based settling in the harness where
  needed; the no-eval page still proves its claim.

## J. Out of scope

Computed values, watchers, effects as public API; TC39 `Signal` alignment;
per-path granularity below ghost chains (array element paths); cross-component
`updated()` aggregation; microtask-vs-raf scheduling options; removing the #22/#23
guards (demoted, not deleted); benchmarks.

## K. Plan phasing recommendation

One issue, one branch, one plan — staged in TWO phases (round-2 audit, sized
against the #7/#15 precedents): **Phase A** lands tracking, per-path dirtying,
and the notification algebra behind a SYNCHRONOUS flush (drain runs immediately
at write time) — the suite stays nearly green (only flips 2/3 land, both
narrow), proving the graph before the timing changes; **Phase B** switches the
scheduler to `queueMicrotask`, adds `updated()`/`settle`, and runs the wide
flip-1 sweep as per-file migration tasks. The seam is real (the scheduler is one
function boundary) and each phase gates independently.

## Success criteria

1. The keystroke scenario (§H) provably evaluates only the `draft` subscribers
   (spy-counted) — the headline lesson.
2. Suite green after the enumerated mechanical migration; assertion values
   untouched; 43 expression tests and the no-eval smoke untouched entirely.
3. `updated()` is the only public-surface diff (README/CLAUDE.md updated).
4. The drain cap converts a synthetic feedback loop into one loud teaching error.
5. No new dependencies; both source files stay pure of each other's concerns
   (tracking lives in `app.ts`'s engine, not in `expression.ts`).
