# Design: per-component styles — `<style>` in the component file (issue #31)

**Date:** 2026-07-17
**Branch:** `issue-31-component-styles`
**Substrate:** the single-file-component definition loader (`#parseDefinition`) —
a third top-level element joins `<template>` and `<script>`; scoping rides the
platform's `@scope` at-rule, not a CSS rewriter.

## Decisions made with the maintainer

| Decision | Choice |
|---|---|
| Scoping mechanism | **`@scope` wrapper** (over Vue-style selector rewriting and over global injection): the file's CSS injects into `document.head` wrapped in an `@scope` rule whose root is the component's wrapper — zero CSS parsing, zero runtime deps, teaches a baseline modern-CSS feature |
| Scope depth | **Boundary at nested components** (maintainer choice over the no-boundary recommendation): a parent's rules stop at nested SFC instances, Vue-like. Cost accepted: a stamped marker attribute on SFC instance roots, and projected slot content inside a child is geometrically beyond the parent's boundary — scoped styles follow GEOMETRY, not ownership (the documented trade-off) |
| Template-only includes | **Loud error** — styles are a component-identity feature like props/events/slots; an include has no scope of its own. File rule: `<template>` first, then optionally one `<script>` and one `<style>` |
| Sequencing | Ships before #29 (the module split then moves the finished loader wholesale) |

## A. The file contract

1. `<template>` remains the required first child. After it, the meaningful
   siblings may be **at most one `<script>` and at most one `<style>`, in
   either order**. Anything else — a second script, a second style, a stray
   element — is the existing loud error, its message updated to name all
   three parts.
2. A `<style>` sibling **without** a `<script>` sibling is a loud error naming
   the rule (template-only includes keep no style vocabulary). Other stray
   content in template-only files stays silently tolerated exactly as today —
   the new check fires on `<style>` presence only.
3. The style's `textContent` is captured into the cached `ComponentDefinition`
   (a `css?: string` field). Whitespace-only CSS is treated as absent.
   Implementation note (audit): the field attaches AFTER the unknown-keys
   sweep and BEFORE the definition freeze, and `css` stays OUT of the
   definition-keys whitelist — a user writing `css:` in the script export
   still gets the unknown-key warning (styles come from `<style>`, never the
   script).
