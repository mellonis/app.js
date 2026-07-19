# Engine File Split Implementation Plan (issue #29)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Split `packages/app.js/src/app.ts` (2381 lines) into four files — a support module, a definition-loading module, a ghost factory, and the engine core that stays whole — with **zero behavior change**.

**Spec:** issue #29's maintainer decision IS the spec; no separate design document. The three-tier boundary and the "core stays whole" rejection of WeakMap side-tables are BINDING. This plan adds the symbol inventory, the seams, and the verification protocol.

**Architecture:** Three extraction commits (support → definition → ghost), each independently green, then a docs commit. Extraction order matters: support is the leaf every later module imports.

## Global Constraints

- NEVER `git commit` without maintainer authorization.
- No AI attribution; code comments prose-only (no issue numbers, no `spec §N`).
- Baseline **274 unit + 7 smoke green**, `npm run typecheck` clean. Nothing existing flips. **No test file is edited by this plan** — if a test needs changing, the refactor changed behavior and is wrong.
- The framework stays zero-runtime-dependency. `expression.ts` is untouched.
- The public surface is frozen: `src/app.ts` keeps `export default class Component` and `export type ComponentMethod`, and `Component.loadTemplate` / `Component.clearTemplateCache` keep their shape as statics on the class.
- **The runtime module graph stays acyclic.** Type-only cycles are permitted and expected (see Task 2); runtime cycles are not.
- Every moved body moves **verbatim** — comments included. This refactor relocates code; it does not reword, reformat, or "improve" it. Any genuine improvement is a separate commit.

---

### Task 1: Branch and baseline

```sh
cd /Users/mellonis/Developer/mellonis-workspace/app.js
git checkout master && git pull origin master && git checkout -b issue-29-engine-split
npm test && npm run typecheck   # 274 + 7 green, tsc silent — record this
```

- [ ] Baseline captured. This is the entire correctness criterion for the refactor: the same numbers must hold after every task below.

---

### Task 2: `src/support.ts` — types, constants, pure helpers

**Files:** create `packages/app.js/src/support.ts`; edit `packages/app.js/src/app.ts`.

**Moves (verbatim, in source order):**

| Symbol | Kind |
|---|---|
| `ComponentMethod`, `BoundComponentMethod` | type |
| `ComponentOptions`, `TrackedBinding` | type |
| `ShowIfEntry`, `ValueEntry`, `DisplayIfEntry`, `DisabledIfEntry` | interface |
| `ForBlockScopeRef`, `TextNodeEntry`, `TextPart` | interface |
| `ForBlockEntry`, `ForBlock` | interface |
| `LoadComponentOptions`, `SlotRecordEntry` | interface |
| `PropBinding`, `PropBindingRecord` | interface |
| `ComponentEvents`, `ComponentDefinition`, `InternalConstruction` | interface |
| `EXPRESSION_GLOBALS`, `UNREFERENCEABLE_PROP_NAMES`, `isValidPropName` | const/fn |
| `RESERVED_EVENT_NAME`, `COMPONENT_DESTROYED_MESSAGE`, `DEFINITION_KEYS` | const |
| `splitInterpolations`, `collectTextNodes`, `isMeaningfulNode` | fn |
| `trackedInterpolationTextNodes`, `directiveAnchorComments` | WeakSet |
| `trackDirectiveAnchor`, `isContentNode` | fn |
| `formControlTagNames`, `DATA_VALUE_FORM_ONLY_MESSAGE` | const |
| `disableableTagNames`, `DATA_DISABLED_IF_MESSAGE` | const |
| `DATA_ON_ATTRIBUTE_NAME_PATTERN`, `DEFAULT_SLOT_NAME` | const |
| `SLOT_FORBIDDEN_DIRECTIVE_ATTRIBUTES`, `slotHasForbiddenDirective` | const/fn |

That is app.ts lines 4–294 in full — the entire preamble. The class declaration becomes line ~5.

- [ ] **The type-only cycle.** `TrackedBinding` has a `{kind: 'props'; child: Component}` variant, `ForBlockEntry` has `child?: Component`, `ComponentMethod` is `(this: Component, …)`, and `ComponentDefinition.mounted` is `(this: Component)`. So support.ts opens with:

  ```ts
  import type Component from './app.js';
  ```

  This is deliberate and is NOT a WeakMap-side-table situation: `import type` is erased at emit, so the runtime graph stays a clean `support ← definition ← app`. Only the type graph is circular, which TypeScript resolves natively.

