# Components Implementation Plan (issue #7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Components as child instances — `App`→`Component` rename, single-file components (`data:`-URL ES-module definitions), separate props namespace with one batched `props` event, per-instance `EventTarget` events with the `data-component-on-*` split, `mounted()`/`data-ref`, per-item components, and the todo example rebuilt around a real component.

**Architecture:** `data-component` with a `<script>`-bearing file instantiates a full child `Component` (own ghost, maps, blocks, channels, `AbortController`, `destroy()`); template-only files keep legacy include semantics. Definitions load once per type via `data:`-URL `import()` (cached, frozen). Props live in a getters-only store seeded/re-seeded by the parent (phase 4, `Object.is` gate, one batched `props` event, one child pass). Events ride a dedicated `EventTarget` per instance — never the wrapper, never bubbling.

**Tech Stack:** TypeScript 7 (existing toolchain), vitest 4 + happy-dom (existing), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-13-components-design.md` — **binding, including all five review rounds' folds.** Where this plan and the spec disagree, the spec wins; report the conflict.

## Global Constraints

- **NEVER `git commit` without maintainer authorization** — the controller obtains standing pre-authorization before execution; absent that, every Commit step pauses.
- **No Claude/AI attribution** anywhere.
- Baseline suites: **84 unit + 3 smoke, green** — they must stay green at every task boundary except where a task's brief explicitly renames identifiers in them (Task 2). New tests only add.
- `dist/` stays uncommitted (`prepare` builds it); framework tests import `../src/app`.
- All new instance internals are `#private`. Public surface additions (exactly): `events` (`{emit, on, onParent}`), `props` (getters-only), `refs`; plus the rename (`Component`, `ComponentOptions`, `ComponentMethod` with `this: Component`).
- The one deliberate compat dent (spec §D.6): `data-component` on a form control is a loud error even for includes — everything else template-only keeps byte-identical behavior.
- Issue refs: [#7](https://github.com/mellonis/app.js/issues/7) (this plan; final commit closes it), #18/#12/#13/#6 semantics as cited by the spec.

---

### Task 1: Branch setup

**Files:** none (git only)

**Interfaces:**
- Consumes: clean `master` at `efd90ca` or later
- Produces: branch `issue-7-components`

- [ ] **Step 1:**

```bash
cd /Users/mellonis/Developer/mellonis-workspace/app.js
git checkout master && git pull origin master
git checkout -b issue-7-components
npm test
```

Expected: clean tree, branch created, `84 passed` + `3 passed` (root `npm test` builds first).

---

### Task 2: Rename `App` → `Component`

**Files:**
- Modify: `packages/app.js/src/app.ts`, all 7 files in `packages/app.js/tests/`, `packages/examples/counter/index.html`, `packages/examples/form/index.html`, `packages/examples/todo/index.html`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Produces: `export default class Component`; `ComponentOptions`; `ComponentMethod = (this: Component, event: Event, item?: unknown, index?: number) => void`; ready-rejection message `The component was destroyed` (const `COMPONENT_DESTROYED_MESSAGE`). All later tasks use these names.

- [ ] **Step 1: src/app.ts** — rename: `class App` → `class Component`; `AppOptions` → `ComponentOptions`; `AppMethod` → `ComponentMethod` and change its type to `(this: Component, event: Event, item?: unknown, index?: number) => void`; `APP_DESTROYED_MESSAGE` → `COMPONENT_DESTROYED_MESSAGE` with text `'The component was destroyed'`; every `App.` static self-reference → `Component.`.

  **Typing consequence (do in the same step):** binding strips the `this` parameter, so add `type BoundComponentMethod = (event: Event, item?: unknown, index?: number) => void;`, declare `readonly methods: Readonly<Record<string, BoundComponentMethod>>` (the constructor OPTION stays `Record<string, ComponentMethod>`), and change `#handleEvent`'s call from `this.methods[methodName].apply(null, [event, item, index])` to `this.methods[methodName](event, item, index)` — under `strictBindCallApply`, `apply(null, ...)` on a `this`-typed method is a compile error.

- [ ] **Step 2: tests** — in all `packages/app.js/tests/*.ts`: `import App from '../src/app'` → `import Component from '../src/app'`; every `new App(` → `new Component(`; every `App.` → `Component.`; in `destroy.test.ts` the message assertion → `new Error('The component was destroyed')`. In `tests/helpers.ts`: same import + `Component.clearTemplateCache()`.

- [ ] **Step 3: examples** — in the three `index.html` files: `import App from '/app.js'` → `import Component from '/app.js'`; `new App({` → `new Component({`.

- [ ] **Step 4: docs** — `README.md`: the two Overview mentions of "An App instance"/"App needs to be constructed" → Component phrasing. `CLAUDE.md`: "Everything is the `App` class" paragraph → `Component`; the `destroy()` quote text update.

- [ ] **Step 5: verify + commit**

```bash
npm run typecheck && npm test
grep -rn '\bApp\b' packages/app.js/src packages/app.js/tests packages/examples/*/index.html && echo "LEFTOVER" || echo "clean"
git add -A packages CLAUDE.md README.md
git commit -m "refactor: rename App to Component (#7)"
```

Expected: 84 + 3 green (the smoke suite exercises the renamed class through the real dist); `clean`.

---

### Task 3: Events core — per-instance `EventTarget`

**Files:**
- Modify: `packages/app.js/src/app.ts`
- Test (create): `packages/app.js/tests/events.test.ts`

**Interfaces:**
- Produces: public `events: {emit(name, payload?), on(name, handler), onParent(name, handler)}` (frozen); `#eventTarget: EventTarget` (dedicated instance — NEVER the wrapper, never bubbles); `#parentEventTarget: EventTarget | undefined` (undefined on root; Task 4 wires it for children). `emit('props', ...)` → loud error, nothing dispatched. `on`/`onParent` auto-bind to the instance's own abort signal. Root `onParent` → loud error no-op.

- [ ] **Step 1: failing tests** — `packages/app.js/tests/events.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('events core', () => {
    it('emit/on round-trips a CustomEvent with detail on the own emitter', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint()});
        await app.ready;

        const seen: unknown[] = [];

        app.events.on('ping', event => seen.push(event.detail));
        app.events.emit('ping', {n: 1});

        expect(seen).toEqual([{n: 1}]);
    });

    it('events never reach the DOM (no bubbling, wrapper listeners silent)', async () => {
        stubTemplates({root: '<template></template>'});
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        const domSpy = vi.fn();

        host.addEventListener('ping', domSpy);
        document.body.addEventListener('ping', domSpy);
        app.events.emit('ping');

        expect(domSpy).not.toHaveBeenCalled();
    });

    it("emitting the reserved 'props' name is a loud error and dispatches nothing", async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint()});
        await app.ready;

        const handler = vi.fn();

        app.events.on('props', handler);
        app.events.emit('props', {x: 1});

        expect(handler).not.toHaveBeenCalled();
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('reserved');
    });

    it('onParent on the root is a loud no-op', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint()});
        await app.ready;

        app.events.onParent('anything', vi.fn());

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('parent');
    });

    it('subscriptions die with destroy()', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint()});
        await app.ready;

        const handler = vi.fn();

        app.events.on('ping', handler);
        app.destroy();
        app.events.emit('ping');

        expect(handler).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: RED** — `npm test -w app.js -- tests/events.test.ts` → 5 fail (`events` undefined).

- [ ] **Step 3: implement** — in `src/app.ts`:

Type (module level):

```ts
interface ComponentEvents {
    emit(name: string, payload?: unknown): void;
    on(name: string, handler: (event: CustomEvent) => void): void;
    onParent(name: string, handler: (event: CustomEvent) => void): void;
}

const RESERVED_EVENT_NAME = 'props';
```

Fields + declare:

```ts
    declare readonly events: ComponentEvents;

    readonly #eventTarget = new EventTarget();
    #parentEventTarget: EventTarget | undefined;
```

In the constructor (after the existing `Object.defineProperties` block):

```ts
        const events: ComponentEvents = {
            emit: (name, payload) => {
                if (name === RESERVED_EVENT_NAME) {
                    console.error(`The "${RESERVED_EVENT_NAME}" event name is reserved for the framework`, this.element);

                    return;
                }

                this.#eventTarget.dispatchEvent(new CustomEvent(name, {detail: payload}));
            },
            on: (name, handler) => {
                this.#eventTarget.addEventListener(name, handler as EventListener, {signal: this.#abortController.signal});
            },
            onParent: (name, handler) => {
                if (!this.#parentEventTarget) {
                    console.error('events.onParent: this component has no parent', this.element);

                    return;
                }

                this.#parentEventTarget.addEventListener(name, handler as EventListener, {signal: this.#abortController.signal});
            },
        };

        Object.freeze(events);
        Object.defineProperty(this, 'events', {enumerable: true, value: events});
```

- [ ] **Step 4: GREEN + gate** — `npm test -w app.js` → 89; `npm run typecheck` clean.

- [ ] **Step 5: commit** — `git add packages/app.js && git commit -m "feat: per-instance EventTarget events - emit/on/onParent (#7)"`

---

### Task 4: Definition loading + child instantiation core

**Files:**
- Modify: `packages/app.js/src/app.ts`
- Test (create): `packages/app.js/tests/sfc.test.ts`

**Interfaces:**
- Consumes: Task 3's `#eventTarget`/`#parentEventTarget`; existing `loadTemplate` cache, cycle chain, `#destroyed` gate, `COMPONENT_DESTROYED_MESSAGE`.
- Produces (later tasks rely on): `ComponentDefinition {data?: () => Record<string, unknown>; methods?: Record<string, ComponentMethod>; mounted?: (this: Component) => void | (() => void)}`; `static #loadDefinition(name): Promise<ComponentDefinition | null>` (null = template-only; cached beside templates, eviction-on-failure; `clearTemplateCache()` clears BOTH); `static #instantiate({element, componentName, definition, parent, ancestorChain, propSeeds, propNames, entryRef?}) : Component` via the `#constructionContext` slot; `#childComponents: Set<Component>` + destroy cascade (post-order, before own teardown); `#wireComponentEvents(element, child, entryRef?)` wiring `data-component-on-<event>` with per-wiring controllers chained to BOTH signals; `#mountChildOrInclude(element, chain)` joining the render promise chain; the form-control-wrapper ban (sync, universal); `#definition` and `#initialAncestorChain` instance fields. Props parameters exist but arrive empty until Task 5.

- [ ] **Step 1 (Wave 1 — failing tests):** create `packages/app.js/tests/sfc.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

const COUNTER_SFC = `<template><p>\${label}: \${count}</p><button data-on-click="increment">+</button></template>
<script>
    export default {
        data: () => ({label: 'Count', count: 0}),
        methods: {
            increment() {
                this.data.count += 1;
            },
        },
    };
</script>`;

describe('single-file components', () => {
    it('a script-bearing component mounts as a child with its own state; two instances are independent', async () => {
        stubTemplates({
            root: '<template><div data-component="counter"></div><div data-component="counter"></div></template>',
            counter: COUNTER_SFC,
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        const [a, b] = [...host.querySelectorAll('[data-component="counter"]')];

        expect(a.querySelector('p')?.textContent).toBe('Count: 0');

        (a.querySelector('button') as HTMLButtonElement).click();
        (a.querySelector('button') as HTMLButtonElement).click();

        expect(a.querySelector('p')?.textContent).toBe('Count: 2');
        expect(b.querySelector('p')?.textContent).toBe('Count: 0');
    });

    it('template-only files keep legacy include semantics (shared root data)', async () => {
        stubTemplates({
            root: '<template><div data-component="banner"></div></template>',
            banner: '<template><em>${title}</em></template>',
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {title: 'shared'}});
        await app.ready;

        expect(host.querySelector('em')?.textContent).toBe('shared');

        app.data.title = 'still shared';

        expect(host.querySelector('em')?.textContent).toBe('still shared');
    });

    it('whitespace and comments between </template> and <script> are fine; stray content with a script is not', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="ok"></div><div data-component="bad"></div></template>',
            ok: '<template><i>x</i></template>\n<!-- note -->\n<script>export default {};</script>',
            bad: '<template><i>y</i></template><b>stray</b><script>export default {};</script>',
        });
        const host = mountPoint();
        const app = new Component({element: host});

        await expect(app.ready).rejects.toBeInstanceOf(Error);
        await vi.waitFor(() => {
            expect(host.querySelector('[data-component="ok"] i')?.textContent).toBe('x');
        });
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('bad');
    });

    it('definition validation: non-factory data and broken module code reject that component', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="broken"></div></template>',
            broken: '<template></template><script>export default {data: {shared: true}};</script>',
        });
        const app = new Component({element: mountPoint()});

        await expect(app.ready).rejects.toBeInstanceOf(Error);
    });

    it('a failed definition is evicted so a fixed file retries; clearTemplateCache clears definitions', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><div data-component="late"></div></template>', late: '<template></template><script>export default {data: 5};</script>'});
        const host1 = mountPoint();
        const app1 = new Component({element: host1});

        await expect(app1.ready).rejects.toBeInstanceOf(Error);

        resetTemplateCache();
        stubTemplates({root: '<template><div data-component="late"></div></template>', late: '<template><i>fixed</i></template>'});
        const host2 = mountPoint();
        const app2 = new Component({element: host2});
        await app2.ready;

        expect(host2.querySelector('i')?.textContent).toBe('fixed');
    });

    it('a throwing data() factory rejects that instance construction', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="boom"></div></template>',
            boom: '<template></template><script>export default {data: () => { throw new Error("factory"); }};</script>',
        });
        const app = new Component({element: mountPoint()});

        await expect(app.ready).rejects.toBeInstanceOf(Error);
    });

    it('cycle guard threads through SFC children (a -> b -> a rejected)', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            a: '<template><div data-component="b"></div></template><script>export default {};</script>',
            b: '<template><div data-component="a"></div></template><script>export default {};</script>',
        });
        const app = new Component({element: mountPoint(), componentName: 'a'});

        await expect(app.ready).rejects.toBe('A component cycle was detected during loading');
    });

    it('destroy() cascades post-order into SFC children', async () => {
        stubTemplates({
            root: '<template><div data-component="counter"></div></template>',
            counter: COUNTER_SFC,
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        const button = host.querySelector('button') as HTMLButtonElement;

        app.destroy();
        button.click();

        expect(host.querySelector('p')?.textContent).toBe('Count: 0');
    });

    it('data-component on a form control is a loud error, include or SFC alike', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><select data-component="counter"></select><input data-component="banner"></template>',
            counter: COUNTER_SFC,
            banner: '<template></template>',
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        expect(host.querySelector('select p')).toBeNull();
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('form control');
    });

    it('child emits reach the parent via data-component-on-*; data-component-on-props is a loud error', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const got: unknown[] = [];

        stubTemplates({
            root: '<template><div data-component="pinger" data-component-on-ping="onPing" data-component-on-props="onProps"></div></template>',
            pinger: `<template><button data-on-click="fire">go</button></template>
<script>export default {methods: {fire() { this.events.emit('ping', 42); }}};</script>`,
        });
        const host = mountPoint();
        new Component({
            element: host,
            methods: {
                onPing(event) {
                    got.push((event as CustomEvent).detail);
                },
                onProps() {
                    got.push('never');
                },
            },
        });

        await vi.waitFor(() => {
            expect(host.querySelector('button')).not.toBeNull();
        });

        (host.querySelector('button') as HTMLButtonElement).click();

        expect(got).toEqual([42]);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('props');
    });

    it('a child subscribes to its parent via events.onParent; subscription dies with the child', async () => {
        stubTemplates({
            root: '<template><div data-component="listener"></div></template>',
            listener: `<template><i>\${heard}</i></template>
<script>
    export default {
        data: () => ({heard: 0}),
        mounted() {
            this.events.onParent('tick', () => {
                this.data.heard += 1;
            });
        },
    };
</script>`,
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelector('i')?.textContent).toBe('0');
        });

        app.events.emit('tick');

        expect(host.querySelector('i')?.textContent).toBe('1');
    });

    it('data-component-on-* and component-prop attributes on a template-only include are loud errors', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="banner" data-component-on-x="h" data-component-prop-a="1"></div></template>',
            banner: '<template><em>inc</em></template>',
        });
        const host = mountPoint();
        new Component({element: host, methods: {h() {}}});

        await vi.waitFor(() => {
            expect(host.querySelector('em')?.textContent).toBe('inc');
        });
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('template-only');
    });
});
```

(Note: the `onParent` test uses `mounted()` — implemented in THIS task minimally as the hook call site, full semantics in Task 6; here `mounted` must run for the test to pass, so Task 4 implements the invocation and Task 6 adds cleanup/ordering/error isolation.)

- [ ] **Step 2: RED** — `npm test -w app.js -- tests/sfc.test.ts` → all 12 fail.

- [ ] **Step 3: implement.** In `src/app.ts`:

Module level:

```ts
interface ComponentDefinition {
    data?: () => Record<string, unknown>;
    methods?: Record<string, ComponentMethod>;
    mounted?: (this: Component) => void | (() => void);
}

interface InternalConstruction {
    definition: ComponentDefinition;
    parentEventTarget: EventTarget;
    ancestorChain: string[];
    propSeeds: Record<string, unknown>;
    propNames: string[];
}

const DEFINITION_KEYS = new Set(['data', 'methods', 'mounted']);
```

Statics + fields:

```ts
    static readonly #definitionPromiseMap = new Map<string, Promise<ComponentDefinition | null>>();
    static #constructionContext: InternalConstruction | undefined;

    readonly #childComponents = new Set<Component>();
    #definition: ComponentDefinition | undefined;
    #initialAncestorChain: string[] = [];
```

`clearTemplateCache` gains `Component.#definitionPromiseMap.clear();`.

Definition loading:

```ts
    static #loadDefinition(componentName: string): Promise<ComponentDefinition | null> {
        let promise = Component.#definitionPromiseMap.get(componentName);

        if (!promise) {
            promise = Component.loadTemplate(componentName)
                .then(text => Component.#parseDefinition(componentName, text))
                .catch(error => {
                    Component.#definitionPromiseMap.delete(componentName);

                    return Promise.reject(error);
                });

            Component.#definitionPromiseMap.set(componentName, promise);
        }

        return promise;
    }

    static async #parseDefinition(componentName: string, templateText: string): Promise<ComponentDefinition | null> {
        const divElement = document.createElement('div');

        divElement.innerHTML = templateText;

        const templateElement = divElement.firstChild;

        if (!(templateElement instanceof HTMLTemplateElement)) {
            throw new Error('A component template file must have a <template> element as its first child');
        }

        const meaningfulSiblings: ChildNode[] = [];

        for (let node = templateElement.nextSibling; node; node = node.nextSibling) {
            const ignorable = (node.nodeType === Node.TEXT_NODE && !(node.textContent ?? '').trim())
                || node.nodeType === Node.COMMENT_NODE;

            if (!ignorable) {
                meaningfulSiblings.push(node);
            }
        }

        const scriptElement = meaningfulSiblings.find(node => node instanceof HTMLScriptElement) as HTMLScriptElement | undefined;

        if (!scriptElement) {
            // Template-only: legacy include, stray content tolerated as today
            return null;
        }

        if (meaningfulSiblings.length > 1) {
            throw new Error(`The "${componentName}" component file must contain only <template> and <script>`);
        }

        const moduleUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(scriptElement.textContent ?? '');
        const module = await import(/* @vite-ignore */ moduleUrl);
        const definition = module.default as ComponentDefinition;

        if (definition === null || typeof definition !== 'object') {
            throw new Error(`The "${componentName}" component script must export default a definition object`);
        }

        if (definition.data !== undefined && typeof definition.data !== 'function') {
            throw new Error(`The "${componentName}" definition's data must be a factory — data: () => ({...}) — so instances never share state`);
        }

        if (definition.methods !== undefined && (definition.methods === null || typeof definition.methods !== 'object')) {
            throw new Error(`The "${componentName}" definition's methods must be an object`);
        }

        if (definition.mounted !== undefined && typeof definition.mounted !== 'function') {
            throw new Error(`The "${componentName}" definition's mounted must be a function`);
        }

        Object.keys(definition).forEach(key => {
            if (!DEFINITION_KEYS.has(key)) {
                console.warn(`Unknown key "${key}" in the "${componentName}" component definition`);
            }
        });

        if (definition.methods) {
            Object.freeze(definition.methods);
        }

        return Object.freeze(definition);
    }
