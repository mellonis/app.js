# Component Styles Implementation Plan (issue #31)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Per-component `<style>` in the SFC file, injected once per type into `document.head` under the platform's `@scope` rule with a boundary at nested SFC instances.

**Architecture:** Two commits. (1) The engine feature: the file-contract extension in `#parseDefinition`, the root-template guard in `#renderTemplate`, the constructor stamp, type-level injection + eviction, and the full test suite. (2) Docs + the two example riders (cards `.card` rules move in-file; registration `contact-row` gains `:scope { display: contents; }`).

**Spec:** `docs/superpowers/specs/2026-07-17-component-styles-design.md` — BINDING, including all audit amendments (§B.1's limit selector is the audit's Critical fix — copy it VERBATIM, never "simplify" it). Spec wins conflicts; report them.

## Global Constraints

- NEVER `git commit` without maintainer authorization (controller holds per-plan pre-authorization).
- No AI attribution; code comments prose-only (no issue/spec/audit refs).
- Baseline **261 unit + 7 smoke green**; nothing existing flips.
- Framework stays zero-runtime-dependency; `expression.ts` untouched.
- The injected rule is exactly:
  `@scope ([data-component="<name>"]) to (:scope [data-component-root] > *) { <css> }`
  with backslash-then-quote escaping applied to `<name>` in the one
  name-bearing attribute selector (the scoping root — the limit is
  name-free).

---

### Task 1: Branch

```bash
cd /Users/mellonis/Developer/mellonis-workspace/app.js
git checkout master && git pull origin master && git checkout -b issue-31-component-styles
npm test   # 261 + 7 green
```

### Task 2: The engine feature (RED → GREEN)

**Files:** `packages/app.js/src/app.ts`; Test (create): `packages/app.js/tests/styles.test.ts`.

- [ ] **File contract (`#parseDefinition`, ~app.ts:2234):** after `<template>`, meaningful siblings may be at most one `<script>` and at most one `<style>`, either order. A `<style>` with NO `<script>` → loud error naming the rule (fires BEFORE the template-only `return null`; other stray content in template-only files stays tolerated as today). Duplicates or any other element → the existing error, message now naming all three parts. Capture `styleElement.textContent`; trimmed-empty means absent. Attach as `css` AFTER the unknown-keys sweep and BEFORE `Object.freeze` — and `css` stays OUT of `DEFINITION_KEYS` (a script exporting `css:` must still warn).
- [ ] **Root guard (`#renderTemplate`, ~app.ts:1520):** scan the parsed div's siblings after the `<template>`; a `<style>` there → loud error (only the root path can reach this once includes are gated above; root styles belong to the host page).
- [ ] **Stamp (constructor, beside `element.dataset['component'] = this.componentName` at ~app.ts:433):** `data-component-root` — one site covers root + every SFC child; includes never construct.
- [ ] **Injection (`#instantiate`, ~app.ts:1400):** static registry `Map<string, HTMLStyleElement>`; on first instantiation of a type whose definition carries `css`, build `<style data-component-style="<name>">` with the Global-Constraints rule text and append to `document.head`. Synchronous check+insert (no await between).
- [ ] **Eviction (`clearTemplateCache`, ~app.ts:2185):** remove every registry element from the DOM, clear the registry.
- [ ] **Tests — spec §E in full, RED first:** once-per-type injection (two instances, one element, VERBATIM expected text — root and limit selectors pinned); root-template `<style>` error; stamping (child SFC wrappers + root mount carry `data-component-root`, include wrappers do not); eviction + re-mount re-injects; `destroy()` leaves styles; style-in-include error; extra-siblings errors (order variations both ways); whitespace-only style injects nothing; quote-bearing name arrives escaped.
- [ ] Gate: `npm run typecheck && npm test` → 261 grows by the styles suite; 7 smoke untouched.
- [ ] Commit: `feat: per-component styles - <style> in the component file, scoped via @scope (fixes #31)`

### Task 3: Docs + riders

- [ ] CLAUDE.md: the components paragraph gains the style part (file contract, @scope wrapping with the exact limit shape, the stamp, geometry-not-ownership, root-file error). README: compact styles subsection (one example; geometry-not-ownership; the at-rules line — `@media` fine, `@keyframes`/`@font-face` global names, `@import` silently invalid; the proximity sentence; the SFC-naming caveat) + the styling-wrappers section gains the in-file `:scope { display: contents; }` variant for SFCs. `docs/internals.md` §6: one short paragraph (definitions carry CSS; injection is type-level like the caches). All forge-free.
- [ ] Cards example: move the `.card` rule block from `cards/style.css` into `card.html`'s `<style>`; page-level rules stay. Registration: `[data-component="contact-row"] { display: contents; }` moves from `style.css` into `contact-row.html` as `:scope { display: contents; }`.
- [ ] Smoke: extend the cards smoke minimally — assert the injected `<style data-component-style="card">` exists in head with the `@scope` prefix; both example suites stay green.
- [ ] Commit: `docs: component styles documented; card and contact-row carry their own CSS`
- [ ] Final gate: `npm run typecheck && npm test`; `git ls-files | grep dist` empty; no stray servers.
