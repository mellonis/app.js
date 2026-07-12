# List Rendering (`data-for` keyed reconciliation) Implementation Plan (issue #6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keyed list rendering (`data-for` + required `data-key`) with `$item`/`$index`/`$array` item scope, replace-only reactive arrays, `(event, item, index)` handlers — plus the todo example and its smoke test.

**Architecture:** `data-for` elements are extracted FIRST in `#renderTemplate` (before all directive sweeps) into anchor-pair blocks; a per-block registry drives a keyed reconciler (`#updateLists`, running before visibility/values in every update pass) that clones/reuses/moves/removes item elements and evicts their bindings. Item scope reaches evaluated code through `this.#evaluationScope` — a `#private` field readable inside direct `eval` (probe-verified), immune to data-key shadowing. Arrays become leaf values in the ghost.

**Tech Stack:** TypeScript 7 (existing toolchain), vitest 4 + happy-dom (existing), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-12-list-rendering-design.md` — binding, including all audit revisions.

## Global Constraints

- **NEVER run `git commit` without maintainer authorization** — the controller obtains standing pre-authorization before execution; absent that, every Commit step pauses for approval.
- **No Claude/AI attribution** anywhere.
- Existing suites must never regress: framework unit tests (29 before this branch) and examples smoke tests (2) stay green at every task boundary; new tests only add.
- `dist/` stays uncommitted (built by `prepare`); tests import `../src/app`.
- All new framework internals are `#private`; the only public-surface change is the `AppMethod` signature widening to `(event: Event, item?: unknown, index?: number) => void`.
- Exact framework behavior is specified by the spec — in particular: extraction-first ordering, required `data-key`, first-wins duplicates with once-while-broken error cadence, source-array `$index`, in-item `<input data-value>` ban, no identity short-circuit on reconcile.
- Issue references: [#6](https://github.com/mellonis/app.js/issues/6) (this plan), [#11](https://github.com/mellonis/app.js/issues/11) (adjacent, out of scope — do NOT fix it here).

---

### Task 1: Branch setup

**Files:** none (git only)

**Interfaces:**
- Consumes: clean `master` at `6042800` or later
- Produces: branch `issue-6-list-rendering`

- [ ] **Step 1: Sync and branch**

```bash
cd /Users/mellonis/Developer/mellonis-workspace/app.js
git checkout master
git pull origin master
git checkout -b issue-6-list-rendering
```

- [ ] **Step 2: Verify**

Run: `git status && git branch --show-current && npm test`
Expected: clean tree, branch `issue-6-list-rendering`, 29 + 2 tests green (root `npm test` builds first).

---

### Task 2: Ghost array leaf (TDD)

**Files:**
- Modify: `packages/app.js/src/app.ts` (the `#createGhost` recursion condition)
- Test: `packages/app.js/tests/ghost.test.ts`

**Interfaces:**
- Consumes: existing ghost (`#createGhost`: recursion for `typeof === 'object'` non-null values)
- Produces: arrays are leaf getter/setter values — readable raw, replace-to-update, never recursed. Task 4's reconciler relies on `app.data.<arrayKey>` returning the raw array and assignment triggering an update pass.

- [ ] **Step 1: Write the failing tests** (append inside `describe('ghost reactivity', ...)` in `packages/app.js/tests/ghost.test.ts`)

```ts
    it('treats arrays as replaceable leaf values (issue #6)', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new App({element: mountPoint(), data: {items: [1, 2]}});
        await flush();

        expect(Array.isArray(app.data.items)).toBe(true);
        expect(app.data.items).toEqual([1, 2]);

        app.data.items = [3];

        expect(app.data.items).toEqual([3]);
    });

    it('does not recurse into arrays nested in objects (issue #6)', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new App({element: mountPoint(), data: {user: {tags: ['a']}}});
        await flush();

        const user = app.data.user as Record<string, unknown>;

        expect(Array.isArray(user.tags)).toBe(true);

        user.tags = ['a', 'b'];

        expect(user.tags).toEqual(['a', 'b']);
    });
```

- [ ] **Step 2: Run to verify RED**

Run: `npm test -w app.js -- tests/ghost.test.ts`
Expected: both new tests FAIL (`Array.isArray(...)` is `false` — today an array is flattened into an index-keyed plain-object ghost; the second may throw on assignment since nested ghost objects are non-writable).

- [ ] **Step 3: Minimal implementation**

In `packages/app.js/src/app.ts`, `#createGhost`, change the recursion condition (one line):

```ts
            if (data[key] !== null && typeof data[key] === 'object' && !Array.isArray(data[key])) {
```

Arrays now fall through to the existing primitive getter/setter branch — that is the whole change.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -w app.js -- tests/ghost.test.ts` → 11 passed. Then `npm test` → all suites green.

- [ ] **Step 5: Commit**

```bash
git add packages/app.js/src/app.ts packages/app.js/tests/ghost.test.ts
git commit -m "feat: treat arrays as replaceable leaf values in the ghost (#6)"
```

---

### Task 3: Infrastructure — update-pass pipeline, scope channel, handler widening

**Files:**
- Modify: `packages/app.js/src/app.ts`

This is a behavior-preserving refactor plus dormant plumbing: the suite must stay green with zero test changes. It exists so Task 4's diff is pure feature.

**Interfaces:**
- Consumes: current `#evaluate`/`#handleEvent`/setter call sites
- Produces (Task 4 relies on these exact names):
  - `#runUpdatePass(sourceElement?: HTMLElement | null): void` — the ONLY way update passes are triggered; currently runs `#updateVisibility()` then `#updateValues(sourceElement)`; Task 4 prepends `#updateLists()`.
  - `#evaluate({expression?, element?, scope?})` — `scope?: Record<string, unknown>`; scope keys are declared AFTER data keys via `this.#evaluationScope` and shadow them.
  - `#evaluationScope: Record<string, unknown> | undefined` — `#private` field, set before `eval`, cleared in `finally`.
  - `#handleEvent({methodName, event, item, index})` — invokes `methods[methodName].apply(null, [event, item, index])`.
  - `type AppMethod = (event: Event, item?: unknown, index?: number) => void;`
  - Module-level consts (hoisted out of `#renderTemplate`, shared with Task 4):
    `const eventNameList = ['click', 'submit'];`
    `const elementsWithDataOnAttributeSelector = ...` and `const dataOnAttributeNameRegExp = ...` (same expressions as today).

- [ ] **Step 1: Widen `AppMethod`** (top of `packages/app.js/src/app.ts`)

```ts
type AppMethod = (event: Event, item?: unknown, index?: number) => void;
```

- [ ] **Step 2: Hoist the event-wiring consts to module level** (below the interfaces, above `export default class App`), deleting the three identical `const` lines inside `#renderTemplate`:

```ts
const eventNameList = ['click', 'submit'];
const elementsWithDataOnAttributeSelector = eventNameList.map(eventName => `[data-on-${eventName}]`).join(',');
const dataOnAttributeNameRegExp = new RegExp(`^data-on-(${eventNameList.join('|')})$`);
```

- [ ] **Step 3: Add the scope channel field** (next to the two `#private` maps):

```ts
    #evaluationScope: Record<string, unknown> | undefined;
```

- [ ] **Step 4: Extend `#evaluate`** — full replacement of the method:

```ts
    #evaluate({expression = null, element = null, scope}: {expression?: string | null; element?: HTMLElement | null; scope?: Record<string, unknown>}): unknown {
        let evaluatingCode = '';

        Object.keys(this.data).forEach(key => {
            evaluatingCode += `var ${key} = this.data['${key}'];`;
        });

        if (scope) {
            // Declared after the data keys so scope names shadow them; reached
            // through this.#evaluationScope because `this` is a keyword and
            // private names are visible in direct eval — no data key can
            // shadow or name this channel
            Object.keys(scope).forEach(key => {
                evaluatingCode += `var ${key} = this.#evaluationScope['${key}'];`;
            });
        }

        if (expression) {
            evaluatingCode += expression;
        } else if (element) {
            const entry = this.#valueElementToDataMap.get(element)!;

            // Rooted at this.data so the assignment hits the ghost setter;
            // a bare `expression = element` would assign the eval-local var
            evaluatingCode += `this.data.${entry.expression} = element;`;
        }

        this.#evaluationScope = scope;

        try {
            return eval(evaluatingCode);
        } finally {
            this.#evaluationScope = undefined;
        }
    }