```

Constructor changes (top of constructor, before methods binding):

```ts
        const internal = Component.#constructionContext;

        Component.#constructionContext = undefined;

        if (internal) {
            const factory = internal.definition.data;

            data = factory ? factory() : {};
            methods = internal.definition.methods ?? {};

            internal.propNames.forEach(name => {
                if (name in data) {
                    throw new Error(`The "${name}" prop collides with a data key of this component`);
                }
            });

            this.#definition = internal.definition;
            this.#parentEventTarget = internal.parentEventTarget;
            this.#initialAncestorChain = internal.ancestorChain;
        }
```

(Task 5 extends this block for the props store; `internal.propSeeds` is carried but unused here.)

`ready` wiring becomes:

```ts
        Object.defineProperty(this, 'ready', {
            enumerable: true,
            value: this.#loadComponent({parentComponentNameList: this.#initialAncestorChain})
                .then(() => {
                    this.#runMounted();
                }),
        });
```

Minimal `#runMounted` (Task 6 finalizes):

```ts
    #runMounted(): void {
        if (this.#destroyed || !this.#definition?.mounted) {
            return;
        }

        this.#definition.mounted.call(this);
    }
```

Instantiation + wiring:

```ts
    static #instantiate({element, componentName, definition, parent, ancestorChain, propSeeds, propNames, entryRef}: {
        element: HTMLElement;
        componentName: string;
        definition: ComponentDefinition;
        parent: Component;
        ancestorChain: string[];
        propSeeds: Record<string, unknown>;
        propNames: string[];
        entryRef?: ForBlockScopeRef;
    }): Component {
        Component.#constructionContext = {definition, parentEventTarget: parent.#eventTarget, ancestorChain, propSeeds, propNames};

        try {
            const child = new Component({element, componentName});

            parent.#childComponents.add(child);
            parent.#wireComponentEvents(element, child, entryRef);

            return child;
        } finally {
            Component.#constructionContext = undefined;
        }
    }

    #wireComponentEvents(element: HTMLElement, child: Component, entryRef?: ForBlockScopeRef): void {
        Array.from(element.attributes).forEach(attribute => {
            const match = /^data-component-on-(.+)$/.exec(attribute.name);

            if (!match) {
                return;
            }

            const eventName = match[1];
            const methodName = attribute.value;

            if (eventName === RESERVED_EVENT_NAME) {
                console.error('data-component-on-props is not supported — the parent caused those re-seeds', element);

                return;
            }

            // Chained to BOTH lifetimes; the child's own signal fires inside
            // destroy() AFTER the cleanup phase — final-emit guarantee
            const wiring = new AbortController();
            const chain = (signal: AbortSignal) => {
                if (signal.aborted) {
                    wiring.abort();
                } else {
                    signal.addEventListener('abort', () => wiring.abort(), {once: true});
                }
            };

            chain(this.#abortController.signal);
            chain(child.#abortController.signal);

            child.#eventTarget.addEventListener(eventName, event => {
                const entry = entryRef ? entryRef.block.entries.get(entryRef.key) : undefined;

                this.#handleEvent({methodName, event, item: entry?.item, index: entry?.index});
            }, {signal: wiring.signal});
        });
    }
```