- [ ] **Verify the erasure, don't assume it:** after `npm run build`, `grep -c "from './app" packages/app.js/dist/support.js` must be `0`. If the emit keeps the import, stop and report — do not work around it.
- [ ] **Re-export the public type** so the frozen surface holds: app.ts carries `export type { ComponentMethod } from './support.js';`. `tests/interpolation.test.ts` imports it from `../src/app` and must keep working untouched.
- [ ] Everything support.ts exports is consumed by app.ts via one `import` + one `import type` statement.
- [ ] **Nothing in support.ts may reference `Component` at runtime** — only in type position. A support helper calling a static or constructing an instance means the symbol was mis-assigned; it belongs in app.ts.
- [ ] **Both WeakSets must be `export`ed, not module-private.** The engine writes to them directly, not only through the helpers that read them: `trackedInterpolationTextNodes.add(node)` at ~app.ts:781 and `directiveAnchorComments.add(…)` at ~app.ts:947–948 (the `data-for` anchor pair, which bypasses `trackDirectiveAnchor`). Verified call sites: those three writes plus the reads inside `isContentNode` and `trackDirectiveAnchor`, nothing else.
- [ ] Gate: `npm run typecheck && npm test` → 274 + 7, unchanged.
- [ ] Commit: `refactor: extract types, constants, and pure helpers into a support module`

---

### Task 3: `src/definition.ts` — how an SFC file becomes a module

**Files:** create `packages/app.js/src/definition.ts`; edit `packages/app.js/src/app.ts`.

**Moves** (all currently static, none touching instance state):

- `Component.#templateNameToTemplatePromiseMap` → module-level `const`
- `Component.#definitionPromiseMap` → module-level `const`
- `Component.#componentNameToStyleElementMap` → module-level `const`
- `Component.loadTemplate` → exported `loadTemplate(templateName)`
- `Component.#loadDefinition` → exported `loadDefinition(componentName)`
- `Component.#parseDefinition` → module-private `parseDefinition(componentName, templateText)`
- `Component.#injectComponentStyle` → exported `injectComponentStyle(componentName, css)`
- the body of `Component.clearTemplateCache` → exported `clearCaches()`

The style registry moving here is a **maintainer decision** taken while planning: it is type-level static state with the same lifecycle as the definition cache, and the CSS it injects arrives on the definition object. It keeps all three caches under one roof and `clearTemplateCache` a single delegation.

- [ ] Definition module imports from support only (`isMeaningfulNode`, `DEFINITION_KEYS`, `ComponentDefinition`). It must not import `Component` at all — not even as a type. Grep to confirm.
- [ ] **Public statics stay on the class as thin delegates**, preserving `Component.loadTemplate` / `Component.clearTemplateCache`:

  ```ts
  static loadTemplate(templateName: string): Promise<string> {
      return loadTemplate(templateName);
  }

  static clearTemplateCache(): void {
      clearCaches();
  }
  ```

  Watch the name shadowing between the static and the import — alias the import at the import site if the delegate reads ambiguously.
- [ ] Update the three internal call sites: `Component.#loadDefinition(…)` at ~app.ts:1109 and ~app.ts:1963, `Component.#injectComponentStyle(…)` at ~app.ts:1423.
- [ ] The long `@scope` explanation comment above `#injectComponentStyle` (the load-bearing `:scope ` note) travels **with the function**. It is the hardest-won comment in the file.
- [ ] `tests/styles.test.ts` and `tests/templates.test.ts` exercise cache eviction and re-injection across `clearTemplateCache()` — they are the regression net here and stay untouched.
- [ ] Gate: `npm run typecheck && npm test` → 274 + 7, unchanged.
- [ ] Commit: `refactor: move SFC definition loading and the type-level caches into their own module`

---

### Task 4: `src/ghost.ts` — the reactive store

**Files:** create `packages/app.js/src/ghost.ts`; edit `packages/app.js/src/app.ts`.

- [ ] Move `#createGhost` (app.ts:794–853) to an exported free function. Verified: its only engine reach is `app.#record(path)` and `app.#notify(path)` — nothing else — and it has exactly **one** external call site, the constructor at ~app.ts:382 (the only other reference is its own recursion). The two reaches become constructor hooks:

  ```ts
  interface GhostHooks {
      record(path: string): void;
      notify(path: string): void;
  }

  export function createGhost(data: Record<string, unknown>, hooks: GhostHooks, prefix = ''): Record<string, unknown>
  ```

  The recursive call threads `hooks` through unchanged.
