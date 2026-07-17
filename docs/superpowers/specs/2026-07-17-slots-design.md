# Design: content projection — `<slot>` for components (issue #21)

**Date:** 2026-07-17
**Branch:** `issue-21-slots`
**Substrate:** the wrapper-content rule from the components design (parent-owned
bindings inside a script-bearing wrapper) — projection is a placement mechanic
over it, not a scope change.

## Decisions made with the maintainer

| Decision | Choice |
|---|---|
| Vocabulary | **Default + NAMED slots in v1** (maintainer choice over the default-only recommendation): `<slot>` and `<slot name="x">` in the child template; **`data-slot="x"`** attributes on the wrapper's top-level elements route them (maintainer decision — see the naming rule below); unassigned content goes to the default slot |
| Fallback | **Yes, child-scoped**: a slot's own children render (wired by the CHILD, child scope) only when nothing was projected into it; replaced entirely otherwise — mixed ownership is the documented lesson |
| Per-item projection | **Deferred** — a slot-bearing component given wrapper content inside a `data-for` item is a loud once-per-entry error |
| Naming rule | **Persistent attributes are always `data-*`** — `data-slot` routes projection because the attribute stays in the live DOM forever, and squatting the platform's `slot` attribute would teach Shadow DOM vocabulary with non-Shadow semantics; the `<slot>` ELEMENT keeps its natural name because distribution consumes it at mount — it never reaches the rendered DOM |
| Migration rule | **childNodes, wholesale** — anchors and comments travel with their content (the established discipline, one level deeper) |
| Slot mobility | The slot region may sit inside the CHILD's own dynamic structures (`data-show-if`/`data-display-if` wrappers) — parent bindings are reference-based and location-independent; a slot inside the child's own `data-for` block is a loud wiring error (cloning would need projected nodes in N places) |

## A. Distribution (audit-amended: all five mechanics pinned)

1. **The combo ban (audit MF-1, probe-verified):** `data-slot` may not share an
   element with `data-show-if` or `data-for` — a loud error at PARENT wiring,
   checked BEFORE `data-for` extraction (extraction destroys the evidence:
   probes showed anchors carry no routing and `data-for` clones KEEP
   `data-slot`, tearing a block across two slots; the include-early-drain
   window makes hidden-behind-anchor named content reachable in real
   templates). On error the `data-slot` is ignored and the content routes to
   the default bucket. Precedented ban (the same-element `data-for` rules);
   the remedy is a wrapper: `<div data-slot="x"><span data-show-if=…>` — the
   anchor swap then happens INSIDE the routed subtree, which §B blesses.
   `data-display-if`/`data-disabled-if` on a `data-slot` element stay legal
   (no anchors).
2. **The distribution point (audit MF-2):** distribution runs in
   `#loadComponent`'s continuation — AFTER the destroyed gate (a child
   destroyed mid-fetch must not swallow live parent DOM into a dropped
   fragment; destroy's leave-DOM-in-place contract), BEFORE the child fragment
   appends (wrapper childNodes collected there are purely parent content, no
   filtering needed). Parent flushes during the fetch window are safe for the
   default bucket by the childNodes rule; named routing is safe by the ban.
3. **Routing:** each top-level meaningful node with `data-slot="name"` → the
   `name` bucket; everything else — elements without it, text, comments,
   directive anchors — → the default bucket, order preserved. `data-slot`
   below the top level is inert; an EMPTY `data-slot=""` is a loud error;
   `data-slot` on a `data-component` wrapper element is legal (wrappers
   persist); duplicate names across siblings share a bucket in order.