`#renderTemplate`'s `[data-component]` sweep is replaced:

```ts
        const subComponentPromiseList = Array.from(documentFragment.querySelectorAll<HTMLElement>('[data-component]')).map(element => {
            if (formControlTagNames.has(element.tagName)) {
                console.error('data-component cannot be placed on a form control', element);

                return Promise.resolve();
            }

            return this.#mountChildOrInclude(element, parentComponentNameList);
        });
```

```ts
    #mountChildOrInclude(element: HTMLElement, parentComponentNameList: string[]): Promise<void> {
        const componentName = element.dataset['component']!;

        return Component.#loadDefinition(componentName).then(definition => {
            if (this.#destroyed) {
                throw new Error(COMPONENT_DESTROYED_MESSAGE);
            }

            if (definition === null) {
                Array.from(element.attributes).forEach(attribute => {
                    if (/^data-component-(on|prop)-/.test(attribute.name)) {
                        console.error(`"${attribute.name}" has no effect on a template-only include`, element);
                    }
                });

                return this.#loadComponent({componentWrapper: element, componentName, parentComponentNameList});
            }

            const child = Component.#instantiate({
                element,
                componentName,
                definition,
                parent: this,
                ancestorChain: parentComponentNameList,
                propSeeds: {},
                propNames: [],
            });

            return child.ready;
        });
    }
```

