# Workspaces Restructure + Examples Implementation Plan (issue #10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the repo to an npm-workspaces monorepo — framework package with uncommitted `dist/`, plus a runnable examples package (counter, form-submit) with a zero-dependency per-example dev server and happy-dom smoke tests.

**Architecture:** `git mv` relocates the framework (source, tests, configs) into `packages/app.js` with history preserved; build output moves to a gitignored `dist/` kept fresh by a `prepare` script. `packages/examples` contains self-contained example apps, each served as its own web root by `serve.mjs`, which aliases `/app.js` to the framework build — so example pages look exactly like the classic single-file deployment. Smoke tests drive the real dist over real HTTP with happy-dom's Browser.

**Tech Stack:** npm workspaces, TypeScript 7.0.2, vitest 4.1.10, happy-dom 20.10.6, node:http (zero-dep server), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-12-workspaces-examples-design.md`

## Global Constraints

- **NEVER run `git commit` without maintainer authorization.** The controller obtains standing pre-authorization before execution begins; if it is absent, every "Commit" step becomes "pause and request approval".
- **No Claude/AI attribution** anywhere (commits, code, docs).
- Framework source and tests move **byte-identical** — this branch contains zero framework behavior changes. The suite must finish exactly `29 passed` (0 expected-fail) after every task.
- `dist/` (and any build output) is **never committed**; `git ls-files` must never show `dist/`, root `app.js`, or root `app.d.ts` after Task 2.
- Use `git mv` for all moves (history must survive: `git log --follow packages/app.js/src/app.ts` shows pre-move commits).
- Dev deps stay pinned in the **root** package.json: `typescript@7.0.2`, `vitest@4.1.10`, `happy-dom@20.10.6`; Task 5 adds `@types/node` via `npm install --save-dev --save-exact @types/node` (lockfile pins it).
- Dev-server default port 8123; smoke tests use 8231 (counter) and 8232 (form) — vitest runs test files in parallel workers, so ports must differ.
- Issue references: [#10](https://github.com/mellonis/app.js/issues/10) (this plan), [#6](https://github.com/mellonis/app.js/issues/6) (todo example deferred there).

---

### Task 1: Branch setup

**Files:** none (git only)

**Interfaces:**
- Consumes: clean `master` at `5c8e5bb` or later
- Produces: branch `issue-10-workspaces`

- [ ] **Step 1: Sync and branch**

```bash
cd /Users/mellonis/Developer/mellonis-workspace/app.js
git checkout master
git pull origin master
git checkout -b issue-10-workspaces
```

- [ ] **Step 2: Verify**

Run: `git status && git branch --show-current`
Expected: clean tree, branch `issue-10-workspaces`.

---

### Task 2: Move the framework into `packages/app.js`, convert root to a workspaces root

**Files:**
- Move (git mv): `src/` → `packages/app.js/src/`, `tests/` → `packages/app.js/tests/`, `tsconfig.json` → `packages/app.js/tsconfig.json`, `tsconfig.build.json` → `packages/app.js/tsconfig.build.json`, `vitest.config.ts` → `packages/app.js/vitest.config.ts`
- Delete (git rm): `app.js`, `app.d.ts` (committed artifacts — the point of #10)
- Create: `packages/app.js/package.json`
- Modify: `package.json` (root), `.gitignore`, `packages/app.js/tsconfig.build.json`
- Regenerate: `package-lock.json` (workspaces layout)

**Interfaces:**
- Consumes: current single-package layout
- Produces: workspace `app.js` with scripts `build`/`typecheck`/`test` and `prepare`; root proxy scripts `build`, `typecheck`, `test`; framework build at `packages/app.js/dist/app.js` (gitignored). Tasks 3–7 rely on these exact paths and script names.

- [ ] **Step 1: Move files and delete artifacts**

```bash
mkdir -p packages/app.js
git mv src packages/app.js/src
git mv tests packages/app.js/tests
git mv tsconfig.json packages/app.js/tsconfig.json
git mv tsconfig.build.json packages/app.js/tsconfig.build.json
git mv vitest.config.ts packages/app.js/vitest.config.ts
git rm app.js app.d.ts
```

- [ ] **Step 2: Write `packages/app.js/package.json`**

```json
{
  "name": "app.js",
  "version": "0.0.1",
  "private": true,
  "description": "A tiny reactive framework",
  "type": "module",
  "main": "./dist/app.js",
  "types": "./dist/app.d.ts",
  "scripts": {
    "prepare": "npm run build",
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "license": "MIT"
}
```

- [ ] **Step 3: Rewrite the root `package.json`**

```json
{
  "name": "app.js-monorepo",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build -w app.js",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm test --workspaces --if-present",
    "ex:counter": "npm run counter -w examples",
    "ex:form": "npm run form -w examples"
  },
  "repository": {
    "type": "git",
    "url": "(git://github.com:mellonis/app.js.git)"
  },
  "keywords": [
    "framework",
    "reactive"
  ],
  "author": "mellonis@mellonis.ru",
  "license": "MIT",
  "devDependencies": {
    "happy-dom": "20.10.6",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

(`ex:counter`/`ex:form` scripts point at the examples workspace created in Task 3; they fail until then — acceptable mid-branch. Naming is a maintainer amendment: root example runners use the `ex:` prefix.)

- [ ] **Step 4: Point the build at `dist/` and drop the old workaround**

`packages/app.js/tsconfig.build.json` becomes:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

(The `"exclude": ["node_modules"]` line existed only because `outDir: "."` made tsc auto-exclude the repo root; with `outDir: "dist"` it must be removed.)

- [ ] **Step 5: Update `.gitignore`**

```gitignore
node_modules/
.superpowers/
dist/
```

- [ ] **Step 6: Reinstall and verify the whole gate**

```bash
rm -rf node_modules package-lock.json
npm install
npm run typecheck
npm test
ls packages/app.js/dist/app.js packages/app.js/dist/app.d.ts
git ls-files | grep -E '^(app\.js|app\.d\.ts)$|dist/' && echo "FAIL: build output tracked" || echo "OK: no build output tracked"
```

Expected: install runs the framework's `prepare` (build) automatically; typecheck exits 0; vitest reports `29 passed` from `packages/app.js`; both dist files exist; final line prints `OK: no build output tracked`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move framework into packages/app.js workspace, stop committing build output (#10)"
```

---

### Task 3: Examples package, dev server, counter example

**Files:**
- Create: `packages/examples/package.json`
- Create: `packages/examples/serve.mjs`
- Create: `packages/examples/counter/index.html`
- Create: `packages/examples/counter/templates/root.html`

**Interfaces:**
- Consumes: `packages/app.js/dist/app.js` (built by Task 2's `prepare`)
- Produces: `node serve.mjs <example> [port]` serving `packages/examples/<example>/` as web root with `GET /app.js` aliased to the framework dist and stdout line `Serving <example> at http://localhost:<port>/` (Task 5's smoke helper waits for the literal word `Serving`). Root script `npm run ex:counter`.

- [ ] **Step 1: Write `packages/examples/package.json`**

```json
{
  "name": "examples",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "counter": "node serve.mjs counter",
    "form": "node serve.mjs form",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "license": "MIT"
}
```

(`typecheck`/`test` become functional in Task 5; `npm test --workspaces --if-present` tolerates the missing vitest content until then — vitest exits non-zero on "no test files", so Task 5 must land before root `npm test` is run against the examples workspace. Until Task 5, verify with `npm test -w app.js`.)

- [ ] **Step 2: Write `packages/examples/serve.mjs`**

```js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleName = process.argv[2];
const port = Number(process.argv[3] ?? 8123);

if (!exampleName) {
    console.error('Usage: node serve.mjs <example> [port]');
    process.exit(1);
}

const examplesRoot = fileURLToPath(new URL('.', import.meta.url));
const webRoot = resolve(examplesRoot, exampleName);
const frameworkDist = resolve(examplesRoot, '../app.js/dist/app.js');

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    let filePath;

    if (url.pathname === '/app.js') {
        filePath = frameworkDist;
    } else {
        const requested = url.pathname === '/' ? '/index.html' : url.pathname;
        filePath = resolve(join(webRoot, requested));

        if (!filePath.startsWith(webRoot + sep)) {
            response.writeHead(403, {'Content-Type': 'text/plain; charset=utf-8'});
            response.end('Forbidden');
            return;
        }
    }

    try {
        const body = await readFile(filePath);
        response.writeHead(200, {'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream'});
        response.end(body);
    } catch {
        const hint = filePath === frameworkDist
            ? 'Framework build missing - run `npm install` (or `npm run build`) at the repo root first.'
            : `Not found: ${url.pathname}`;
        response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        response.end(hint);
    }
});

server.listen(port, () => {
    console.log(`Serving ${exampleName} at http://localhost:${port}/`);
});
```

- [ ] **Step 3: Write `packages/examples/counter/templates/root.html`**

```html
<template>
    <p>Count: <span data-value="count"></span></p>
    <button data-on-click="increment">+1</button>
    <button data-on-click="decrement">-1</button>
