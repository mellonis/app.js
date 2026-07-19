# Profile Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `packages/examples/profile/` — a sixth teaching example that isolates one idea: a form control cannot bind to a prop, so an editable child component keeps its own draft.

**Architecture:** A parent owns two strings (`name`, `tagline`). Each is passed to an `editable-field` single-file component as a read-only prop. The child copies the prop into its own `data.draft` at `mounted()`, re-copies whenever the framework fires its `props` event, binds its `<input>` to the draft, and emits `committed` on Save. Cancel restores the draft from the prop. Two instances on one page prove per-instance state.

**Tech Stack:** No new dependencies. Plain HTML + the framework's own template files, served by the existing `serve.mjs`; smoke tested with vitest + happy-dom's `Browser` against the real built `dist/`.

**Spec:** `docs/superpowers/specs/2026-07-19-profile-example-design.md` — BINDING. Spec wins conflicts; report them rather than improvising.

## Global Constraints

- NEVER `git commit` without maintainer authorization.
- No AI attribution anywhere. Published content (README, docs, code comments) stays forge-agnostic — no issue numbers, no hosting URLs.
- Baseline before starting: **297 unit + 7 smoke green**, `npm run typecheck` clean. Nothing existing may flip.
- The framework is untouched. This plan adds **zero** lines under `packages/app.js/src/`.
- **Exactly one new concept.** A parent-level Reset button (plain `data-on-click` + a method) is IN scope — it introduces no new vocabulary and is what makes the `props` re-seed observable. Still out: no `data-disabled-if`, no `data-display-if`, no `data-for`, no validation, no `{field, value}` payload envelope, no per-field ids. Each is explicitly rejected in the spec; adding one is a spec violation, not an improvement.
- Every new assertion must be one a broken implementation could fail. A value that holds whether or not the mechanism works is not a test.
- Port `8237` for the smoke test — 8231–8236 are taken.
- Example naming/formatting follows `packages/examples/cards/`: 4-space indent, `<!doctype html>`, `<title>X — app.js example</title>`.

---

### Task 1: Branch and baseline

**Files:** none.

- [ ] **Step 1: Branch from an up-to-date master**

```bash
cd /Users/mellonis/Developer/mellonis-workspace/app.js
git checkout master && git pull origin master && git checkout -b profile-example
```

- [ ] **Step 2: Record the baseline**

Run: `npm test && npm run typecheck`
Expected: `297 passed` (framework), `7 passed` (examples), tsc silent. Write the numbers down; every later gate compares against them.

---

### Task 2: The example, driven by its smoke test

**Files:**
- Create: `packages/examples/profile/index.html`
- Create: `packages/examples/profile/templates/root.html`
- Create: `packages/examples/profile/templates/editable-field.html`
- Test (create): `packages/examples/tests/profile.smoke.test.ts`
- Modify: `packages/examples/package.json` (scripts), `package.json` (scripts)

**Interfaces:**
- Consumes: the framework's public template vocabulary only — `data-component`, `data-component-prop-<name>`, `data-component-on-<event>`, `data-value`, `data-on-click`, `${}` interpolation, and the reserved `props` event on `this.events`.
- Produces: an example directory `profile` that `serve.mjs` can serve by name, and an `ex:profile` root script.

- [ ] **Step 1: Write the failing smoke test**

Create `packages/examples/tests/profile.smoke.test.ts`:

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('profile', 8237);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