- [ ] Call site in the constructor becomes:

  ```ts
  createGhost(data, {record: path => this.#record(path), notify: path => this.#notify(path)})
  ```

  Arrow functions, so `this` binds to the instance. Build the hooks object once and hold it if the constructor needs it again.
- [ ] The `const app = this;` line inside the old method disappears with the closure — that alias existed only to reach the privates.
- [ ] All three comments inside the body (the object escape-hatch note, the suppress-gate note, the replace-only `TypeError`) move verbatim.
- [ ] `tests/ghost.test.ts` and `tests/reactivity.test.ts` are the regression net. Untouched.
- [ ] Gate: `npm run typecheck && npm test` → 274 + 7, unchanged.
- [ ] Commit: `refactor: extract the ghost factory into its own module, reached through record and notify hooks`

---

### Task 5: Section banners in the engine core

**Files:** `packages/app.js/src/app.ts`.

- [ ] Add banner comments in `expression.ts`'s existing style, marking the remaining organs in source order: tracking and subscription, the flush and drain, text interpolation wiring, list extraction and reconciliation, event handling, component instantiation and lifecycle, template rendering, slots and distribution, fragment wiring, props, the per-kind drain updaters.
- [ ] Match `expression.ts`'s banner formatting exactly — read it first; do not invent a second house style.
- [ ] Banners describe substance only. No issue numbers, no `spec §N`, no cross-file "see also" pointing at internal artifacts.
- [ ] Gate: `npm run typecheck && npm test` → 274 + 7, unchanged.
- [ ] Commit: `refactor: section banners marking the engine core's organs` — banners are a source change and get their own commit, so the docs commit below stays markdown-only.

---

### Task 6: Docs riders

**Files:** `docs/internals.md`, `CLAUDE.md`, `README.md`.

- [ ] **`docs/internals.md` lines 3–5** — the opening "The framework is two files" claim is now false. Rewrite as the new file map: `app.ts` (the engine core), `expression.ts` (the expression language), `support.ts` (types, constants, pure helpers), `definition.ts` (SFC files → definitions, plus the type-level caches), `ghost.ts` (the reactive store).
- [ ] **`docs/internals.md` "Reading order" (line 142)** — insert `ghost.ts` ahead of the current step 2, since idea 1 now lives in its own file; keep `expression.ts` first (still the zero-knowledge entry point) and components last.
- [ ] **`CLAUDE.md` line 7** — "source of truth is two files, …" becomes the five-file map, one clause each. This is the sentence most likely to be skipped; it is not optional.
- [ ] **`CLAUDE.md` line 30** — "Everything is the `Component` class in `packages/app.js/src/app.ts`" is now literally false and needs a qualifier: the class is still one organism, but the ghost factory and definition loading live beside it.
- [ ] **Read the whole `CLAUDE.md` Architecture section, don't grep it.** Location claims hide behind function names, not just file paths — the `**Reactivity — createGhost(data)**` and `**Templates and components.**` paragraphs describe internals that have moved. The headings are fine as conceptual shorthand; it is the prose asserting *where code lives* that needs reconciling.
- [ ] **`README.md`** — grep for any file-count or source-layout claim and reconcile. (No match at plan time; re-check, since the docs commits ahead of this one may have added one.)
- [ ] Published docs stay forge-agnostic: describe the split in prose, never "issue #29".
- [ ] Commit: `docs: engine file map - support, definition, and ghost modules alongside the core (fixes #29)`

---

## Verification protocol

The refactor is correct if and only if, at every commit boundary:

1. `npm run typecheck` is silent.
2. `npm test` reports **274 unit + 7 smoke**, all passing.
3. `git diff --stat` on test files is **empty** for tasks 2–5.
4. `npm run build && grep -c "from './app" packages/app.js/dist/support.js` returns `0` (the type-only cycle really is erased).
5. `npm run ex:cards` and `npm run ex:registration` load and behave — the two examples exercising SFCs, slots, styles, and props end to end. The multi-file dist already serves: `serve.mjs` resolves any `/<name>.js` against `dist/`, so `support.js`, `definition.js`, and `ghost.js` are reachable with no server change. Confirm in the browser console that all of them actually 200.

## Rejected

- **WeakMap side-tables to split the engine core further.** The maintainer rejected this in the issue; the `#private` fields connecting binding maps, subscription registry, tracking frames, drain, reconciler, and lifecycle do not cross module boundaries, and faking it costs readability for nothing.
- **Reworking anything while moving it.** Behavior-preserving relocation only.