`destroy()` gains the cascade as its FIRST action after the flag:

```ts
        this.#destroyed = true;
        this.#childComponents.forEach(child => child.destroy());
        this.#childComponents.clear();
        // (Task 6 inserts cleanup here, before the abort)
        this.#abortController.abort();
```

- [ ] **Step 4: GREEN + regression** — `npm test -w app.js` → 101 (89 + 12); typecheck clean. The `ok`/`bad` stray-content test proves the discriminator; the legacy include test proves zero breakage.

- [ ] **Step 5: commit** — `git add packages/app.js && git commit -m "feat: single-file components - definitions, child instances, cascade, event wiring (#7)"`

---

### Task 5: Props — store, seed, batched `props` event

**Files:**
- Modify: `packages/app.js/src/app.ts`
- Test (create): `packages/app.js/tests/props.test.ts`

**Interfaces:**
- Consumes: Task 4's `#instantiate` context (`propSeeds`/`propNames` now real), `#eventTarget`, `#scopeForBinding`, `#runUpdatePass`, `#evaluate` prologue.
- Produces: public `props` (getters-only, `preventExtensions`); `#propsBacking`; parent-side `#propBindings: Map<Component, {bindings: {propName, expression, lastSeeded}[], scopeRef?: ForBlockScopeRef, reportedErrorKinds: Set<string>}>`; `#collectProps(element)` (attribute → `{seeds, names, bindings}` with kebab→camel precision, reserved-identifier and empty-name errors); `#updateProps()` as phase 4 of `#runUpdatePass`; prop keys in the `#evaluate` prologue (declared after data keys, via `this.props`); the input-on-prop wiring ban in the child's `data-value` sweep. Task 7 reuses `#collectProps` + registration with a `scopeRef`.

- [ ] **Step 1 (failing tests):** create `packages/app.js/tests/props.test.ts` — the complete file:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

const GREETER = `<template><p>\${greeting}, \${who}!</p></template>
<script>export default {data: () => ({greeting: 'Hello'})};</script>`;