it('keeps an editable child\'s draft separate from the parent\'s value, per instance', async () => {
    const page = browser.newPage();
    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;

    await pollFor(() => document.querySelectorAll('input').length === 2);

    const [nameInput, taglineInput] = [...document.querySelectorAll('input')] as unknown as HTMLInputElement[];
    const preview = document.querySelector('#preview')!;
    // The dirty marker is an interpolation, not a directive — a clean field
    // renders an empty span, so count the ones actually reading "unsaved"
    const dirtyCount = () => [...document.querySelectorAll('.dirty')].filter(el => el.textContent === 'unsaved').length;

    // Seeded from the parent's values through props
    expect(nameInput.value).toBe('Ada Lovelace');
    expect(taglineInput.value).toBe('Mathematician');
    expect(preview.textContent).toBe('Ada Lovelace — Mathematician');

    // Typing moves the DRAFT only: the parent's value is untouched
    nameInput.value = 'Ada King';
    nameInput.dispatchEvent(new windowRealm.Event('input'));
    await pollFor(() => dirtyCount() === 1);
    expect(preview.textContent).toBe('Ada Lovelace — Mathematician');

    // Cancel restores the draft from the prop; the parent never moved
    const [nameCancel] = [...document.querySelectorAll('button')].filter(b => b.textContent === 'Cancel');
    nameCancel.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => nameInput.value === 'Ada Lovelace');
    expect(preview.textContent).toBe('Ada Lovelace — Mathematician');

    // Save commits the draft upward
    nameInput.value = 'Ada King';
    nameInput.dispatchEvent(new windowRealm.Event('input'));
    const [nameSave] = [...document.querySelectorAll('button')].filter(b => b.textContent === 'Save');
    nameSave.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => preview.textContent === 'Ada King — Mathematician');

    // Per-instance state: edit BOTH, cancel one, the other's draft survives.
    // This is the assertion that catches shared state between instances.
    nameInput.value = 'Ada L.';
    nameInput.dispatchEvent(new windowRealm.Event('input'));
    taglineInput.value = 'First programmer';
    taglineInput.dispatchEvent(new windowRealm.Event('input'));
    await pollFor(() => dirtyCount() === 2);

    nameCancel.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => nameInput.value === 'Ada King');

    expect(taglineInput.value).toBe('First programmer');
    expect(dirtyCount()).toBe(1);
});
```

- [ ] **Step 2: Run it and watch it fail for the right reason**

Run: `npm test -w examples -- tests/profile.smoke.test.ts`
Expected: FAIL. `serve.mjs` exits early because `packages/examples/profile/` does not exist — the error surfaces through `startExample`'s `exit` handler as `serve.mjs exited early with code …`. If it fails for any other reason, stop and read it.

- [ ] **Step 3: Create the child component**

Create `packages/examples/profile/templates/editable-field.html`:

```html
<template>
    <input data-value="draft">
    <button data-on-click="commit">Save</button>
    <button data-on-click="cancel">Cancel</button>
    <span class="dirty">${draft === value ? '' : 'unsaved'}</span>
</template>
<style>
    :scope {
        display: flex;
        gap: 0.5rem;
        align-items: center;
    }
</style>
<script>
    export default {
        // A prop is an INPUT: read-only, owned by the parent. A form control
        // needs something writable, so the field keeps its own copy of the
        // text and only tells the parent about it on Save.
        data: () => ({draft: ''}),
        methods: {
            commit() {
                this.events.emit('committed', this.data.draft);
            },
            cancel() {
                this.data.draft = this.props.value;
            },
        },
        mounted() {
            // Seed once at mount, then again whenever the parent sends new
            // props — the framework fires "props" on every re-seed. After a
            // Save the value arriving back is the one just typed, and writing
            // an equal string is suppressed, so the input never re-renders
            // underneath the caret.
            const seedFromProp = () => {
                this.data.draft = this.props.value;
            };

            seedFromProp();
            this.events.on('props', seedFromProp);
        },
    };
</script>
```

- [ ] **Step 4: Create the parent template**

Create `packages/examples/profile/templates/root.html`:

```html
<template>
    <h1>Profile</h1>
    <strong>Name</strong>
    <div data-component="editable-field"
         data-component-prop-value="name"
         data-component-on-committed="saveName"></div>
    <strong>Tagline</strong>
    <div data-component="editable-field"
         data-component-prop-value="tagline"
         data-component-on-committed="saveTagline"></div>
    <p id="preview">${name} — ${tagline}</p>
    <button data-on-click="reset">Reset</button>
</template>
```

- [ ] **Step 5: Create the page**

Create `packages/examples/profile/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Profile — app.js example</title>
</head>
<body>
<div id="app"></div>
<script type="module">
    import Component from '/app.js';

    const defaults = {name: 'Ada Lovelace', tagline: 'Mathematician'};

    new Component({
        element: document.querySelector('#app'),
        data: {name: defaults.name, tagline: defaults.tagline},
        methods: {
            // Each field is wired to its own handler, so the parent already
            // knows which value arrived — no field name travels in the event
            saveName(event) {
                this.data.name = event.detail;
            },
            saveTagline(event) {
                this.data.tagline = event.detail;
            },
            // Restoring both values to their defaults is the only action here
            // that can hand a field a prop value its own draft doesn't already
            // hold — that's the case the child's "props" re-seed listener exists for.
            reset() {
                this.data.name = defaults.name;
                this.data.tagline = defaults.tagline;
            },
        },
    });
</script>
</body>
</html>
```

- [ ] **Step 6: Add the run scripts**

In `packages/examples/package.json`, add to `"scripts"` between `"cards"` and `"registration"`, so script order matches the documented ladder:

```json
    "profile": "node serve.mjs profile",