4. **The root component's template never passes through the definition
   parser** (audit Important): it loads via `loadTemplate` →
   `#renderTemplate`, which reads only the `<template>`'s content — so a
   `<style>` sibling in the ROOT's file would be silently inert.
   `#renderTemplate` therefore scans for a `<style>` sibling and errors
   loudly when it finds one, naming the rule (root styles belong to the host
   page's stylesheet). Implementation-review correction: SFC children ALSO
   re-read their raw style-bearing file through `#renderTemplate`, so the
   scan is gated on the instance having no parent (the root alone has none);
   includes are separately gated at `#parseDefinition`.

## B. Injection — once per type, into `document.head`

1. At the FIRST instantiation of a type whose definition carries CSS, inject
   one `<style data-component-style="<name>">` element into `document.head`
   containing:

   ```css
   @scope ([data-component="<name>"]) to (:scope [data-component-root] > *) {
       /* the file's CSS, verbatim */
   }
   ```

   (Audit-amended limit, verified in Chromium 149: the earlier
   `[data-component-root]:not(:scope) > *` shape let a wrapper that sits as
   a DIRECT CHILD of another stamped element match the scope-end and become
   its own scoping limit — empty scope, no styles; the TR's in-scope
   definition makes the root an inclusive descendant of itself and scope-end
   selectors with `:scope` match non-relatively. The descendant combinator
   pins boundaries to strict descendants of the scoping root, which is
   immune to both the TR and editor's-draft wordings.)

   The scoping root is the type-level wrapper attribute already persisted in
   the live DOM; every instance of the type is its own scoping root
   automatically.
2. **Dedup:** a static registry (name → injected element) alongside the
   definition cache. Second and later instances inject nothing.
3. **Eviction:** `clearTemplateCache()` removes every injected style element
   and clears the registry (test hermeticity — it already clears both caches).
   `destroy()` does NOT touch injected styles: they are type-level, like the
   caches themselves.
4. The component name is interpolated into ONE attribute selector — the
   scoping root; the audit-amended limit is name-free — and the injection
   escapes backslash then quote characters in the interpolated value (cheap
   honesty, no `CSS.escape` dependency question). The element's own
   `data-component-style` attribute is written through the DOM and needs no
   escaping.

## C. The boundary — stamping and geometry

1. **`data-component-root`** is stamped in the CONSTRUCTOR, beside the
   existing `data-component` stamp — one site covers every SFC child (they
   construct through `#instantiate` → `new Component`) and the root mount
   alike, and it lands before mount, so boundaries exist before any child
   renders (audit simplification). Template-only include wrappers are NOT
   stamped — the include path never constructs a Component, so the rule is
   structural, not a check. The ROOT element's stamp is declarative-only:
   under the §B.1 limit, `:scope [data-component-root]` matches only strict
   descendants of a scoping root, and the mount element is an ancestor of
   every scope — it can never act as a boundary. Naming follows the slots
   rule: persistent attributes are always `data-*`, and this one persists in
   the live DOM.
2. `data-component` stamping on the instance's own element ALREADY exists —
   every construction writes it, root included (`element.dataset['component']
   = this.componentName`), which is what the README's styling-wrappers caveat
   describes. The only NEW stamp this feature adds is `data-component-root`.
3. The lower boundary `to (:scope [data-component-root] > *)` reads: scope
   ends at the DIRECT CHILDREN of any SFC wrapper found STRICTLY BELOW the
   scoping root (their subtrees fall out of scope — the `> *` shape keeps
   the bound inclusive of the wrapper element itself), while the nested
   wrapper ELEMENT stays styleable — the parent wrote that wrapper, so the
   parent styles it (ownership-consistent at the seam). The leading
   `:scope ` descendant step is load-bearing: it exempts the donor's own
   wrapper no matter where the donor sits, including as a direct child of
   another stamped element (see §B.1).
4. **Geometry, not ownership — the documented trade-off:** projected slot
   content relocates inside the child's subtree, so the PARENT's scoped rules
   no longer reach it; the CHILD's scoped rules do (its subtree, before any
   deeper boundary) — automatic where Vue needs `::slotted`. Stated in docs
   with exactly that contrast.
5. **Proximity lesson stays true inside one scope:** bare declarations placed
   directly inside `@scope` apply to the scoping root itself per the CSS
   spec — worth one docs sentence, verified in audit (see F).
6. **The `display: contents` idiom moves in-file (maintainer probe,
   resolved):** `@scope` is tree-based, so a layout-transparent wrapper
   scopes exactly like a boxed one — the README's page-level idiom keeps
   working unchanged. But a component can now own it: `:scope { display:
   contents; }` in the file's own `<style>` styles the wrapper itself (each
   instance's scoping root), making wrapper transparency self-contained.
   Docs recommend the in-file form for SFCs; the page-level rule remains the
   tool for template-only includes (no style vocabulary) and for styling
   components you don't own. The root caveat is unchanged: the root
   component's file must not do this — its element keeps its box.

## D. Errors (all loud, naming the component)

- `<style>` in a template-only file (§A.2).
- More than one `<style>`, or any sibling that is neither `<script>` nor
  `<style>` (§A.1 — the existing error, message extended).
- `<style>` in the ROOT component's own template file (§A.4 — the
  `#renderTemplate` sibling scan).
- No new runtime errors: an empty/whitespace `<style>` is simply absent CSS;
  malformed CSS is the browser's business (it fails inside `@scope` exactly
  as it would anywhere — the framework never parses it). Verbatim-CSS
  at-rule behavior is a DOCS line, not a check (audit-verified in-engine):
  `@media` nests fine; `@keyframes`/`@font-face` are valid inside `@scope`
  but their NAMES are global — collisions across components are the
  author's; `@import` is silently invalid mid-sheet.

## E. Testing