describe('props', () => {
    it('seeds from parent-scope expressions; expressions see props as bare identifiers', async () => {
        stubTemplates({
            root: '<template><div data-component="greeter" data-component-prop-who="name.toUpperCase()"></div></template>',
            greeter: GREETER,
        });
        const host = mountPoint();
        new Component({element: host, data: {name: 'ada'}});

        await vi.waitFor(() => {
            expect(host.querySelector('p')?.textContent).toBe('Hello, ADA!');
        });
    });

    it('re-seeds on Object.is change with ONE batched props event and ONE child pass', async () => {
        stubTemplates({
            root: '<template><div data-component="pair" data-component-prop-a="x" data-component-prop-b="x + 1"></div></template>',
            pair: `<template><p>\${a}:\${b}</p></template>
<script>
    export default {
        data: () => ({batches: 0}),
        mounted() {
            this.events.on('props', event => {
                this.data.batches += 1;
                this.data.lastKeys = Object.keys(event.detail).sort().join(',');
            });
        },
    };
</script>`,
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {x: 1}});
        await app.ready;

        expect(host.querySelector('p')?.textContent).toBe('1:2');

        app.data.x = 5;

        await vi.waitFor(() => {
            expect(host.querySelector('p')?.textContent).toBe('5:6');
        });
    });

    it('the props event carries {value, previous} per changed prop and only changed props', async () => {
        const seen: unknown[] = [];

        stubTemplates({
            root: '<template><div data-component="watcher" data-component-prop-a="x" data-component-prop-b="&quot;static&quot;"></div></template>',
            watcher: `<template></template>
<script>export default {mounted() { this.events.on('props', event => { window.__seen.push(event.detail); }); }};</script>`,
        });
        (window as unknown as {__seen: unknown[]}).__seen = seen;
        const host = mountPoint();
        const app = new Component({element: host, data: {x: 1}});
        await app.ready;

        app.data.x = 2;

        await vi.waitFor(() => {
            expect(seen).toHaveLength(1);
        });
        expect(seen[0]).toEqual({a: {value: 2, previous: 1}});
    });

    it('NaN converges: a NaN prop does not re-dispatch every pass (Object.is gate)', async () => {
        stubTemplates({
            root: '<template><div data-component="watcher" data-component-prop-n="0 / 0"></div></template>',
            watcher: `<template></template>
<script>export default {mounted() { this.events.on('props', () => { window.__nanEvents += 1; }); }};</script>`,
        });
        (window as unknown as {__nanEvents: number}).__nanEvents = 0;
        const host = mountPoint();
        const app = new Component({element: host, data: {other: 0}});
        await app.ready;

        app.data.other = 1;
        app.data.other = 2;

        expect((window as unknown as {__nanEvents: number}).__nanEvents).toBe(0);
    });

    it('the store is getters-only and non-extensible: child writes throw', async () => {
        const writer = `<template><button data-on-click="hit">w</button></template>
<script>
    export default {
        methods: {
            hit() {
                try {
                    this.props.who = 'nope';
                    window.__wrote = 'no-throw';
                } catch (error) {
                    window.__wrote = 'threw';
                }

                try {
                    this.props.zzz = 5;
                    window.__extended = 'no-throw';
                } catch (error) {
                    window.__extended = 'threw';
                }
            },
        },
    };
</script>`;

        stubTemplates({
            root: '<template><div data-component="writer" data-component-prop-who="&quot;x&quot;"></div></template>',
            writer,
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        (host.querySelector('button') as HTMLButtonElement).click();

        expect((window as unknown as {__wrote: string}).__wrote).toBe('threw');
        expect((window as unknown as {__extended: string}).__extended).toBe('threw');
    });

    it('data/prop collision rejects THAT instance only; the definition cache is untouched', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div id="bad" data-component="greeter" data-component-prop-greeting="\'boom\'"></div><div id="good" data-component="greeter" data-component-prop-who="\'Ada\'"></div></template>',
            greeter: GREETER,
        });
        const host = mountPoint();
        const app = new Component({element: host});

        await expect(app.ready).rejects.toBeInstanceOf(Error);
        await vi.waitFor(() => {
            expect(host.querySelector('#good p')?.textContent).toBe('Hello, Ada!');
        });
        expect(host.querySelector('#bad p')).toBeNull();
    });

    it('reserved-identifier and empty prop names are loud errors, prop skipped', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="greeter" data-component-prop-class="1" data-component-prop-who="\'Ada\'"></div></template>',
            greeter: GREETER,
        });
        const host = mountPoint();
        new Component({element: host});

        await vi.waitFor(() => {
            expect(host.querySelector('p')?.textContent).toBe('Hello, Ada!');
        });
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('class');
    });

    it('a throwing seed leaves undefined; a later undefined evaluation stays silent; the first non-undefined dispatches', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="watcher" data-component-prop-v="maybe.value"></div></template>',
            watcher: `<template><p>\${String(v)}</p></template>
<script>export default {mounted() { this.events.on('props', event => { window.__vEvents.push(event.detail.v); }); }};</script>`,
        });
        (window as unknown as {__vEvents: unknown[]}).__vEvents = [];
        const host = mountPoint();
        const app = new Component({element: host, data: {maybe: null, other: 0}});
        await app.ready;

        app.data.other = 1;

        expect((window as unknown as {__vEvents: unknown[]}).__vEvents).toHaveLength(0);

        app.data.maybe = {value: 7};

        await vi.waitFor(() => {
            expect((window as unknown as {__vEvents: unknown[]}).__vEvents).toEqual([{value: 7, previous: undefined}]);
        });
    });

    it('a persistently throwing prop expression logs once while broken, re-arms after a clean pass (#12 cadence)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="greeter" data-component-prop-who="broken ? boomFn() : name"></div></template>',
            greeter: GREETER,
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {broken: true, name: 'Ada', other: 0}});
        await app.ready;

        const countPropErrors = () => errorSpy.mock.calls.flat().filter(v => typeof v === 'string' && v.includes('prop expression')).length;

        expect(countPropErrors()).toBe(1);

        app.data.other = 1;
        app.data.other = 2;

        expect(countPropErrors()).toBe(1);

        app.data.broken = false;
        app.data.broken = true;

        expect(countPropErrors()).toBe(2);
    });

    it('an <input data-value> rooted at a prop name is a loud wiring error in the child', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="editor" data-component-prop-title="\'t\'"></div></template>',
            editor: `<template><input data-value="title"></template>
<script>export default {};</script>`,
        });
        const host = mountPoint();
        new Component({element: host});

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat().join(' ')).toContain('copy into');
        });
    });

    it('in-place mutation of a prop object does not re-render (replace-only model)', async () => {
        stubTemplates({
            root: '<template><div data-component="greeter" data-component-prop-who="user.name"></div></template>',
            greeter: GREETER,
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {user: {name: 'Ada'}}});
        await app.ready;

        expect(host.querySelector('p')?.textContent).toBe('Hello, Ada!');

        (app.data.user as {name: string}).name = 'Grace';
        app.data.user = app.data.user;

        await vi.waitFor(() => {
            expect(host.querySelector('p')?.textContent).toBe('Hello, Grace!');
        });
    });
});
```

- [ ] **Step 2: RED** — all props tests fail.

- [ ] **Step 3: implement.** In `src/app.ts`:

Module level:

```ts
interface PropBinding {
    propName: string;
    expression: string;
    lastSeeded: unknown;
}

interface PropBindingRecord {
    bindings: PropBinding[];
    scopeRef?: ForBlockScopeRef;
    reportedErrorKinds: Set<string>;
}

const RESERVED_IDENTIFIERS = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await']);

function isValidPropName(name: string): boolean {
    return /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED_IDENTIFIERS.has(name);
}
```

Fields + declare:

```ts
    declare readonly props: Readonly<Record<string, unknown>>;

    #propsBacking: Record<string, unknown> = {};
    readonly #propBindings = new Map<Component, PropBindingRecord>();
```

Constructor: in the `if (internal)` block, after the collision check:

```ts
            this.#propsBacking = {...internal.propSeeds};
```

and after the `events` defineProperty (for ALL instances — root gets an empty frozen view):

```ts
        const propsView: Record<string, unknown> = {};

        (internal ? internal.propNames : []).forEach(name => {
            Object.defineProperty(propsView, name, {
                enumerable: true,
                get: () => this.#propsBacking[name],
            });
        });
        Object.preventExtensions(propsView);
        Object.defineProperty(this, 'props', {enumerable: true, value: propsView});
```

Attribute collection (parent side; Task 7 passes a scope):

```ts
    #collectProps(element: HTMLElement, scope?: Record<string, unknown>): {seeds: Record<string, unknown>; names: string[]; bindings: PropBinding[]} {
        const seeds: Record<string, unknown> = {};
        const names: string[] = [];
        const bindings: PropBinding[] = [];

        Object.keys(element.dataset).forEach(datasetKey => {
            if (!datasetKey.startsWith('componentProp')) {
                return;
            }

            const tail = datasetKey.slice('componentProp'.length);

            if (!tail || !/^[A-Z]/.test(tail)) {
                console.error(`Malformed component prop attribute (expected data-component-prop-<name>)`, element);

                return;
            }

            const propName = tail[0].toLowerCase() + tail.slice(1);

            if (!isValidPropName(propName)) {
                console.error(`"${propName}" is not a usable prop name (reserved or invalid identifier) — prop skipped`, element);

                return;
            }

            const expression = element.dataset[datasetKey]!;
            let value: unknown;

            try {
                value = this.#evaluate({expression, scope});
            } catch (error) {
                console.error(`Can't evaluate the "${expression}" prop expression`, element, error);
                value = undefined;
            }

            seeds[propName] = value;
            names.push(propName);
            bindings.push({propName, expression, lastSeeded: value});
        });

        return {seeds, names, bindings};
    }
```

`#mountChildOrInclude` uses it (replacing `propSeeds: {}, propNames: []`):

```ts
            const {seeds, names, bindings} = this.#collectProps(element);
            const child = Component.#instantiate({
                element,
                componentName,
                definition,
                parent: this,
                ancestorChain: parentComponentNameList,
                propSeeds: seeds,
                propNames: names,
            });

            if (bindings.length) {
                this.#propBindings.set(child, {bindings, reportedErrorKinds: new Set()});
            }

            return child.ready;
```