```

- [ ] **Step 5: Introduce `#runUpdatePass` and route all call sites through it**

Add the method (next to `#updateValues`):

```ts
    #runUpdatePass(sourceElement: HTMLElement | null = null): void {
        this.#updateVisibility();
        this.#updateValues(sourceElement);
    }
```

In `#createGhost`'s setter, replace the update block:

```ts
                        if (isNewValueFromInputElement) {
                            data[key] = newValue.value;
                        } else {
                            data[key] = newValue;
                        }

                        if (isNewValueFromInputElement) {
                            app.#runUpdatePass(newValue);
                        } else {
                            app.#runUpdatePass();
                        }
```

In `#renderTemplate`, replace the post-subcomponent `.then`:

```ts
        return Promise.all(subComponentPromiseList)
            .then(() => {
                this.#runUpdatePass();
            })
            .then(() => documentFragment);
```

- [ ] **Step 6: Widen `#handleEvent`** — full replacement:

```ts
    #handleEvent({methodName, event, item, index}: {methodName: string; event: Event; item?: unknown; index?: number}): void {
        if (this.methods.hasOwnProperty(methodName)) {
            this.methods[methodName].apply(null, [event, item, index]);
        }
    }
```

(The existing `#renderTemplate` listener call site stays `this.#handleEvent({methodName, event})` — `item`/`index` arrive as `undefined`, which existing `(event)`-only methods ignore.)