</template>
```

- [ ] **Step 4: Write `packages/examples/counter/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Counter — app.js example</title>
</head>
<body>
<div id="app"></div>
<script type="module">
    import App from '/app.js';

    new App({
        element: document.querySelector('#app'),
        data: {count: 0},
        methods: {
            increment() {
                this.data.count = Number(this.data.count) + 1;
            },
            decrement() {
                this.data.count = Number(this.data.count) - 1;
            },
        },
    });
</script>
</body>
</html>
```

- [ ] **Step 5: Verify by hand over HTTP**

```bash
node packages/examples/serve.mjs counter 8123 &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:8123/
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:8123/app.js
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8123/templates/root.html
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8123/../../app.js/package.json
kill $SERVER_PID
```

Expected: `200 text/html...`, `200 text/javascript...`, `200`, and the traversal attempt returns `403` or `404` (never `200`).

- [ ] **Step 6: Commit**

```bash
git add packages/examples
git commit -m "feat: examples workspace with zero-dep dev server and counter example (#10)"
```

---

### Task 4: Form-submit example

**Files:**
- Create: `packages/examples/form/index.html`
- Create: `packages/examples/form/templates/root.html`

**Interfaces:**
- Consumes: `serve.mjs` from Task 3
- Produces: the form example; its submit handler logs exactly `Submitted: name=<name>, email=<email>` — Task 5's smoke test asserts this literal shape.

- [ ] **Step 1: Write `packages/examples/form/templates/root.html`**

```html
<template>
    <form data-on-submit="submit">
        <label>Name: <input data-value="name"></label>
        <label>Email: <input data-value="user.email"></label>
        <button type="submit">Submit</button>
    </form>
