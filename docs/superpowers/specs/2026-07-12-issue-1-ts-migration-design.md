# Design: Fix #1 (component reuse) + TypeScript 7 migration + test suite

**Date:** 2026-07-12
**Branch:** `issue-1-ts-migration`
**Issues:** fixes [#1](https://github.com/mellonis/app.js/issues/1); documents [#2](https://github.com/mellonis/app.js/issues/2), [#3](https://github.com/mellonis/app.js/issues/3), [#4](https://github.com/mellonis/app.js/issues/4) as `test.fails` markers; unblocks [#7](https://github.com/mellonis/app.js/issues/7)

## Context

`app.js` is a single-file, dependency-free reactive teaching framework. Issue #1: the
cycle detector mutates one shared `parentComponentNameList` array across the whole
component tree, so any template used twice anywhere is falsely rejected as a cycle —
components aren't reusable at all. This branch fixes #1 and, per the maintainer's
request, folds in a migration to TypeScript 7 and introduces the project's first test
suite.

## Decisions already made (with maintainer)

| Decision | Choice |
|---|---|
| Props feature (`data-component-prop-*`) | Out of scope — filed as #7, next branch |
| Test stack | vitest + happy-dom |
| Layout | `src/app.ts` → committed `app.js` + `app.d.ts` at repo root |
| Sequencing | Fix #1 in JS first, then port, then tests |
| Encapsulation (post-approval amendment) | Native `#private` fields/methods for internals; public surface: constructor, `element`, `data`, `methods`, `componentName`, static `loadTemplate` + template cache map |
| Dep versions (post-approval amendment) | Latest as of 2026-07-12: typescript 7.0.2, vitest 4.1.10, happy-dom 20.10.6 |

## A. Branch and git workflow

Pull `master`, create `issue-1-ts-migration` from the updated tip. No commits without
explicit maintainer approval; work pauses at checkpoints (after fix, after port, after
tests) for review.

## B. Step 1 — fix #1 in app.js

At `loadComponent` (currently `app.js:120`), replace the shared-array mutation:

```js
// before
parentComponentNameList.unshift(componentName);
// after
parentComponentNameList = [componentName, ...parentComponentNameList];
```

Each recursion branch now carries its own ancestor chain. Behavior change: sibling and
cousin reuse of a component loads correctly; genuine cycles (self-inclusion `a → a`,
mutual inclusion `a → b → a`) are still rejected with the existing error message.

## C. Step 2 — port to TypeScript 7

- **Source:** `src/app.ts`, a 1:1 port of the fixed `app.js` under `strict: true`.
  No behavior changes beyond the #1 fix. Typing work: constructor-options interface,
  interfaces for the two binding-map entry shapes (`{anchor, expression, isHidden}`,
  `{expression}`), `Map<string, Promise<string>>` template cache, an explicit
  `instanceof HTMLTemplateElement` check where the code currently assumes
  `firstChild.content`, `dataset` narrowing.
- **Toolchain:** `typescript@^7` (native compiler; `latest` on npm is 7.0.2) as a dev
  dependency. Contingency: if the native binary misbehaves on darwin, fall back to
  `typescript@6.0.0-beta` — identical language, JS-based compiler.
- **tsconfig:** `strict`, `target: ES2022`, `lib: [ES2022, DOM, DOM.Iterable]`,
  `module: esnext`, `moduleResolution: bundler`, `rootDir: src`, `outDir: .`,
  `declaration: true`. Emits `app.js` + `app.d.ts` at the repo root; both stay
  committed so `import App from '/app.js'` keeps working for students with no build
  step.
- **package.json:** add `"type": "module"`, `build` (`tsc`) and `test` (`vitest run`)
  scripts; `main` stays `app.js`.

## D. Step 3 — test suite (vitest + happy-dom)

`vitest.config.ts` with `environment: 'happy-dom'`. `fetch` is stubbed per test with an
in-memory map of fake `/templates/<name>.html` responses; the static template cache is
reset between tests.

Coverage of current behavior (characterization):

- **Ghost reactivity:** top-level and nested get/set, set triggers visibility+value
  updates, shape frozen by `preventExtensions`, `HTMLInputElement` write-back branch.
- **evaluate:** expression reads over top-level keys; nested write-back path.
- **Template cache:** promise cached per name across instances; entry evicted on
  failed fetch.
- **Directives:** `data-show-if` (swap to comment anchor and back), `data-value`
  (input two-way via nested key, `textContent` one-way otherwise), `data-on-click`
  and `data-on-submit` dispatch to `methods` with the event argument.
- **Components:** nested loading; **#1 regression pair** — sibling reuse of one
  template succeeds; `a → b → a` mutual cycle still rejected.

Known open bugs get `test.fails` cases asserting the **desired** behavior (they pass
while the bug exists, and start failing — forcing marker removal — once fixed):

- #2 top-level input write-back updates `data`
- #3 `null` in initial data doesn't crash the constructor
- #4 one throwing expression doesn't abort the rest of the update pass
- #8 top-level `data-show-if` element that starts hidden appears when its
  expression becomes truthy (bug discovered during test design: the mount loop
  appends only element children, orphaning the anchor comment in the detached
  fragment)

Because internals are `#private` after the port, cycle-rejection tests observe
behavior through the public constructor plus a `console.error` spy rather than
calling `loadComponent` directly.

## E. CI

GitHub Actions workflow (`.github/workflows/ci.yml`), Node 24:
`npm ci` → `npm run build` → `git diff --exit-code app.js app.d.ts` → `npm test`.
The diff gate keeps the committed artifact in sync with `src/app.ts`.

## F. Docs

- **README:** build/test commands, `src/` layout note, and a "styling component
  wrappers" tip — `[data-component="widget"] { display: contents; }` removes the
  wrapper's box from layout (flex/grid transparency). Caveats documented: the
  wrapper's own background/border/padding vanish; don't apply it blanket to
  `[data-component]` since the root element (often `<body>`) is stamped with
  `data-component="root"`.
- **CLAUDE.md:** replace the "dependency-free vanilla JS — keep it that way"
  constraint (now false) with the new toolchain: `src/app.ts` is the source of truth,
  root `app.js`/`app.d.ts` are committed build artifacts (never hand-edit; rebuild),
  commands for build/test.

## G. Out of scope

- Fixes for #2, #3, #4 (documented via `test.fails` only), #5 (ready promise),
  #6 (list rendering)
- #7 component props — next branch, designed on top of this foundation
- Any restructuring of `App` into modules; the port is deliberately 1:1

## Error handling

No changes to the framework's runtime error handling in this branch (that's #5).
Test-side: the fetch stub rejects for unknown template names so cycle/missing-template
rejection paths are exercised.

## Success criteria

1. `npm run build` emits `app.js` + `app.d.ts` identical to the committed artifacts.
2. `npm test` green: all characterization tests pass, #1 regression pair passes,
   three `test.fails` markers in place.
3. A page using two sibling `data-component="widget"` elements renders both (manual
   smoke check with a demo template over a local static server).
4. CI workflow passes on the PR.
