# Design: npm workspaces restructure + runnable examples (issue #10)

**Date:** 2026-07-12
**Branch:** `issue-10-workspaces`
**Issues:** implements [#10](https://github.com/mellonis/app.js/issues/10); todo example deferred to [#6](https://github.com/mellonis/app.js/issues/6)

## Decisions made with the maintainer

| Decision | Choice |
|---|---|
| Todo example (needs list rendering, #6 open) | Deferred — lands with #6's branch; #10 ships counter + form-submit |
| Per-example templates vs shared namespace | **One server per example**: each example dir is its own web root with its own `/templates/` |
| Student consumption path | **Examples are the path** — clone → `npm install` → `npm run <example>`; no npm publish, no release artifacts |
| CI verification of examples | **happy-dom smoke per example** against the real built dist over real HTTP |

## A. Layout

```
package.json                  # root: private workspaces ["packages/*"], proxy scripts
packages/
  app.js/                     # framework package (moved with git mv — history preserved)
    package.json              # name "app.js", private; main/types → dist/; prepare → build
    src/app.ts
    tests/                    # existing 29-test vitest suite, unchanged
    tsconfig.json             # typecheck: src + tests, noEmit
    tsconfig.build.json       # emit: rootDir src, outDir dist, declaration
    vitest.config.ts
    dist/                     # BUILD OUTPUT — gitignored, never committed
  examples/
    package.json              # name "examples", private; scripts: counter, form, test (smoke)
    serve.mjs                 # zero-dependency node:http static server (see E)
    counter/
      index.html
      templates/root.html
    form/
      index.html
      templates/root.html
    tests/
      counter.smoke.test.ts
      form.smoke.test.ts
```

Deleted from root: committed `app.js`, `app.d.ts` (the point of #10), `src/`, `tests/`,
both tsconfigs, `vitest.config.ts` (all moved). Root `.gitignore` gains `dist/`.

Root scripts proxy into workspaces:
`build` → `npm run build -w app.js`; `typecheck`/`test` → `-ws --if-present`;
`ex:counter`/`ex:form` → `npm run <name> -w examples` (root example runners use the
`ex:` prefix — post-approval maintainer amendment).

Dev dependencies (typescript, vitest, happy-dom) stay in the **root** package.json —
npm hoists them; workspace packages declare no duplicate dev deps.

## B. Framework package

- `name: "app.js"`, `private: true`, `type: "module"`, `main: "./dist/app.js"`,
  `types: "./dist/app.d.ts"`.
- **`prepare: "npm run build"`** — root `npm install` / `npm ci` builds `dist/`
  automatically; the examples server can always rely on it existing.
- `tsconfig.build.json` uses `outDir: "dist"` — the `outDir: "."` root-emission hack
  and its `"exclude": ["node_modules"]` workaround are removed (no longer needed once
  the outDir is a subdirectory).
- Source and tests are moved verbatim (`git mv`) — no framework code changes in this
  branch beyond none at all: the suite must stay 29 passed / 0 expected-fail.

## C. Counter example

`counter/templates/root.html`:

```html
<template>
    <p>Count: <span data-value="count"></span></p>
    <button data-on-click="increment">+1</button>
    <button data-on-click="decrement">-1</button>
</template>
```

`counter/index.html` mounts with `data: {count: 0}` and two methods mutating
`this.data.count`. The page imports the framework exactly like the classic layout:
`import App from '/app.js';` — the aliasing server (E) makes that path real.

## D. Form-submit example

`form/templates/root.html`: a `<form data-on-submit="submit">` with two inputs —
`data-value="name"` (top-level key, exercising the fresh #2 fix) and
`data-value="user.email"` (nested key) — plus a submit button. The `submit` method
calls `event.preventDefault()` and `console.log`s the collected values; the console
line is the app's entire output (per maintainer spec: "form submit app (to console)").

## E. serve.mjs — the per-example dev server

Zero-dependency `node:http` script (~50 lines), usage `node serve.mjs <example> [port]`:

- Web root = `packages/examples/<example>/` — so `/templates/<name>.html` resolves to
  that example's own templates (the maintainer's "one server per example" choice).
- Alias: `GET /app.js` → `packages/app.js/dist/app.js` (404 with a clear
  "run npm install first" hint if dist is missing).
- Content types for .html/.js/.css; path traversal guarded (resolved path must stay
  under the example root); default port 8123, overridable by argv for parallel runs.

## F. Examples smoke tests

In the examples package (vitest, happy-dom environment is NOT needed — tests use
happy-dom's `Browser` API directly with `enableJavaScriptEvaluation: true`, the
setting the first branch's manual smoke check established as required):

- Each test spawns `serve.mjs <example> <ephemeral port>` as a child process, waits
  for the listen line, and kills it in teardown.
- `counter.smoke.test.ts`: load the page, wait for mount, click `+1`, assert the
  rendered count becomes `1` (and `-1` back to `0`).
- `form.smoke.test.ts`: set both inputs (dispatch `input` events), submit the form,
  assert the virtual console received the expected log line.

These exercise real dist over real HTTP with real templates — the layer the unit
suite deliberately mocks.

## G. CI

`.github/workflows/ci.yml` rewritten:

```
npm ci                 # prepare builds packages/app.js/dist
npm run typecheck      # all workspaces
npm test               # framework unit suite + examples smoke suite
```

Removed: `git diff --exit-code app.js app.d.ts` (no committed artifacts to sync) and
the `node -e import(...)` artifact check (the smoke suite imports the real artifact
through a real page, which is strictly stronger).

## H. Docs

- **README:** new Quick start (`git clone` → `npm install` → `npm run counter` /
  `npm run form`), updated Development section (workspace layout, dist is generated),
  Overview and the `display: contents` styling tip retained.
- **CLAUDE.md:** layout/commands rewritten for workspaces; artifact policy inverted:
  `dist/` is generated and gitignored — never commit build output; `prepare` keeps it
  fresh. The `it.fails` convention note and Architecture section stay (paths updated
  to `packages/app.js/src/app.ts`).

## I. Out of scope

- Todo example — explicitly deferred to #6 (a comment on #6 will record this).
- #7 props, any npm publishing, Playwright, HMR/watch mode for the dev server.

## Success criteria

1. Fresh clone: `npm install && npm run ex:counter` serves a working counter at
   `http://localhost:8123` with no manual build step.
2. `npm test` at root: framework suite 29 passed, plus both smoke tests green.
3. `git ls-files` contains no build output (`app.js`/`app.d.ts`/`dist/`).
4. CI green on the branch with the rewritten workflow.
5. Framework `git log --follow packages/app.js/src/app.ts` shows pre-move history.