</template>
```

(One top-level key and one nested key on purpose — the pair demonstrates both two-way binding paths.)

- [ ] **Step 2: Write `packages/examples/form/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Form — app.js example</title>
</head>
<body>
<div id="app"></div>
<script type="module">
    import App from '/app.js';

    new App({
        element: document.querySelector('#app'),
        data: {name: '', user: {email: ''}},
        methods: {
            submit(event) {
                event.preventDefault();
                console.log(`Submitted: name=${this.data.name}, email=${this.data.user.email}`);
            },
        },
    });
</script>
</body>
</html>
```

- [ ] **Step 3: Verify over HTTP**

```bash
node packages/examples/serve.mjs form 8124 &
SERVER_PID=$!
sleep 1
curl -s http://localhost:8124/templates/root.html | head -3
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8124/app.js
kill $SERVER_PID
```

Expected: the template's first lines, and `200` for the framework alias.

- [ ] **Step 4: Commit**

```bash
git add packages/examples/form
git commit -m "feat: form-submit example logging to console (#10)"
```

---

### Task 5: Smoke tests for both examples

**Files:**
- Create: `packages/examples/tests/helpers.ts`
- Create: `packages/examples/tests/counter.smoke.test.ts`
- Create: `packages/examples/tests/form.smoke.test.ts`
- Create: `packages/examples/tsconfig.json`
- Modify: root `package.json` + `package-lock.json` (add `@types/node`)

**Interfaces:**
- Consumes: `serve.mjs` stdout contract (`Serving ...`), example DOM structures from Tasks 3–4
- Produces: `startExample(name: string, port: number): Promise<RunningExample>`, `stopExample(example: RunningExample): void`, `pollFor(condition: () => boolean, timeoutMs?: number): Promise<void>`; root `npm test` now runs both workspaces green.

- [ ] **Step 1: Install node types**

```bash
npm install --save-dev --save-exact @types/node
```

- [ ] **Step 2: Write `packages/examples/tsconfig.json`**

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["tests"]
}
```

- [ ] **Step 3: Write `packages/examples/tests/helpers.ts`**

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface RunningExample {
    process: ChildProcess;
    baseUrl: string;
}