Phase 4 (`#runUpdatePass` gains `this.#updateProps();` after `#updateValues`):

```ts
    #updateProps(): void {
        this.#propBindings.forEach((record, child) => {
            if (child.#destroyed) {
                return;
            }

            const errorKindsThisPass = new Set<string>();
            const scope = this.#scopeForBinding(record.scopeRef);
            const changes: Record<string, {value: unknown; previous: unknown}> = {};
            let changed = false;

            record.bindings.forEach(binding => {
                let value: unknown;

                try {
                    value = this.#evaluate({expression: binding.expression, scope});
                } catch (error) {
                    const kind = `prop:${binding.propName}`;

                    errorKindsThisPass.add(kind);

                    if (!record.reportedErrorKinds.has(kind)) {
                        record.reportedErrorKinds.add(kind);
                        console.error(`Can't evaluate the "${binding.expression}" prop expression`, child.element, error);
                    }

                    return;
                }

                if (!Object.is(value, binding.lastSeeded)) {
                    changes[binding.propName] = {value, previous: binding.lastSeeded};
                    binding.lastSeeded = value;
                    child.#propsBacking[binding.propName] = value;
                    changed = true;
                }
            });

            record.reportedErrorKinds.forEach(kind => {
                if (!errorKindsThisPass.has(kind)) {
                    record.reportedErrorKinds.delete(kind);
                }
            });

            if (changed) {
                child.#eventTarget.dispatchEvent(new CustomEvent(RESERVED_EVENT_NAME, {detail: changes}));
                child.#runUpdatePass();
            }
        });
    }
```

Prologue (`#evaluate`, after the data-key declarations, before the scope block):

```ts
        Object.keys(this.props).forEach(key => {
            evaluatingCode += `var ${key} = this.props['${key}'];`;
        });
```

Input-on-prop ban (in the root `[data-value]` sweep of `#renderTemplate`, after the checkbox/radio check):

```ts
            const rootIdentifier = /^([A-Za-z_$][\w$]*)/.exec(element.dataset['value']!)?.[1];

            if (rootIdentifier && rootIdentifier in this.props) {
                console.error(`data-value cannot bind the "${rootIdentifier}" prop — props are inputs; copy into data to edit`, element);

                return;
            }
```

`destroy()` gains `this.#propBindings.clear();` among the clears.

- [ ] **Step 4: GREEN + regression** — full unit suite green (101 + 12 = 113); typecheck clean.

- [ ] **Step 5: commit** — `git add packages/app.js && git commit -m "feat: props - getters-only store, batched props event, Object.is gate (#7)"`

---

### Task 6: `mounted()` cleanup + `data-ref`

**Files:**
- Modify: `packages/app.js/src/app.ts`
- Test (create): `packages/app.js/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 4's `#runMounted` stub, destroy cascade ordering comment.
- Produces: `#cleanup` storage + execution in `destroy()` (order: children cascade → cleanup → abort → clears); throwing hook/cleanup isolation (`console.error`, flow continues); destroy-before-mounted never runs the hook; public `refs` (per instance), `[data-ref]` wiring in `#renderTemplate` (duplicates: first wins + loud error), `data-ref` inside `data-for` items → loud error in `#wireItemElement`, refs cleared on destroy.

- [ ] **Step 1 (failing tests):** `packages/app.js/tests/lifecycle.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('mounted() and cleanup', () => {
    it('runs after the subtree mounts; the returned cleanup runs at destroy, before listener abort', async () => {
        const log: string[] = [];

        (window as unknown as {__log: string[]}).__log = log;
        stubTemplates({
            root: '<template><div data-component="hooked" data-component-on-bye="onBye"></div></template>',
            hooked: `<template><i>x</i></template>
<script>
    export default {
        mounted() {
            window.__log.push('mounted:' + (this.refs === undefined ? 'no-refs' : 'refs-ok'));

            return () => {
                window.__log.push('cleanup');
                this.events.emit('bye', 1);
            };
        },
    };
</script>`,
        });
        const host = mountPoint();
        const app = new Component({
            element: host,
            methods: {
                onBye() {
                    (window as unknown as {__log: string[]}).__log.push('parent-heard-bye');
                },
            },
        });
        await app.ready;

        expect(log).toEqual(['mounted:refs-ok']);

        app.destroy();

        expect(log).toEqual(['mounted:refs-ok', 'cleanup', 'parent-heard-bye']);
    });

    it('a throwing mounted() logs and does not break the mount; a throwing cleanup logs and does not break destroy', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({
            root: '<template><div data-component="thrower"></div></template>',
            thrower: `<template><i>alive</i></template>
<script>export default {mounted() { throw new Error('hook'); }};</script>`,
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        expect(host.querySelector('i')?.textContent).toBe('alive');
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('mounted');
        expect(() => app.destroy()).not.toThrow();
    });

    it('destroy before mount settles: mounted never runs', async () => {
        (window as unknown as {__mountedRan: boolean}).__mountedRan = false;
        stubTemplates({
            root: '<template><div data-component="never"></div></template>',
            never: `<template></template>
<script>export default {mounted() { window.__mountedRan = true; }};</script>`,
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = new Component({element: mountPoint()});

        app.destroy();

        await app.ready.catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 0));

        expect((window as unknown as {__mountedRan: boolean}).__mountedRan).toBe(false);
    });
});

describe('data-ref', () => {
    it('populates this.refs by wiring time, available in mounted(); identity survives data-show-if', async () => {
        stubTemplates({
            root: '<template><div data-component="reffy"></div></template>',
            reffy: `<template><p data-ref="para" data-show-if="visible">hi</p><button data-on-click="toggle">t</button></template>
<script>
    export default {
        data: () => ({visible: true}),
        methods: {
            toggle() {
                this.data.visible = !this.data.visible;
                window.__connected = this.refs.para.isConnected;
                window.__text = this.refs.para.textContent;
            },
        },
    };
</script>`,
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        const button = host.querySelector('button') as HTMLButtonElement;

        button.click();

        expect((window as unknown as {__connected: boolean}).__connected).toBe(false);
        expect((window as unknown as {__text: string}).__text).toBe('hi');

        button.click();

        expect((window as unknown as {__connected: boolean}).__connected).toBe(true);
    });

    it('duplicate ref names: first wins, loud error', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><i data-ref="x">one</i><b data-ref="x">two</b></template>'});
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        expect((app.refs.x as HTMLElement).textContent).toBe('one');
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('Duplicate');
    });

    it('data-ref inside a data-for item is a loud error', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id"><i data-ref="bad"></i></li></ul></template>'});
        const host = mountPoint();
        new Component({element: host, data: {items: [{id: 1}]}});

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat().join(' ')).toContain('data-ref');
        });
    });

    it('refs are per instance and cleared on destroy', async () => {
        stubTemplates({root: '<template><i data-ref="only">z</i></template>'});
        const app = new Component({element: mountPoint()});
        await app.ready;

        expect(app.refs.only).toBeDefined();

        app.destroy();

        expect(app.refs.only).toBeUndefined();
    });
});
```

- [ ] **Step 2: RED.**

- [ ] **Step 3: implement.**

Fields + declare:

```ts
    declare readonly refs: Record<string, HTMLElement>;

    #cleanup: (() => void) | undefined;
    readonly #refsBacking: Record<string, HTMLElement> = {};
```

Constructor (with the other defineProperties): `Object.defineProperty(this, 'refs', {enumerable: true, value: this.#refsBacking});`

`#runMounted` final form:

```ts
    #runMounted(): void {
        if (this.#destroyed || !this.#definition?.mounted) {
            return;
        }

        try {
            const result = this.#definition.mounted.call(this);

            if (typeof result === 'function') {
                this.#cleanup = result;
            }
        } catch (error) {
            console.error(`The "${this.componentName}" component's mounted() hook threw`, error);
        }
    }
```

`destroy()` — the cleanup slot (children cascade already first):

```ts
        if (this.#cleanup) {
            try {
                this.#cleanup();
            } catch (error) {
                console.error(`The "${this.componentName}" component's cleanup threw`, error);
            }

            this.#cleanup = undefined;
        }
```

then the abort, then among the clears: `Object.keys(this.#refsBacking).forEach(key => delete this.#refsBacking[key]);`

`#renderTemplate` gains (after the `[data-display-if]` sweep):

```ts
        documentFragment.querySelectorAll<HTMLElement>('[data-ref]').forEach(element => {
            const name = element.dataset['ref']!;

            if (name in this.#refsBacking) {
                console.error(`Duplicate data-ref "${name}" — first wins`, element);

                return;
            }

            this.#refsBacking[name] = element;
        });
```

`#wireItemElement` gains (with the other item bans):

```ts
        [root, ...root.querySelectorAll<HTMLElement>('[data-ref]')].forEach(element => {
            if (element.dataset['ref'] !== undefined) {
                console.error('data-ref inside a data-for block is not supported in v1', element);
            }
        });
```

- [ ] **Step 4: GREEN + regression; commit** — `git add packages/app.js && git commit -m "feat: mounted() with cleanup; data-ref refs (#7)"`

---

### Task 7: Per-item components

**Files:**
- Modify: `packages/app.js/src/app.ts`
- Test (create): `packages/app.js/tests/item-components.test.ts`

**Interfaces:**
- Consumes: everything above; `#extractForBlock`, `#wireItemElement`, `#reconcileBlock` eviction sweep, `ForBlock`/`ForBlockEntry`.
- Produces: extraction ADMITS `[data-component]` in item subtrees (same-element `data-for`+`data-component` stays banned); `ForBlock.ancestorChain` captured at extraction (passed from `#renderTemplate`); `ForBlockEntry.child?: Component`; instantiation at entry creation, gated on resolve by parent-destroyed + entry-liveness (entry identity check — fresh instance on re-add); template-only-in-items → loud error once per entry creation; per-item props via `#collectProps(element, itemScope)` registered with the entry's `scopeRef`; eviction destroys the child and deletes its `#propBindings` record; item-recursion rejected via the captured chain.

- [ ] **Step 1 (failing tests):** `packages/app.js/tests/item-components.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

const ITEM_SFC = `<template><span>\${todo.title}</span><button data-on-click="remove">x</button></template>
<script>
    export default {
        methods: {
            remove() {
                this.events.emit('removed', this.props.todo.id);
            },
        },
    };
</script>`;

const LIST_ROOT = '<template><ul><li data-for="todos" data-key="$item.id"><div data-component="todo-item" data-component-prop-todo="$item" data-component-on-removed="onRemoved"></div></li></ul></template>';

describe('per-item components', () => {
    it('instantiates one child per item with item-scope props; handlers get (event, item, index)', async () => {
        const calls: Array<{detail: unknown; id: unknown; index: unknown}> = [];

        stubTemplates({root: LIST_ROOT, 'todo-item': ITEM_SFC});
        const host = mountPoint();
        const app = new Component({
            element: host,
            data: {todos: [{id: 1, title: 'a'}, {id: 2, title: 'b'}]},
            methods: {
                onRemoved(event, item, index) {
                    calls.push({detail: (event as CustomEvent).detail, id: (item as {id: number}).id, index});
                },
            },
        });
        await app.ready;
        await vi.waitFor(() => {
            expect([...host.querySelectorAll('span')].map(s => s.textContent)).toEqual(['a', 'b']);
        });

        ([...host.querySelectorAll('button')][1] as HTMLButtonElement).click();

        expect(calls).toEqual([{detail: 2, id: 2, index: 1}]);
    });

    it('re-seeds item props on immutable replacement; child reuse for stable keys', async () => {
        stubTemplates({root: LIST_ROOT, 'todo-item': ITEM_SFC});
        const host = mountPoint();
        const app = new Component({element: host, data: {todos: [{id: 1, title: 'a'}]}, methods: {onRemoved() {}}});
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('a');
        });

        const spanBefore = host.querySelector('span');

        app.data.todos = [{id: 1, title: 'A2'}];

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('A2');
        });
        expect(host.querySelector('span')).toBe(spanBefore);
    });

    it('eviction destroys the child; later passes are error-free; re-add creates a fresh instance', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({root: LIST_ROOT, 'todo-item': ITEM_SFC});
        const host = mountPoint();
        const app = new Component({element: host, data: {todos: [{id: 1, title: 'a'}], other: 0}, methods: {onRemoved() {}}});
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelector('span')).not.toBeNull();
        });

        const detachedButton = host.querySelector('button') as HTMLButtonElement;

        app.data.todos = [];
        app.data.other = 1;
        app.data.other = 2;

        detachedButton.click();

        expect(errorSpy).not.toHaveBeenCalled();

        app.data.todos = [{id: 1, title: 'again'}];

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('again');
        });
    });

    it('eviction mid-definition-load abandons silently (nothing constructed, no later errors)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({root: LIST_ROOT, 'todo-item': ITEM_SFC});
        const host = mountPoint();
        const app = new Component({element: host, data: {todos: [{id: 1, title: 'a'}], other: 0}, methods: {onRemoved() {}}});

        // Evict before the (first-ever) definition fetch resolves
        app.data.todos = [];

        await app.ready;
        await new Promise(resolve => setTimeout(resolve, 10));

        app.data.other = 1;

        expect(host.querySelector('span')).toBeNull();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('template-only includes inside items stay banned (loud, once per entry)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({
            root: '<template><ul><li data-for="items" data-key="$item.id"><div data-component="plain"></div></li></ul></template>',
            plain: '<template><em>inc</em></template>',
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1}], other: 0}});
        await app.ready;

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat().join(' ')).toContain('template-only');
        });

        const errorsAfter = errorSpy.mock.calls.length;

        app.data.other = 1;
        app.data.other = 2;

        expect(errorSpy.mock.calls.length).toBe(errorsAfter);
        expect(host.querySelector('em')).toBeNull();
    });

    it('recursion through items is rejected as a cycle (block-captured chain), even on a late pass', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({
            tree: `<template><ul><li data-for="kids" data-key="$item.id"><div data-component="tree" data-component-prop-kids="$item.kids"></div></li></ul></template>
<script>export default {data: () => ({})};</script>`,
            root: '<template><div data-component="tree" data-component-prop-kids="topKids"></div></template>',
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {topKids: []}});
        await app.ready;

        app.data.topKids = [{id: 1, kids: []}];

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat().join(' ')).toContain('cycle');
        });
    });
});
```

(Note the recursion test: `tree`'s definition needs `kids` as a PROP — its own data has no `kids`; expressions see the prop. The root instantiates `tree` at mount; `tree`'s items instantiate `tree` again on a later pass — the block-captured chain contains `tree` → cycle error via the child's `ready` catch.)

- [ ] **Step 2: RED.**

- [ ] **Step 3: implement.**

`ForBlock` gains `ancestorChain: string[];` — `#renderTemplate` passes its `parentComponentNameList` into `#extractForBlock(element, parentComponentNameList)`, stored on the block. `ForBlockEntry` gains `child?: Component;`.

`#extractForBlock`: the subtree-ban check drops `[data-component]` (keep `[data-for]`); the same-element check keeps `data-component`.

`#wireItemElement` gains (after existing wiring; `entryRef` is the `{block, key}` scopeRef it already builds):

```ts
        [root, ...root.querySelectorAll<HTMLElement>('[data-component]')].forEach(element => {
            if (element.dataset['component'] === undefined) {
                return;
            }

            if (formControlTagNames.has(element.tagName)) {
                console.error('data-component cannot be placed on a form control', element);

                return;
            }

            const componentName = element.dataset['component']!;
            const entryAtWiring = block.entries.get(key);

            Component.#loadDefinition(componentName).then(definition => {
                // Liveness gate: same entry object still present, parent alive
                if (this.#destroyed || block.entries.get(key) !== entryAtWiring) {
                    return;
                }

                if (definition === null) {
                    console.error(`A template-only include ("${componentName}") inside a data-for block is not supported — give it a <script> to make it a component`, element);

                    return;
                }

                const itemScope = this.#scopeForBinding(scopeRef);
                const {seeds, names, bindings, failedSeedKinds} = this.#collectProps(element, itemScope);
                const child = Component.#instantiate({
                    element,
                    componentName,
                    definition,
                    parent: this,
                    ancestorChain: [...block.ancestorChain],
                    propSeeds: seeds,
                    propNames: names,
                    entryRef: scopeRef,
                });

                entryAtWiring!.child = child;

                if (bindings.length) {
                    // failedSeedKinds comes from #collectProps (Task 5's Fix 1):
                    // pre-armed kinds prevent double-logging a persisting seed
                    // error on the first pass — thread it, do NOT pass a fresh Set
                    this.#propBindings.set(child, {bindings, scopeRef, reportedErrorKinds: failedSeedKinds});
                }
            }).catch(error => {
                console.error(`Can't load the "${componentName}" component`, element, error);
            });
        });