- [ ] **Step 7: Verify the refactor is invisible**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all suites green with zero test edits; `git diff --stat` touches only `packages/app.js/src/app.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/app.js/src/app.ts
git commit -m "refactor: update-pass pipeline, eval scope channel, widened handler signature (#6)"
```

---

### Task 4: The `data-for` engine (TDD in three waves)

**Files:**
- Modify: `packages/app.js/src/app.ts`
- Test (create): `packages/app.js/tests/lists.test.ts`

**Interfaces:**
- Consumes: everything Task 3 produced, verbatim names.
- Produces: the complete feature per spec — types `ForBlockScopeRef`, `ForBlockEntry`, `ForBlock`; field `#forBlocks: Set<ForBlock>`; methods `#extractForBlock`, `#wireItemElement`, `#scopeForBinding`, `#updateLists`, `#reconcileBlock`; `ShowIfEntry`/`ValueEntry` gain `scopeRef?: ForBlockScopeRef`; `#runUpdatePass` runs `#updateLists()` first; `#renderTemplate` extracts `[data-for]` before all sweeps.

**Full target implementation** (the waves below build up to exactly this; shown complete so any wave can be checked against it):

New/changed type declarations (with the existing interfaces):

```ts
interface ShowIfEntry {
    anchor: Comment;
    expression: string;
    isHidden: boolean;
    scopeRef?: ForBlockScopeRef;
}

interface ValueEntry {
    expression: string;
    scopeRef?: ForBlockScopeRef;
}

interface ForBlockScopeRef {
    block: ForBlock;
    key: string;
}

interface ForBlockEntry {
    element: HTMLElement;
    item: unknown;
    index: number;
    boundElements: HTMLElement[];
}

interface ForBlock {
    anchorStart: Comment;
    anchorEnd: Comment;
    templateElement: HTMLElement;
    listExpression: string;
    keyExpression: string;
    array: unknown[];
    entries: Map<string, ForBlockEntry>;
    reportedDuplicateKeys: Set<string>;
}
```

New field (next to the binding maps):

```ts
    readonly #forBlocks = new Set<ForBlock>();
```

In `#renderTemplate`, IMMEDIATELY after `const documentFragment = templateElement.content;` and BEFORE the `[data-show-if]` sweep:

```ts
        documentFragment.querySelectorAll<HTMLElement>('[data-for]').forEach(element => {
            this.#extractForBlock(element);
        });
```

New methods (all inside the class):