export function startExample(name: string, port: number): Promise<RunningExample> {
    const serveScript = fileURLToPath(new URL('../serve.mjs', import.meta.url));
    const child = spawn(process.execPath, [serveScript, name, String(port)], {stdio: ['ignore', 'pipe', 'inherit']});

    return new Promise((resolvePromise, rejectPromise) => {
        child.stdout!.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('Serving')) {
                resolvePromise({process: child, baseUrl: `http://localhost:${port}`});
            }
        });
        child.on('error', rejectPromise);
        child.on('exit', code => {
            rejectPromise(new Error(`serve.mjs exited early with code ${code}`));
        });
    });
}

export function stopExample(example: RunningExample): void {
    example.process.kill();
}

export async function pollFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const startedAt = Date.now();

    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Condition not met within timeout');
        }

        await new Promise(resolveSleep => setTimeout(resolveSleep, 25));
    }
}
```

- [ ] **Step 4: Write `packages/examples/tests/counter.smoke.test.ts`**

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('counter', 8231);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

it('renders and counts through the real built framework over real HTTP', async () => {
    const page = browser.newPage();
    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const count = () => document.querySelector('span[data-value="count"]')?.textContent;

    await pollFor(() => count() === '0');

    const buttons = [...document.querySelectorAll('button')];
    const plus = buttons.find(button => button.textContent === '+1')!;
    const minus = buttons.find(button => button.textContent === '-1')!;

    plus.click();
    expect(count()).toBe('1');

    plus.click();
    expect(count()).toBe('2');

    minus.click();
    expect(count()).toBe('1');
});
```

- [ ] **Step 5: Write `packages/examples/tests/form.smoke.test.ts`**

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('form', 8232);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

it('submits the form and logs the collected values to the console', async () => {
    const page = browser.newPage();
    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;

    await pollFor(() => document.querySelector('form') !== null);

    const [nameInput, emailInput] = [...document.querySelectorAll('input')];
    nameInput.value = 'Ada';
    nameInput.dispatchEvent(new windowRealm.Event('input'));
    emailInput.value = 'ada@lovelace.dev';
    emailInput.dispatchEvent(new windowRealm.Event('input'));

    document.querySelector('form')!.dispatchEvent(new windowRealm.Event('submit'));

    expect(page.virtualConsolePrinter.readAsString()).toContain('Submitted: name=Ada, email=ada@lovelace.dev');
});
```

(If `virtualConsolePrinter.readAsString()` does not exist in happy-dom 20.10.6, the fallback is collecting lines via `page.virtualConsolePrinter.addEventListener('print', ...)` — the Task-9 report in `.superpowers/sdd/task-9-report.md` documents that EventTarget API. Adapt and note the deviation in your report.)

- [ ] **Step 6: Run and verify everything**

```bash
npm run typecheck
npm test
```

Expected: typecheck exits 0 for both workspaces; framework suite `29 passed`; examples suite `2 passed`; no stray server processes left (`pgrep -f serve.mjs` prints nothing).

- [ ] **Step 7: Commit**

```bash
git add packages/examples/tests packages/examples/tsconfig.json package.json package-lock.json
git commit -m "test: happy-dom smoke tests driving both examples over HTTP (#10)"
```

---

### Task 6: CI rewrite

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root scripts from Task 2, smoke tests from Task 5
- Produces: CI = install (builds via prepare) → typecheck → all tests. The artifact-sync diff and artifact import-check steps are removed (the smoke suite supersedes both).

- [ ] **Step 1: Rewrite `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Verify the same sequence locally from clean state**

```bash
rm -rf node_modules packages/app.js/dist
npm ci
npm run typecheck
npm test
```