```

In the root `package.json`, add to `"scripts"` between `"ex:cards"` and `"ex:registration"`:

```json
    "ex:profile": "npm run profile -w examples",
```

- [ ] **Step 7: Run the smoke test to green**

Run: `npm test -w examples -- tests/profile.smoke.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 8: Full gate**

Run: `npm run typecheck && npm test`
Expected: framework `297 passed` unchanged; examples `8 passed` (7 + this one); tsc silent.

- [ ] **Step 9: Verify it in a real browser, not just happy-dom**

Run: `npm run ex:profile`, open `http://localhost:8123/`.
Confirm by hand: both fields seeded; typing in one shows "unsaved" on that row only; Cancel restores it; Save updates the preview line; editing both and cancelling one leaves the other's text intact; Reset restores both fields and the preview to their defaults. `Ctrl-C` when done.

This step exists because happy-dom does not evaluate `@scope`, so the component's `<style>` is only verified by eye.

- [ ] **Step 10: Commit**

```bash
git add packages/examples/profile packages/examples/tests/profile.smoke.test.ts packages/examples/package.json package.json
git commit -m "examples: profile - an editable child keeps its own draft"
```

---

### Task 3: Documentation riders

**Files:**
- Modify: `README.md` (ladder, Quick start, Repository layout)
- Modify: `CLAUDE.md` (examples list)

- [ ] **Step 1: Insert the ladder entry and renumber**

In `README.md`'s "Where to start", insert between `4. **cards**` and the current `5. **registration**`:

```markdown
5. **profile** — an editable child component: a prop flows in, the child keeps
   its own draft of it, and edits flow back out as an event. Two instances of
   one component, each with its own state.
```

Renumber the existing `5. **registration**` entry to `6.`.

- [ ] **Step 2: Add the Quick start line**

In `README.md`'s Quick start block, after the `ex:cards` line:

```sh
npm run ex:profile      # editable child example → http://localhost:8123/
```

- [ ] **Step 3: Update Repository layout**

In `README.md`, the `packages/examples` bullet lists the examples. Change `(`counter/`, `form/`, `todo/`, `cards/`, `registration/`)` to include `profile/` between `cards/` and `registration/`.

- [ ] **Step 4: Update CLAUDE.md's examples list**

In `CLAUDE.md`, "What this is" lists `(`counter/`, `form/`, `todo/`, `cards/`, `registration/`)`. Add `profile/` between `cards/` and `registration/`. Also add the `npm run ex:profile` line to the Commands block, after `ex:cards`.

- [ ] **Step 5: Verify no stale example count anywhere**

Run: `grep -rn "five examples\|5 examples\|counter/\`, \`form" README.md CLAUDE.md docs/`
Expected: every hit lists `profile/`. Fix any that don't.

- [ ] **Step 6: Gate and commit**

Run: `npm test`
Expected: `297 passed` + `8 passed`.

```bash
git add README.md CLAUDE.md
git commit -m "docs: profile example in the ladder"
```

---

## Verification protocol

At the end, all of these must hold:

1. `npm run typecheck` silent.
2. `npm test` → framework **297 passed** (unchanged), examples **8 passed**.
3. `git diff --stat master -- packages/app.js/src` is **EMPTY** — the framework was not touched.
4. `npm run ex:profile` serves and behaves as described in Task 2 Step 9.
5. The example uses no `data-disabled-if`, no `data-for`, and no validation: `grep -rn "data-disabled-if\|data-display-if\|data-for" packages/examples/profile/` returns nothing — `profile` sits before `registration`, which is where all three are introduced.
6. The README ladder numbers run 1–6 with no duplicates.

## Notes for the implementer

- **The `props` event is the load-bearing detail — but it's only observable through Reset.** Without `this.events.on('props', seedFromProp)`, the child seeds once and then ignores the parent forever. That is invisible everywhere except Reset: `cancel()` reads `this.props.value` live through the reactive getter, so a Cancel is never stale, Save or no Save — and every other prop write the parent makes lands a value equal to what the draft already holds, which the ghost's equal-primitive gate suppresses before a re-seed would even show. Reset is the only action that hands a field a prop value its own draft doesn't already hold; the smoke test catches a missing listener there.
- **Do not "improve" the child by binding the prop directly.** `data-value="value"` targeting a prop is a loud framework error by design — that error is the lesson the example exists to teach around.
- **Do not add Save/Cancel disabling.** It is the obvious polish and it is deliberately out of scope; `registration` introduces `data-disabled-if`.
- If a step's code does not work as written, that is a plan bug worth reporting, not something to paper over.