```ts
    #extractForBlock(element: HTMLElement): void {
        if (!element.parentNode) {
            // An ancestor data-for was already extracted or errored away
            return;
        }

        if (element.dataset['showIf'] !== undefined || element.dataset['component'] !== undefined) {
            console.error('data-for cannot be combined with data-show-if or data-component on the same element', element);
            element.remove();

            return;
        }

        const keyExpression = element.dataset['key'];

        if (keyExpression === undefined) {
            console.error('data-for requires a data-key attribute', element);
            element.remove();

            return;
        }

        if (element.querySelector('[data-for], [data-component]') !== null) {
            console.error('data-for blocks cannot contain nested data-for or data-component elements', element);
            element.remove();

            return;
        }

        const anchorStart = document.createComment(' data-for start ');
        const anchorEnd = document.createComment(' data-for end ');
        const listExpression = element.dataset['for']!;

        element.replaceWith(anchorStart, anchorEnd);
        element.removeAttribute('data-for');
        element.removeAttribute('data-key');

        this.#forBlocks.add({
            anchorStart,
            anchorEnd,
            templateElement: element,
            listExpression,
            keyExpression,
            array: [],
            entries: new Map(),
            reportedDuplicateKeys: new Set(),
        });
    }

    #wireItemElement(root: HTMLElement, block: ForBlock, key: string): HTMLElement[] {
        const boundElements: HTMLElement[] = [];
        const scopeRef: ForBlockScopeRef = {block, key};

        [root, ...root.querySelectorAll<HTMLElement>('[data-value]')].forEach(element => {
            if (element.dataset['value'] === undefined) {
                return;
            }

            if (element.tagName === 'INPUT') {
                console.error('An <input data-value> inside a data-for block is not supported', element);

                return;
            }

            this.#valueElementToDataMap.set(element, {expression: element.dataset['value']!, scopeRef});
            boundElements.push(element);
        });

        root.querySelectorAll<HTMLElement>('[data-show-if]').forEach(element => {
            this.#showIfElementToDataMap.set(element, {
                anchor: document.createComment(' an anchor comment '),
                expression: element.dataset['showIf']!,
                isHidden: false,
                scopeRef,
            });
            boundElements.push(element);
        });

        [root, ...root.querySelectorAll<HTMLElement>(elementsWithDataOnAttributeSelector)].forEach(element => {
            Array.from(element.attributes)
                .filter(attribute => dataOnAttributeNameRegExp.exec(attribute.name))
                .forEach(attribute => {
                    const eventName = dataOnAttributeNameRegExp.exec(attribute.name)![1];
                    const methodName = attribute.value;

                    element.addEventListener(eventName, (event) => {
                        const entry = block.entries.get(key);

                        this.#handleEvent({methodName, event, item: entry?.item, index: entry?.index});
                    });
                });
        });

        return boundElements;
    }

    #scopeForBinding(scopeRef: ForBlockScopeRef | undefined): Record<string, unknown> | undefined {
        if (!scopeRef) {
            return undefined;
        }

        const entry = scopeRef.block.entries.get(scopeRef.key);

        if (!entry) {
            return undefined;
        }

        return {$item: entry.item, $index: entry.index, $array: scopeRef.block.array};
    }

    #updateLists(): void {
        this.#forBlocks.forEach(block => {
            let items: unknown;

            try {
                items = this.#evaluate({expression: block.listExpression});
            } catch (error) {
                console.error(`Can't evaluate the "${block.listExpression}" expression`, block.anchorStart, error);

                return;
            }

            if (!Array.isArray(items)) {
                console.error(`The "${block.listExpression}" expression did not produce an array`, block.anchorStart, items);
                items = [];
            }

            this.#reconcileBlock(block, items as unknown[]);
        });
    }

    #reconcileBlock(block: ForBlock, items: unknown[]): void {
        block.array = items;

        const desired: ForBlockEntry[] = [];
        const seenKeys = new Set<string>();
        const duplicateKeysThisPass = new Set<string>();

        items.forEach((item, index) => {
            let key: string;

            try {
                key = String(this.#evaluate({
                    expression: block.keyExpression,
                    scope: {$item: item, $index: index, $array: items},
                }));
            } catch (error) {
                console.error(`Can't evaluate the "${block.keyExpression}" key expression`, block.anchorStart, error);

                return;
            }

            if (seenKeys.has(key)) {
                duplicateKeysThisPass.add(key);

                if (!block.reportedDuplicateKeys.has(key)) {
                    console.error(`Duplicate data-key "${key}" in list`, block.anchorStart);
                    block.reportedDuplicateKeys.add(key);
                }

                return;
            }

            seenKeys.add(key);

            let entry = block.entries.get(key);

            if (entry) {
                entry.item = item;
                entry.index = index;
            } else {
                const element = block.templateElement.cloneNode(true) as HTMLElement;

                entry = {element, item, index, boundElements: []};
                block.entries.set(key, entry);
                entry.boundElements = this.#wireItemElement(element, block, key);
            }

            desired.push(entry);
        });

        block.reportedDuplicateKeys.forEach(key => {
            if (!duplicateKeysThisPass.has(key)) {
                block.reportedDuplicateKeys.delete(key);
            }
        });

        block.entries.forEach((entry, key) => {
            if (!seenKeys.has(key)) {
                entry.boundElements.forEach(boundElement => {
                    this.#valueElementToDataMap.delete(boundElement);
                    this.#showIfElementToDataMap.delete(boundElement);
                });
                entry.element.remove();
                block.entries.delete(key);
            }
        });

        const parent = block.anchorEnd.parentNode!;
        let cursor: ChildNode = block.anchorStart.nextSibling!;

        desired.forEach(entry => {
            if (entry.element === cursor) {
                cursor = cursor.nextSibling!;
            } else {
                parent.insertBefore(entry.element, cursor);
            }
        });
    }
```

`#runUpdatePass` gains the lists phase (replace the method from Task 3):

```ts
    #runUpdatePass(sourceElement: HTMLElement | null = null): void {
        this.#updateLists();
        this.#updateVisibility();
        this.#updateValues(sourceElement);
    }
```

`#updateValues` and `#updateVisibility` resolve scopes (only the `#evaluate` call lines change):

```ts
                    newValue = this.#evaluate({expression: entry.expression, scope: this.#scopeForBinding(entry.scopeRef)});
```

```ts
                shouldBeVisible = !!this.#evaluate({expression: entry.expression, scope: this.#scopeForBinding(entry.scopeRef)});
```