Expected: `npm ci` rebuilds `packages/app.js/dist` via `prepare`; typecheck and both test suites green (29 + 2).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: workspaces pipeline - install builds dist, typecheck, unit + smoke tests (#10)"
```

---

### Task 7: Docs rewrite + final gate

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above
- Produces: docs matching the workspaces reality; branch ready for the maintainer's landing decision.

- [ ] **Step 1: Replace `README.md` content**

````markdown
# app.js
A tiny reactive framework

# Overview

- Templates should be placed in /templates directory
- Meaningful attributes in templates are: data-component, data-show-if, data-value, data-on-*
- App needs to be constructed with parameters: element, data, methods and componentName, which is optional
- An App instance exposes `ready` — a promise that resolves when the initial mount finishes (and rejects with the original error if it fails)
- A template that fails to load (network error or HTTP error status) is not cached — the next load retries the fetch

# Quick start

```sh
git clone git@github.com:mellonis/app.js.git
cd app.js
npm install        # installs dev deps and builds the framework
npm run ex:counter # counter example → http://localhost:8123/
npm run ex:form    # form-submit example → http://localhost:8123/
```

Each example is served as its own web root: `/app.js` is the freshly built framework, `/templates/` belongs to that example alone.

# Repository layout

- `packages/app.js` — the framework. TypeScript source in `src/`, tests in `tests/`, build output in `dist/` (generated by `npm run build` and by `npm install`; never committed).
- `packages/examples` — runnable teaching examples (`counter/`, `form/`) plus `serve.mjs`, a dependency-free static server, and smoke tests that drive the built framework over real HTTP.

# Development

```sh
npm run build       # compile packages/app.js/src → packages/app.js/dist
npm run typecheck   # all workspaces
npm test            # framework unit suite + examples smoke suite
```

# Styling component wrappers

A `data-component` element is a real box in layout, which gets in the way inside flex or grid containers. Make a wrapper transparent to layout with:

```css
[data-component="widget"] {
    display: contents;
}
```

Two caveats: the wrapper's own background/border/padding stop rendering, and the rule should target specific components — the app stamps `data-component` on its root element (often `<body>`), which must keep its box.
````

- [ ] **Step 2: Update `CLAUDE.md`**

Replace the "What this is" paragraph with:

````markdown
A tiny reactive framework written as a teaching project for students learning JavaScript and the DOM, structured as an npm-workspaces monorepo. The framework lives in `packages/app.js` (TypeScript 7, strict, native `#private` internals; source of truth `packages/app.js/src/app.ts`); its build output `dist/` is **generated and gitignored — never commit build output**. A `prepare` script rebuilds `dist/` on every `npm install`. Runnable examples live in `packages/examples`, each served as its own web root by the zero-dependency `serve.mjs` (which aliases `/app.js` to the framework build). Framework runtime dependencies: none — keep it that way.
````

Replace the "Commands" section's command block with:

````markdown
```sh
npm install         # dev deps + builds packages/app.js/dist via prepare
npm run build       # tsc → packages/app.js/dist
npm run typecheck   # all workspaces
npm test            # framework unit suite + examples smoke suite
npm run ex:counter  # serve the counter example on :8123
npm run ex:form     # serve the form example on :8123
npm test -w app.js -- tests/components.test.ts   # single test file
```
````

and in the same section replace the sentence starting "Tests import `../src/app` directly." so the paragraph reads:

````markdown
Framework tests import `../src/app` directly; examples smoke tests drive the built `dist/` over real HTTP via `serve.mjs` + happy-dom's `Browser` (with `enableJavaScriptEvaluation: true`). Convention for newly found bugs: encode each as an `it.fails` case asserting the *desired* behavior (with its issue number in the test name) — once the bug is fixed, that test starts failing; remove the `.fails` modifier as part of the fix. No such markers are currently open.
````

In the **Architecture** section, replace:

> Everything is the `App` class in `src/app.ts`.

with:

> Everything is the `App` class in `packages/app.js/src/app.ts`.

Leave the rest of the Architecture section unchanged. Delete the trailing "To exercise the framework manually…" paragraph of the Commands section (superseded by the examples) if present.

- [ ] **Step 3: Final verification (spec success criteria)**

```bash
rm -rf node_modules packages/app.js/dist
npm install
npm run typecheck && npm test
git ls-files | grep -E '(^|/)dist/|^app\.js$|^app\.d\.ts$' && echo "FAIL" || echo "OK: no build output tracked"
git log --follow --oneline packages/app.js/src/app.ts | tail -3
(npm run ex:counter &) ; sleep 1 ; curl -s http://localhost:8123/ | grep -q 'id="app"' && echo "counter serves OK" ; pkill -f 'serve.mjs counter'
```

Expected: install+build clean; 29 + 2 tests green; `OK: no build output tracked`; the `--follow` log shows pre-move commits (e.g. the original `d44c59d`-era history); `counter serves OK`.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: workspaces layout, quick start, generated-dist policy (#10)"
```

---

### Post-landing controller actions (not implementer steps)

1. Comment on [#6](https://github.com/mellonis/app.js/issues/6): the todo example (deferred from #10 by maintainer decision) should be added under `packages/examples/todo/` as part of the list-rendering branch.
2. Landing (merge/push) and closing #10 remain maintainer decisions.