```

Eviction (in `#reconcileBlock`'s removal sweep, alongside the map deletes):

```ts
                if (entry.child) {
                    this.#propBindings.delete(entry.child);
                    this.#childComponents.delete(entry.child);
                    entry.child.destroy();
                }
```

(`entryAtWiring` note: at wiring time the entry was just created by `#reconcileBlock`; capture it via `block.entries.get(key)` at the TOP of `#wireItemElement` and use identity comparison in the gate — fresh instance on re-add falls out because a re-added key maps to a NEW entry object.)

- [ ] **Step 4: GREEN + full regression** — everything green; typecheck clean.

- [ ] **Step 5: commit** — `git add packages/app.js && git commit -m "feat: per-item components - lifted #6 ban, liveness gates, eviction cascade (#7)"`

---

### Task 8: Examples + docs

**Files:**
- Create: `packages/examples/todo/templates/todo-item.html`
- Modify: `packages/examples/todo/templates/root.html`, `packages/examples/todo/index.html`, `packages/examples/todo/style.css`, `packages/examples/tests/todo.smoke.test.ts`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the complete feature.
- Produces: the todo example rebuilt around a `todo-item` component (props + events + `display: contents`); smoke test exercising real `data:` imports over HTTP (the happy-dom risk probe); docs matching reality.

- [ ] **Step 1: `packages/examples/todo/templates/todo-item.html`**

```html
<template>
    <span data-show-if="!todo.done">${todo.title}</span>
    <s data-show-if="todo.done">${todo.title}</s>
    <button data-on-click="toggle">toggle</button>
    <button data-on-click="remove">remove</button>
</template>
<script>
    export default {
        methods: {
            toggle() {
                this.events.emit('toggled', this.props.todo.id);
            },
            remove() {
                this.events.emit('removed', this.props.todo.id);
            },
        },
    };
</script>
```

- [ ] **Step 2: `root.html`** — the `<li>` becomes:

```html
        <li data-for="todos" data-key="$item.id">
            <div data-component="todo-item"
                 data-component-prop-todo="$item"
                 data-component-on-toggled="toggleTodo"
                 data-component-on-removed="removeTodo"></div>
        </li>
```

- [ ] **Step 3: `index.html`** — `toggleTodo`/`removeTodo` switch to the in-item signature (`event.detail` carries the id; `item` also arrives — use the detail to showcase payloads):

```js
            toggleTodo(event) {
                this.data.todos = this.data.todos.map(todo => todo.id === event.detail ? {...todo, done: !todo.done} : todo);
            },
            removeTodo(event) {
                this.data.todos = this.data.todos.filter(todo => todo.id !== event.detail);
            },
```

- [ ] **Step 4: `style.css`** — append (the long-deferred demo, with the teaching comment):

```css
/* The component wrapper is a real box; make it transparent to the list layout
   so the li's flex children are the component's own elements */
[data-component="todo-item"] {
    display: contents;
}
```

- [ ] **Step 5: smoke test** — in `todo.smoke.test.ts`, the interactions are unchanged (`li button` selectors still match; text assertions identical) — RUN IT FIRST unmodified. If happy-dom's Browser fails on the `data:` module import (the spec's risk register), report DONE_WITH_CONCERNS quoting the exact error and leave the example changes uncommitted for the controller's decision; the framework tasks stand on the unit suite regardless.

- [ ] **Step 6: docs.** ALSO REQUIRED (Task 5 review follow-through): in CLAUDE.md's Reactivity paragraph, extend the escape-hatch sentence — object keys now support the same self-assignment escape hatch as arrays (`data.user = data.user` re-renders after in-place mutation; wholesale replacement still throws, now loudly). `CLAUDE.md`: in "What this is" append the components sentence: "Component files may carry a `<script>` (single-file components) — those mount as child Component instances with their own state, props (`data-component-prop-*`, one-way, batched `props` event), events (`data-component-on-*`, dedicated per-instance `EventTarget`), `mounted()` lifecycle, and `refs`; template-only files remain shared-scope includes." In the Architecture public-surface sentence add `events`, `props`, `refs`. In Directives add: "- `data-component-prop-<name>=\"expr\"` / `data-component-on-<event>=\"method\"` — component inputs and outputs (SFC wrappers only; loud errors on includes)." Update the `clearTemplateCache` mention: "clears the template AND definition caches". `README.md`: add a Components section after the interpolation bullet: SFC file shape (template+script), props/events example (three lines), the CSP note ("`data:` module imports require a CSP without strict script-src — fine for the teaching context"), and the student-trap note ("component events always ride the `data-component-` prefix: `data-on-removed` on a component binds a DOM event that will never fire").

- [ ] **Step 7: full gate + commit**

```bash
npm run typecheck && npm test
git add packages/examples README.md CLAUDE.md
git commit -m "feat: todo-item component example with display:contents; docs (fixes #7)"
```

---

### Task 9: Final gate (verification only, no commit)

```bash
rm -rf node_modules packages/app.js/dist
npm ci
npm run typecheck && npm test
git ls-files | grep -E '(^|/)dist/' && echo FAIL || echo "OK: no build output tracked"
(npm run ex:todo &) ; sleep 2 ; curl -s http://localhost:8123/templates/todo-item.html | grep -q '<script>' && echo "SFC served OK" ; pkill -f 'serve.mjs todo' ; pgrep -f serve.mjs || echo "no stray servers"
```

Expected: clean rebuild; all suites green; no tracked dist; `SFC served OK`; no leaks. Branch ready for the whole-branch review and the maintainer's landing decision.