- [ ] **Step 1 (Wave 1 — mount & setup errors): create `packages/app.js/tests/lists.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

const LIST_TEMPLATE = '<template><ul><li data-for="items" data-key="$item.id"><span data-value="$item.label"></span></li></ul></template>';

async function mountList(initialItems: unknown[], template = LIST_TEMPLATE) {
    stubTemplates({root: template});
    const host = mountPoint();
    const app = new App({element: host, data: {items: initialItems, other: 0}});
    await app.ready;

    return {app, host};
}

describe('data-for: mount and setup errors', () => {
    it('renders one clone per item, in order, with zero console errors', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList([{id: 1, label: 'a'}, {id: 2, label: 'b'}]);

        expect([...host.querySelectorAll('li span')].map(el => el.textContent)).toEqual(['a', 'b']);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('renders an empty block for an empty array', async () => {
        const {host} = await mountList([]);

        expect(host.querySelectorAll('li')).toHaveLength(0);
        expect(host.querySelector('ul')).not.toBeNull();
    });

    it('strips data-for and data-key from clones', async () => {
        const {host} = await mountList([{id: 1, label: 'a'}]);
        const li = host.querySelector('li')!;

        expect(li.dataset['for']).toBeUndefined();
        expect(li.dataset['key']).toBeUndefined();
    });

    it('errors and renders nothing when data-key is missing', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList([{id: 1}], '<template><ul><li data-for="items"><span data-value="$item.id"></span></li></ul></template>');

        expect(host.querySelectorAll('li')).toHaveLength(0);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('data-key');
    });

    it('errors when data-for shares an element with data-show-if', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList([{id: 1}], '<template><ul><li data-for="items" data-key="$item.id" data-show-if="other"><span></span></li></ul></template>');

        expect(host.querySelectorAll('li')).toHaveLength(0);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('data-show-if');
    });

    it('errors when the template subtree contains data-component or nested data-for', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList([{id: 1}], '<template><ul><li data-for="items" data-key="$item.id"><div data-component="widget"></div></li></ul></template>');

        expect(host.querySelectorAll('li')).toHaveLength(0);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('nested');
    });

    it('errors and renders empty when the expression is not an array', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList(0 as unknown as unknown[], LIST_TEMPLATE.replace('"items"', '"other"'));

        expect(host.querySelectorAll('li')).toHaveLength(0);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('did not produce an array');
    });

    it('bans <input data-value> inside items but keeps the rest of the item working', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const template = '<template><ul><li data-for="items" data-key="$item.id"><input data-value="$item.label"><span data-value="$item.label"></span></li></ul></template>';
        const {app, host} = await mountList([{id: 1, label: 'a'}], template);

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('input');
        expect(host.querySelector('li span')?.textContent).toBe('a');

        const input = host.querySelector('input')!;

        input.value = 'typed';
        app.data.other = 1;

        expect(input.value).toBe('typed');
    });
});
```

- [ ] **Step 2: Run Wave 1 to verify RED**