New `tests/styles.test.ts`: injection happens once per type (two instances,
one head element, expected wrapped text including the §B.1 root and limit
selectors verbatim — the limit shape is pinned by the audit's Critical and
must not drift); the root-template `<style>` loud error (§A.4);
the wrapper stamping (child SFC wrappers and the root mount element carry
`data-component-root`; include wrappers do NOT — the existing `data-component`
stamp is already covered by today's suite);
`clearTemplateCache()` removes injected elements and re-mounting re-injects;
`destroy()` leaves them; the two file-contract errors (style-in-include,
extra siblings) with template/script/style order variations both ways;
whitespace-only style injects nothing; quote characters in a component name
arrive escaped in the injected text. Structural assertions only — happy-dom
does not lay out CSS, so nothing asserts computed styles.

## F. Audit verification points — RESOLVED (2026-07-17 adversarial audit)

All verified against w3.org/TR/css-cascade-6 §2.5 + MDN's @scope page, and
in-engine (Chromium 149 headless, 19 assertions; happy-dom 20.10.6 probes):

- Limit exclusivity confirmed (limit elements excluded inclusively with
  their subtrees; `> *` makes the bound inclusive of the wrapper) — but the
  original limit shape FAILED for direct-child wrappers (Critical, fixed in
  §B.1: scope-end selectors with `:scope` match non-relatively and the root
  is an inclusive descendant of itself, so a direct-child wrapper became its
  own limit; the TR and current editor's draft diverge here, and the amended
  selector is immune to both readings).
- `:scope` inside the scope-end selector is valid and refers to the scoping
  root.
- Bare declarations apply to the root as `:where(:scope)` (zero specificity);
  explicit `:scope { }` selects the root at 0-1-0 — docs teach the explicit
  form (§G).
- @scope is Baseline Newly Available since December 2025 (Chrome/Edge 118+,
  Safari 17.4+, Firefox 146+).
- happy-dom preserves `<style>` textContent verbatim through div-parsing,
  head append/attribute lookup, and removal; it parses @scope without
  mangling and computes nothing (structural assertions only, as §E assumes).

## G. Riders

- CLAUDE.md: the components paragraph gains the style part (file contract,
  `@scope` wrapping, the boundary, the stamped attribute); the directives
  list is untouched (this is not a directive).
- README: the components/slots region gains a compact styles subsection with
  one example, the geometry-not-ownership sentence, the at-rules line
  (§D), and the proximity sentence (audit: a scoped rule beats an
  equal-specificity page rule regardless of source order — scoped rules
  have finite proximity, page rules infinite); the existing
  styling-wrappers section gains the in-file `:scope { display: contents; }`
  variant as the recommended form for SFCs (§C.6), keeping the page-level
  rule for includes and the root caveat as-is. Docs teach the explicit
  `:scope { }` form over bare declarations (audit: better documented, and
  its 0-1-0 specificity matches the page-level attribute rule it replaces;
  bare declarations carry zero specificity). One naming caveat: don't give
  an SFC the root's componentName (or mount the root on an element whose
  `data-component` names an SFC) — the root mount would become a scoping
  root for that type's styles page-wide.
- Showcase for §C.6: registration's `[data-component="contact-row"]
  { display: contents; }` moves from `style.css` into `contact-row.html`'s
  own `<style>` as `:scope { display: contents; }` — the row keeps its flex
  layout, now self-contained.
- `docs/internals.md` §6 gains a short paragraph (definition loading now
  carries CSS; injection is type-level like the caches).
- Showcase: the cards example moves its `.card` rules from `style.css` into
  `card.html`'s own `<style>` — the natural demonstration; page-level rules
  stay in `style.css`.

## H. Out of scope

`<style>` INSIDE the `<template>` element (it is just an element; it renders
into the DOM and the browser applies it globally — docs may warn once);
per-instance styles; dynamic CSS (interpolation in style text); `scoped`/
`module` attributes on the style element; removal of injected styles at
`destroy()`; Shadow DOM.

## Success criteria

1. All §E tests green; the existing 261 + 7 untouched.
2. The cards example renders identically with its card rules moved into the
   component file (smoke suite proves the page still works; the moved rules
   are the showcase).
3. Docs riders landed; forge-free prose.