4. **Slots are recorded at CHILD wiring, never queried at distribution**
   (audit MF-4): the slot scan is the FIRST sweep of the child's
   `#renderTemplate` — before its own `data-for` extraction (a `<slot>`
   inside the child's block errors loudly via `closest('[data-for]')` and is
   removed from the block template) — and each `<slot>`'s name, position, and
   FALLBACK childNodes (extracted UNWIRED into a held fragment, the
   `#extractForBlock` discipline) go into a slot record. Distribution
   consumes the record, so a slot detached behind a child-side anchor at
   distribution time still fills correctly (`replaceWith` works inside the
   detached subtree — §B's mobility rule holds BECAUSE of the record).
   Duplicate names (including two defaults) error from the record.
5. **Fallback is decide-then-wire** (audit MF-3 — there is no unwire-subtree
   machinery, and wire-then-discard would run doomed SFC lifecycles): filled
   bucket → the never-wired fallback fragment is dropped (nothing fetched,
   nothing evicted); empty bucket → the fallback wires THEN (child scope) and
   its nested component mounts fold into the chain `ready` awaits.
   Consequence, pinned: the child's `#markAllBindingsDirty()` + first drain
   MOVE from `#renderTemplate` into the `#loadComponent` continuation, after
   distribution — lazily wired fallback joins the first collection pass;
   both mount paths share the move.
6. **Loud errors** (all naming the component and the slot): duplicate slot
   names; `data-slot="name"` with no matching `<slot name>`; **default-bucket
   MEANINGFUL content with no default `<slot>`** (audit MF-5 — otherwise it
   vanishes silently); wrapper content on a slotless template — the retired
   precede-and-mix, fired at distribution, once, content REMOVED (leaving it
   would BE the retired behavior plus noise; nothing paints mid-limbo at
   initial mount, so no flash trade-off); directives on the `<slot>` element
   itself ("wrap the slot region"); a nested `<slot>` inside another slot's
   fallback (an outer fill would silently delete the inner target); `<slot>`
   in the ROOT component's template (no parent to project from); wrapper
   content on ANY `data-component` inside a parent `data-for` item — one
   unconditional parent-side error in item wiring (simpler than splitting on
   slot-bearingness, which is async knowledge).
   **Meaningful content** mirrors the SFC-file rule: whitespace-only text and
   comments are ignorable — a formatted-but-empty wrapper is NOT content, and
   whitespace alone never triggers the missing-default-slot error.

## B. Why migration is safe (the two maintainer probes, resolved)

- **Projected content with `data-show-if`/`data-for` inside it:** bindings key
  on element/text references and the path registry — never on DOM position. A
  visible element moves and later swaps with its anchor wherever it lives; a
  HIDDEN element's anchor comment travels because distribution moves
  childNodes, not children (the anchor-comments-must-travel discipline); a
  `data-for`'s anchor pair plus its current entries move as a contiguous run
  and reconcile relative to `anchorEnd.parentNode` — the slot's parent.
- **The slot region inside child dynamics:** after distribution, projected
  nodes are ordinary members of the child's subtree. A child `data-show-if`
  around the region detaches/reattaches them with its wrapper; parent flushes
  keep updating the detached nodes by reference (the established detached-
  content behavior); reattachment shows current state. This holds even when
  the slot is DETACHED at distribution time (behind a child-side anchor, e.g.
  via the child's own include-early-drain) — because distribution consumes
  the wiring-time slot record, not a DOM query (§A.4).

## C. Ownership and lifecycle

- Projected content keeps PARENT scope forever: its expressions resolve through
  the parent's chain, its bindings live in the parent's registries, its
  handlers call parent methods. Fallback content is CHILD-scoped. Stated in
  docs as the ownership rule: "who wrote the markup owns its bindings."
- Child `destroy()` leaves DOM in place as always — projected nodes included.
  Ancestor evictions sweep parent bindings via the existing `boundElements`
  machinery, projected or not.
- `updated()`/tracking are untouched: distribution moves nodes once at mount
  and never again; no binding re-wires.
- Docs notes (audit): `data-ref` in projected content works by reference (a
  parent ref can point into another component's subtree — stated); a
  component nested in projected content hears its MARKUP parent via
  `events.onParent`, not the slot host — ownership follows who wrote the
  markup, consistently.

## D. Testing

New `tests/slots.test.ts`: default projection (text + elements + order,
duplicate names sharing a bucket); named routing (`data-slot="x"` top-level;
nested `data-slot` inert; `data-slot` on a nested `data-component` wrapper);
fallback renders when empty; a FILLED bucket's fallback is never wired
(proven: a fallback SFC's template fetch never happens); parent-scope proof
(projected `${}` reads parent data; a parent write updates projected content
inside the child — through `settle`); the hidden-at-migration case for
DEFAULT-bucket content (a projected `data-show-if` element hidden before the
child mounts, shown after — inside a `data-slot` WRAPPER for the named case);
a projected `data-for` reconciling inside a slot (via a routed wrapper); the
slot-region-under-child-show-if detach/reattach cycle INCLUDING
slot-detached-at-distribution (an include sibling forces the early drain);
every §A.6 loud error (combo ban, empty `data-slot`, duplicate slots,
unmatched name, missing default slot, slotless wrapper content with removal
asserted, slot-in-child-data-for, nested-slot-in-fallback, root-template
slot, directives-on-slot, the unconditional in-item error);
whitespace-only wrapper content is NOT an error; the include-with-content
regression (template-only includes keep today's semantics). Example: the todo example's `todo-item`
gains a small named-slot demonstration only if it reads naturally — otherwise
a minimal `card` usage in the registration page's summary; keep the showcase
scope small.

## E. Out of scope

Per-item projection; `data-slot` forwarding through nested components;
dynamic slot names; re-distribution after mount (content assigned once);
`<slot>` in template-only includes (they remain plain shared-scope markup —
a slot there is just an element).

## Success criteria

1. All §D tests green; existing 227 + 6 untouched except the enumerated
   retirement (the no-slots wrapper-content error replaces silent preceding —
   audit the suite for tests relying on the old mix; enumerate any flip).
2. Docs: CLAUDE.md components paragraph + README components section gain the
   projection rules (ownership sentence included); forge-free prose.
3. The hidden-at-migration test passes — the childNodes discipline proven at
   the slot boundary.