Run: `npm test -w app.js -- tests/lists.test.ts`
Expected: all 8 FAIL (no `data-for` support exists; templates render the raw `data-for` element once, scopeless `$item` expressions throw into the #4 guard, etc.).

- [ ] **Step 3: Implement extraction + reconciler core** — add ALL the target implementation shown above (types, `#forBlocks`, extraction sweep in `#renderTemplate`, all five new methods, the `#runUpdatePass` lists phase, the two scope-resolving `#evaluate` call changes).

- [ ] **Step 4: Verify Wave 1 GREEN + no regressions**

Run: `npm test -w app.js` → 8 new + all previous pass. `npm run typecheck` → clean.

- [ ] **Step 5 (Wave 2 — reconciliation): append to `lists.test.ts`**

```ts
describe('data-for: reconciliation', () => {
    it('preserves DOM node identity for stable keys across replacement', async () => {
        const {app, host} = await mountList([{id: 1, label: 'a'}, {id: 2, label: 'b'}]);
        const [first, second] = [...host.querySelectorAll('li')];

        app.data.items = [{id: 1, label: 'a2'}, {id: 2, label: 'b2'}];

        const after = [...host.querySelectorAll('li')];

        expect(after[0]).toBe(first);
        expect(after[1]).toBe(second);
        expect(after.map(li => li.querySelector('span')!.textContent)).toEqual(['a2', 'b2']);
    });

    it('reorders by moving existing nodes, not recreating them', async () => {
        const {app, host} = await mountList([{id: 1, label: 'a'}, {id: 2, label: 'b'}, {id: 3, label: 'c'}]);
        const byLabel = new Map([...host.querySelectorAll('li')].map(li => [li.querySelector('span')!.textContent, li]));

        app.data.items = [{id: 3, label: 'c'}, {id: 1, label: 'a'}, {id: 2, label: 'b'}];

        const after = [...host.querySelectorAll('li')];

        expect(after[0]).toBe(byLabel.get('c'));
        expect(after[1]).toBe(byLabel.get('a'));
        expect(after[2]).toBe(byLabel.get('b'));
    });

    it('appends and prepends without recreating survivors', async () => {
        const {app, host} = await mountList([{id: 2, label: 'b'}]);
        const survivor = host.querySelector('li')!;

        app.data.items = [{id: 1, label: 'a'}, {id: 2, label: 'b'}, {id: 3, label: 'c'}];

        const after = [...host.querySelectorAll('li')];

        expect(after).toHaveLength(3);
        expect(after[1]).toBe(survivor);
        expect(after.map(li => li.querySelector('span')!.textContent)).toEqual(['a', 'b', 'c']);
    });

    it('removes items and stops updating their detached elements', async () => {
        const {app, host} = await mountList([{id: 1, label: 'a'}, {id: 2, label: 'b'}]);
        const removed = host.querySelectorAll('li')[1];

        app.data.items = [{id: 1, label: 'a'}];

        expect(host.querySelectorAll('li')).toHaveLength(1);
        expect(removed.isConnected).toBe(false);

        const detachedSpan = removed.querySelector('span')!;
        const frozenText = detachedSpan.textContent;

        app.data.other = 1;

        expect(detachedSpan.textContent).toBe(frozenText);
    });

    it('self-assignment after an in-place push reconciles (no identity short-circuit)', async () => {
        const {app, host} = await mountList([{id: 1, label: 'a'}]);

        (app.data.items as unknown[]).push({id: 2, label: 'b'});

        expect(host.querySelectorAll('li')).toHaveLength(1);

        app.data.items = app.data.items;

        expect(host.querySelectorAll('li')).toHaveLength(2);
    });

    it('duplicate keys: first wins, error logs once while persisting, relogs after a clean pass', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {app, host} = await mountList([{id: 1, label: 'first'}, {id: 1, label: 'second'}]);

        expect([...host.querySelectorAll('span')].map(s => s.textContent)).toEqual(['first']);
        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.other = 1;

        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.items = [{id: 1, label: 'clean'}];
        app.data.items = [{id: 1, label: 'x'}, {id: 1, label: 'y'}];

        expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('a throwing key expression skips that item, keeps source indexes, and continues', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList([{id: 1, label: 'a'}, null, {id: 3, label: 'c'}]);

        expect([...host.querySelectorAll('span')].map(s => s.textContent)).toEqual(['a', 'c']);
        expect(errorSpy).toHaveBeenCalled();
    });
});
```

- [ ] **Step 6: Run Wave 2**

Run: `npm test -w app.js -- tests/lists.test.ts`
Expected: PASS if Step 3's implementation is correct (this wave verifies it rather than driving new code; any failure here is a reconciler bug — fix `#reconcileBlock`, never the test).

- [ ] **Step 7 (Wave 3 — scope, handlers, integrity): append to `lists.test.ts`**

```ts
describe('data-for: item scope and handlers', () => {
    it('exposes $item, $index (source), and $array to item expressions', async () => {
        const template = '<template><div><p data-for="items" data-key="$item.id"><span data-value="$item.label + \':\' + $index + \'/\' + $array.length"></span></p></div></template>';
        const {host} = await mountList([{id: 1, label: 'a'}, {id: 2, label: 'b'}], template);

        expect([...host.querySelectorAll('span')].map(s => s.textContent)).toEqual(['a:0/2', 'b:1/2']);
    });

    it('re-evaluates last-item detection after append ($array from the registry)', async () => {
        const template = '<template><div><p data-for="items" data-key="$item.id"><em data-show-if="$index === $array.length - 1">last</em><span data-value="$item.label"></span></p></div></template>';
        const {app, host} = await mountList([{id: 1, label: 'a'}], template);

        expect(host.querySelectorAll('em')).toHaveLength(1);

        app.data.items = [...(app.data.items as unknown[]), {id: 2, label: 'b'}];

        const marked = [...host.querySelectorAll('em')];

        expect(marked).toHaveLength(1);
        expect(marked[0].closest('p')!.querySelector('span')!.textContent).toBe('b');
    });

    it('per-item data-show-if toggles with item replacement', async () => {
        const template = '<template><div><p data-for="items" data-key="$item.id"><b data-show-if="$item.done">done</b></p></div></template>';
        const {app, host} = await mountList([{id: 1, done: false}], template);

        expect(host.querySelector('b')).toBeNull();

        app.data.items = [{id: 1, done: true}];

        expect(host.querySelector('b')).not.toBeNull();
    });

    it('handlers receive (event, item, index), correct even after reorder', async () => {
        const received: Array<{item: {id: number}; index: number | undefined}> = [];

        stubTemplates({root: '<template><div><button data-for="items" data-key="$item.id" data-on-click="pick" data-value="$item.label"></button></div></template>'});

        const host = mountPoint();
        const app = new App({
            element: host,
            data: {items: [{id: 1, label: 'a'}, {id: 2, label: 'b'}]},
            methods: {
                pick(event, item, index) {
                    received.push({item: item as {id: number}, index});
                },
            },
        });

        await app.ready;

        const buttonFor = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!;

        buttonFor('a').click();

        expect(received[0].item.id).toBe(1);
        expect(received[0].index).toBe(0);

        app.data.items = [{id: 2, label: 'b'}, {id: 1, label: 'a'}];

        buttonFor('a').click();

        expect(received[1].item.id).toBe(1);
        expect(received[1].index).toBe(1);
    });

    it('handlers outside blocks still receive only a meaningful event', async () => {
        let sawItem: unknown = 'sentinel';

        stubTemplates({root: '<template><button data-on-click="hit">go</button></template>'});

        const host = mountPoint();
        const app = new App({
            element: host,
            methods: {
                hit(event, item) {
                    sawItem = item;
                },
            },
        });

        await app.ready;
        host.querySelector('button')!.click();

        expect(sawItem).toBeUndefined();
    });

    it('template integrity: root-expression data-show-if inside items never corrupts the clone source', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const template = '<template><div><p data-for="items" data-key="$item.id"><em data-show-if="showDetails">details</em></p></div></template>';

        stubTemplates({root: template});

        const host = mountPoint();
        const app = new App({element: host, data: {items: [{id: 1}], showDetails: false}});

        await app.ready;

        expect(host.querySelector('em')).toBeNull();

        app.data.items = [...(app.data.items as unknown[]), {id: 2}];
        app.data.showDetails = true;

        expect(host.querySelectorAll('em')).toHaveLength(2);
        expect(errorSpy).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 8: Run Wave 3 + the whole world**

Run: `npm test -w app.js -- tests/lists.test.ts` → all lists tests pass. Then `npm run typecheck && npm test` → everything green, `pgrep -f serve.mjs` empty.

- [ ] **Step 9: Commit**

```bash
git add packages/app.js/src/app.ts packages/app.js/tests/lists.test.ts
git commit -m "feat: data-for keyed list rendering with \$item/\$index/\$array scope (#6)"
```

---

### Task 5: Docs

**Files:**
- Modify: `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: the shipped feature semantics from Task 4
- Produces: docs matching reality; Task 6's example follows these documented idioms.

- [ ] **Step 1: CLAUDE.md — extend the Directives list** (in Architecture, after the `data-on-click` bullet) with:

```markdown
- `data-for="expr"` + required `data-key="expr"` — keyed list rendering. The element is the per-item template (replaced by an anchor-comment pair); clones are reconciled by `String(key)`: reuse/move/remove, first duplicate wins (the duplicate error logs once while it persists, again after a clean pass re-breaks). Item expressions see `$item`, `$index` (source-array index), `$array` (the list evaluated this pass). Not combinable with `data-show-if`/`data-component` on the same element; no nested `data-for`/`data-component` in the block; no `<input data-value>` inside items — all loud setup errors. Handlers inside items are invoked as `method(event, item, index)`, resolved at event time.
```

- [ ] **Step 2: CLAUDE.md — amend the Reactivity paragraph**: replace the sentence `each object key recurses into a nested ghost.` with:

```markdown
each object key recurses into a nested ghost; arrays are leaf values — replace them to update (`data.todos = [...data.todos, x]`; `push` alone doesn't trigger, and `data.todos = data.todos` is the sanctioned escape hatch after in-place mutation).
```

- [ ] **Step 3: README — add two Overview bullets** (after the template-retry bullet):

```markdown
- Lists render with `data-for` (a bare array expression) plus a required `data-key`; item expressions see `$item`, `$index`, `$array`
- Arrays update by replacement: `todos = [...todos, item]` — prefer copy-based expressions like `todos.filter(...)` / `[...todos].sort(...)`
```

and extend the Quick start command list with:

```markdown
npm run ex:todo    # todo example → http://localhost:8123/
```

- [ ] **Step 4: Verify docs claims against reality**

Run: `grep -n 'ex:todo' package.json || echo "ex:todo script not yet present (added in Task 6) - expected"`
(The README mentions `ex:todo` one task early; Task 6 adds the script. Acceptable inside one branch — CI only runs on the completed branch.)

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: data-for directive, array model, item scope names (#6)"
```

---

### Task 6: Todo example + smoke test

**Files:**
- Create: `packages/examples/todo/index.html`, `packages/examples/todo/templates/root.html`, `packages/examples/todo/style.css`
- Create: `packages/examples/tests/todo.smoke.test.ts`
- Modify: `packages/examples/package.json` (add `"todo": "node serve.mjs todo"` to scripts), root `package.json` (add `"ex:todo": "npm run todo -w examples"` to scripts)

**Interfaces:**
- Consumes: the framework feature (Task 4), `serve.mjs` contract, smoke helpers (`startExample`/`stopExample`/`pollFor`), port 8233 (8231/8232 are taken).
- Produces: the third runnable example; the plan's last commit closes #6.

- [ ] **Step 1: `packages/examples/todo/templates/root.html`**

```html
<template>
    <h1>Todos</h1>
    <form data-on-submit="addTodo">
        <input data-value="draft" placeholder="What needs doing?">
        <button type="submit">Add</button>
    </form>
    <p data-show-if="todos.length === 0">Nothing to do — add the first task.</p>
    <ul data-show-if="todos.length > 0">
        <li data-for="todos" data-key="$item.id">
            <span data-show-if="!$item.done" data-value="$item.title"></span>
            <s data-show-if="$item.done" data-value="$item.title"></s>
            <button data-on-click="toggleTodo">toggle</button>
            <button data-on-click="removeTodo">remove</button>
        </li>
    </ul>
</template>
```

- [ ] **Step 2: `packages/examples/todo/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Todo — app.js example</title>
    <link rel="stylesheet" href="/style.css">
</head>
<body>
<div id="app"></div>
<script type="module">
    import App from '/app.js';

    new App({
        element: document.querySelector('#app'),
        data: {draft: '', nextId: 1, todos: []},
        methods: {
            addTodo(event) {
                event.preventDefault();

                const title = this.data.draft.trim();

                if (!title) {
                    return;
                }

                this.data.todos = [...this.data.todos, {id: this.data.nextId, title, done: false}];
                this.data.nextId += 1;
                this.data.draft = '';
            },
            toggleTodo(event, item) {
                this.data.todos = this.data.todos.map(todo => todo.id === item.id ? {...todo, done: !todo.done} : todo);
            },
            removeTodo(event, item) {
                this.data.todos = this.data.todos.filter(todo => todo.id !== item.id);
            },
        },
    });
</script>
</body>
</html>
```

- [ ] **Step 3: `packages/examples/todo/style.css`**

```css
body {
    font-family: system-ui, sans-serif;
    max-width: 28rem;
    margin: 2rem auto;
}

form {
    display: flex;
    gap: 0.5rem;
}

form input {
    flex: 1;
}

ul {
    padding: 0;
}

li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
    list-style: none;
}

li span,
li s {
    flex: 1;
}

s {
    color: gray;
}
```

- [ ] **Step 4: Wire the scripts**

`packages/examples/package.json` scripts gain (after `"form"`): `"todo": "node serve.mjs todo",`
Root `package.json` scripts gain (after `"ex:form"`): `"ex:todo": "npm run todo -w examples",`

- [ ] **Step 5: Manual verify**

```bash
node packages/examples/serve.mjs todo 8125 &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8125/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8125/style.css
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8125/templates/root.html
kill $SERVER_PID
```

Expected: `200` three times.

- [ ] **Step 6: `packages/examples/tests/todo.smoke.test.ts`**

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('todo', 8233);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

it('adds, toggles, and removes todos through the real built framework', async () => {
    const page = browser.newPage();

    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;

    await pollFor(() => document.querySelector('form') !== null);
    expect(document.querySelector('p')?.textContent).toContain('Nothing to do');

    const input = document.querySelector('input')!;
    const form = document.querySelector('form')!;

    const add = async (title: string) => {
        input.value = title;
        input.dispatchEvent(new windowRealm.Event('input'));
        form.dispatchEvent(new windowRealm.Event('submit'));
        await pollFor(() => [...document.querySelectorAll('li')].some(li => li.textContent!.includes(title)));
    };

    await add('Learn keys');
    expect(document.querySelector('li span')?.textContent).toBe('Learn keys');
    expect(input.value).toBe('');

    await add('Ship v1');
    expect(document.querySelectorAll('li')).toHaveLength(2);

    const buttonIn = (index: number, label: string) =>
        [...document.querySelectorAll('li')[index].querySelectorAll('button')].find(b => b.textContent === label)!;

    buttonIn(0, 'toggle').click();
    await pollFor(() => document.querySelector('li s') !== null);
    expect(document.querySelector('li s')?.textContent).toBe('Learn keys');

    buttonIn(1, 'remove').click();
    await pollFor(() => document.querySelectorAll('li').length === 1);
    expect(document.querySelector('li s')?.textContent).toBe('Learn keys');
});
```

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npm test`
Expected: framework suite 52 passed (29 pre-branch + 2 ghost + 21 lists), smoke 3 passed (counter, form, todo) — all green; `pgrep -f serve.mjs` empty.

- [ ] **Step 8: Commit**

```bash
git add packages/examples packages/examples/package.json package.json
git commit -m "feat: todo example exercising keyed lists (fixes #6)"
```

---

### Task 7: Final gate

**Files:** none (verification only)

- [ ] **Step 1: Full clean-state gate**

```bash
rm -rf node_modules packages/app.js/dist
npm ci
npm run typecheck
npm test
git ls-files | grep -E '(^|/)dist/' && echo "FAIL" || echo "OK: no build output tracked"
(npm run ex:todo &) ; sleep 1 ; curl -s http://localhost:8123/ | grep -q 'id="app"' && echo "todo serves OK" ; pkill -f 'serve.mjs todo'
```

Expected: install rebuilds dist via `prepare`; typecheck clean; all suites green; `OK: no build output tracked`; `todo serves OK`.

- [ ] **Step 2: Report** — no commit; the branch is ready for the maintainer's landing decision (final whole-branch review runs first, per the controller's process).

### Post-landing controller actions (not implementer steps)

1. #6 auto-closes via Task 6's `fixes #6` on merge to master.
2. The `display: contents` demo remains deferred to #7 per the spec's §G correction.
