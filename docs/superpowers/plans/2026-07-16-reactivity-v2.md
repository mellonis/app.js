# Reactivity v2 Implementation Plan (issue #17)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the coarse re-run-everything pass with per-path dependency tracking and a microtask-batched flush — `updated()` as the single API addition.

**Architecture:** Two phases per spec §K. **Phase A** (Tasks 2–3) builds the graph — ghost path stamping, tracking frames, the subscriber registry, the code-shaped write gate, descendant notification, and a drain loop that runs SYNCHRONOUSLY at write time — so the suite stays nearly green while the graph is proven. **Phase B** (Tasks 4–5) swaps the scheduler to `queueMicrotask`, adds `updated()`/`settle()`, the write-back source set, and runs the wide test migration. The seam is one function (`#scheduleFlush`).

**Tech Stack:** TypeScript 7, vitest 4 + happy-dom (existing), zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-16-reactivity-v2-design.md` — **binding, including both audit rounds' folds.** Spec wins conflicts; report them.

## Global Constraints

- **NEVER `git commit` without maintainer authorization** — controller holds per-plan pre-authorization or pauses per commit.
- **No Claude/AI attribution**; code comments carry substance in prose only (no issue/spec/audit references).
- Baseline: **177 unit + 4 smoke green.** Phase A may flip ONLY behaviors in spec §G classes 2/3 (expected: none — an adjudication step verifies); Phase B's class-1 migration changes timing, NEVER assertion values.
- Public surface delta: exactly `updated(): Promise<void>`. Everything else `#private`.
- `expression.ts` is untouched by this plan (tracking lives in the engine; collection rides ghost getters).
- Framework runtime dependencies: none; `dist/` never committed.

---

### Task 1: Branch setup

- [ ] **Step 1:**

```bash
cd /Users/mellonis/Developer/mellonis-workspace/app.js
git checkout master && git pull origin master
git checkout -b issue-17-reactivity-v2
npm test
```

Expected: clean tree, 177 + 4 green.

---

### Task 2: Phase A core — the graph behind a synchronous flush

**Files:**
- Modify: `packages/app.js/src/app.ts`
- Test (create): `packages/app.js/tests/reactivity.test.ts`

**Interfaces:**
- Produces (Tasks 3–5 rely on these exact names): `type TrackedBinding` (discriminated union, one variant per binding kind, each carrying `dependencies: Set<string>`); `#subscribersByPath: Map<string, Set<TrackedBinding>>`; `#dirtyBindings: Set<TrackedBinding>`; `#activeFrame: Set<string> | null`; `#trackEvaluation(binding, fn)` (frame push/finally-pop/partial-adoption resubscribe); `#resubscribe(binding, next)`; `#notify(path)` (P + descendants); `#scheduleFlush()` (Phase A body: `this.#drain()`); `#drain()` (phase-ordered loop over dirty snapshots, cap 64); ghost/prop getters record into the active frame; the code-shaped setter gate.

- [ ] **Step 1: failing tests** — `packages/app.js/tests/reactivity.test.ts` (Phase-A suite; `settle`/`updated` do not exist yet — everything here asserts synchronously, which Phase A supports):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, settle, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

// `settle` does not exist until Task 4 — Phase A appends must not use it;
// the import line is completed in Task 4's step

describe('dependency tracking (phase A: synchronous flush)', () => {
    it('an unrelated write does not re-evaluate a binding (isolation)', async () => {
        stubTemplates({root: '<template><p>${title |> count}</p><i>${other}</i></template>'});
        const host = mountPoint();
        const calls: string[] = [];
        const count = (value: string) => {
            calls.push(value);

            return value.length;
        };
        const app = new Component({
            element: host,
            data: {title: 'abc', other: 'x'},
            methods: {count: count as never},
        });
        await app.ready;

        expect(host.querySelector('p')?.textContent).toBe('3');
        expect(calls).toEqual(['abc']);

        app.data.other = 'y';

        expect(host.querySelector('i')?.textContent).toBe('y');
        expect(calls).toEqual(['abc']);

        app.data.title = 'defg';

        expect(host.querySelector('p')?.textContent).toBe('4');
        expect(calls).toEqual(['abc', 'defg']);
    });

    it('nested paths track exactly; ancestors never wake', async () => {
        stubTemplates({root: '<template><p>${user.address.city}</p><i>${user.name}</i></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {user: {name: 'Ada', address: {city: 'London'}}}});
        await app.ready;

        (app.data.user as {address: {city: string}}).address.city = 'Turin';

        expect(host.querySelector('p')?.textContent).toBe('Turin');
        expect(host.querySelector('i')?.textContent).toBe('Ada');
    });

    it('self-assign hatches wake descendants (object and mid-chain)', async () => {
        stubTemplates({root: '<template><p>${user.address.city}</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {user: {address: {city: 'London'}}}});
        await app.ready;

        const user = app.data.user as {address: {city: string}};

        user.address.city = 'Oslo';
        app.data.user = app.data.user;

        expect(host.querySelector('p')?.textContent).toBe('Oslo');
    });

    it('the write gate: equal primitives and double-null suppress; equal object/array/function references notify', async () => {
        stubTemplates({root: '<template><p>${n |> spy}</p><i>${maybe |> spyM}</i></template>'});
        const host = mountPoint();
        let nCalls = 0;
        let mCalls = 0;
        const app = new Component({
            element: host,
            data: {n: 1, maybe: null, items: ['a'], user: {x: 1}},
            methods: {
                spy: ((value: number) => { nCalls += 1; return value; }) as never,
                spyM: ((value: unknown) => { mCalls += 1; return String(value); }) as never,
            },
        });
        await app.ready;

        expect(nCalls).toBe(1);
        expect(mCalls).toBe(1);

        app.data.n = 1;
        app.data.maybe = null;

        expect(nCalls).toBe(1);
        expect(mCalls).toBe(1);

        app.data.items = app.data.items;
        app.data.user = app.data.user;

        expect(nCalls).toBe(1);
    });

    it('dynamic dependencies re-collect: flag ? a : b swaps its subscription', async () => {
        stubTemplates({root: '<template><p>${flag ? a : b}</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {flag: true, a: 'A', b: 'B'}});
        await app.ready;

        app.data.b = 'B2';

        expect(host.querySelector('p')?.textContent).toBe('A');

        app.data.flag = false;

        expect(host.querySelector('p')?.textContent).toBe('B2');

        app.data.a = 'A2';

        expect(host.querySelector('p')?.textContent).toBe('B2');

        app.data.b = 'B3';

        expect(host.querySelector('p')?.textContent).toBe('B3');
    });

    it('partial adoption on throw: a tracked guard keeps re-arming', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><p>${broken ? boomFn() : name}</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {broken: true, name: 'ok'}});
        await app.ready;

        expect(errorSpy).toHaveBeenCalled();

        app.data.broken = false;

        expect(host.querySelector('p')?.textContent).toBe('ok');
    });

    it('zero-dependency bindings freeze: pure renders once, a resolve-throw logs once', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><p>${"static"}</p><i>${oops()}</i><b>${live}</b></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {live: 1}});
        await app.ready;

        const errorsAtMount = errorSpy.mock.calls.length;

        expect(errorsAtMount).toBeGreaterThan(0);

        app.data.live = 2;
        app.data.live = 3;

        expect(host.querySelector('b')?.textContent).toBe('3');
        expect(errorSpy.mock.calls.length).toBe(errorsAtMount);
    });

    it('event-time reads subscribe nothing', async () => {
        stubTemplates({root: '<template><button data-on-click="peek">go</button><p>${shown}</p></template>'});
        const host = mountPoint();
        const app = new Component({
            element: host,
            data: {hidden: 'h', shown: 's'},
            methods: {
                peek() {
                    void this.data.hidden;
                },
            },
        });
        await app.ready;

        (host.querySelector('button') as HTMLButtonElement).click();
        app.data.hidden = 'h2';

        expect(host.querySelector('p')?.textContent).toBe('s');
    });

    it('a feedback loop hits the drain cap with a loud error instead of a stack overflow', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><p>${n |> bump}</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {n: 0}});

        Object.assign(app.methods, {});
        const bump = (value: number) => {
            if (value < 1000) {
                app.data.n = value + 1;
            }

            return value;
        };

        stubTemplates({root: '<template><p>${n |> bump}</p></template>'});
        resetTemplateCache();
        const host2 = mountPoint();
        const app2 = new Component({element: host2, data: {n: 0}, methods: {bump: bump as never}});
        await app2.ready;

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('loop');
        void app;
    });
});
```

(Note on the feedback-loop test: the first `app`/`bump` scaffolding above is deliberately reduced by the implementer to ONE clean component whose formatter writes its own dependency — transcribe the INTENT: a formatter that writes `n` while rendering `n` must trigger the cap error. Simplify to a single component; the assertion is the `'loop'` error text. This is the one test in this file where the brief's literal code is a sketch — flag your final shape in the report.)

- [ ] **Step 2: RED** — the isolation, gate, freeze, and cap tests fail against the coarse engine (everything re-evaluates; equal writes render; throws re-log).

- [ ] **Step 3: implement the substrate in `app.ts`.**

New types (module level):

```ts
type TrackedBinding =
    | {kind: 'show'; element: HTMLElement; dependencies: Set<string>}
    | {kind: 'display'; element: HTMLElement; dependencies: Set<string>}
    | {kind: 'value'; element: HTMLElement; dependencies: Set<string>}
    | {kind: 'text'; node: Text; dependencies: Set<string>}
    | {kind: 'block'; block: ForBlock; dependencies: Set<string>}
    | {kind: 'props'; child: Component; dependencies: Set<string>};
```

Each existing entry interface (`ShowIfEntry`, `DisplayIfEntry`, `ValueEntry`, `TextNodeEntry`, `ForBlock`, `PropBindingRecord`) gains `binding: TrackedBinding` (constructed at wiring; the block's own binding lives on the block).

Instance fields:

```ts
    readonly #subscribersByPath = new Map<string, Set<TrackedBinding>>();
    #dirtyBindings = new Set<TrackedBinding>();
    #activeFrame: Set<string> | null = null;
    #drainDepth = 0;
```

Core machinery:

```ts
    #trackEvaluation<T>(binding: TrackedBinding, evaluateFn: () => T): T {
        const previousFrame = this.#activeFrame;
        const frame = new Set<string>();

        this.#activeFrame = frame;

        try {
            return evaluateFn();
        } finally {
            // A throw adopts the partial set collected so far — tracked
            // guards keep re-arming; keeping the old set would orphan
            // every mount-throwing binding
            this.#activeFrame = previousFrame;
            this.#resubscribe(binding, frame);
        }
    }

    #resubscribe(binding: TrackedBinding, next: Set<string>): void {
        binding.dependencies.forEach(path => {
            if (!next.has(path)) {
                this.#subscribersByPath.get(path)?.delete(binding);
            }
        });
        next.forEach(path => {
            if (!binding.dependencies.has(path)) {
                let set = this.#subscribersByPath.get(path);

                if (!set) {
                    set = new Set();
                    this.#subscribersByPath.set(path, set);
                }

                set.add(binding);
            }
        });
        binding.dependencies = next;
    }

    #record(path: string): void {
        this.#activeFrame?.add(path);
    }

    #notify(path: string): void {
        const direct = this.#subscribersByPath.get(path);

        direct?.forEach(binding => this.#dirtyBindings.add(binding));

        const prefix = `${path}.`;

        this.#subscribersByPath.forEach((subscribers, registered) => {
            if (registered.startsWith(prefix)) {
                subscribers.forEach(binding => this.#dirtyBindings.add(binding));
            }
        });

        if (this.#dirtyBindings.size) {
            this.#scheduleFlush();
        }
    }

    #scheduleFlush(): void {
        // Phase A: drain immediately — the scheduler seam Phase B replaces
        this.#drain();
    }

    #drain(): void {
        if (this.#destroyed || this.#drainDepth > 0) {
            return;
        }

        this.#drainDepth = 1;

        try {
            let iterations = 0;

            while (this.#dirtyBindings.size) {
                iterations += 1;

                if (iterations > 64) {
                    console.error('Update feedback loop: a binding keeps dirtying itself (a formatter or handler writes what it reads) — rendering stopped for this batch', this.element);
                    this.#dirtyBindings.clear();

                    break;
                }

                const batch = this.#dirtyBindings;

                this.#dirtyBindings = new Set();

                batch.forEach(binding => {
                    if (binding.kind === 'block') {
                        this.#reconcileTrackedBlock(binding.block);
                    }
                });
                batch.forEach(binding => {
                    if (binding.kind === 'show') {
                        this.#updateOneShowIf(binding.element);
                    }
                });
                batch.forEach(binding => {
                    if (binding.kind === 'display') {
                        this.#updateOneDisplayIf(binding.element);
                    }
                });
                batch.forEach(binding => {
                    if (binding.kind === 'value') {
                        this.#updateOneValue(binding.element);
                    }
                });
                batch.forEach(binding => {
                    if (binding.kind === 'text') {
                        this.#updateOneText(binding.node);
                    }
                });
                batch.forEach(binding => {
                    if (binding.kind === 'props') {
                        this.#reseedChild(binding.child);
                    }
                });
            }
        } finally {
            this.#drainDepth = 0;
        }
    }
```

The `#drainDepth` guard: Phase A's synchronous drain means a write DURING a drain (a props handler) must not recurse — the write lands in the fresh `#dirtyBindings` and the outer while-loop picks it up. (Phase B keeps the same guard for its microtask drain.)

- [ ] **Step 4: thread recording through the ghosts and stores.** `#createGhost` gains a `prefix` parameter (root call: `''`); every getter (primitive AND nested-object) calls `this.#record(path)` where `path = prefix ? prefix + '.' + key : key`; nested recursion passes `path` down. The props view getters call `this.#record('props:' + name)`; the props backing writes in `#updateProps` call `this.#notify('props:' + name)`. Every ghost setter (all branches) applies the gate then notifies:

```ts
                        const suppress = Object.is(currentValue, newValue)
                            && (newValue === null || (typeof newValue !== 'object' && typeof newValue !== 'function'));

                        if (suppress) {
                            return;
                        }
```

then stores and calls `this.#notify(path)` — the `app.#runUpdatePass()` calls in setters are REPLACED by `#notify`. (Object-key setters keep their identity-check throw for wholesale replacement; the self-assign branch reaches `#notify` — an equal object reference passes the gate by the discriminator.)

- [ ] **Step 5: wrap every binding evaluation in its frame.** Split today's phase functions into per-binding forms (`#updateOneShowIf(element)` etc. — each is the existing loop body for one entry, with its `#evaluate` call wrapped: `this.#trackEvaluation(entry.binding, () => this.#evaluate({expression, scope}))`). Wiring-time first evaluations go through the same wrappers (that IS collection; mount stays synchronous — the mount-time `#runUpdatePass()` becomes: mark every binding dirty, `#drain()`). Key expressions and reconcile internals run OUTSIDE any frame (no frame is pushed for them; assert `#activeFrame === null` is restored by the finally). Prop seed/re-seed evaluations in `#collectProps`/`#reseedChild` wrap in the child's `PropBindingRecord.binding` frame. `#updateProps` becomes `#reseedChild(child)` (the per-child body of today's loop — batching semantics inside unchanged: Object.is gates, ONE `props` event, one child trigger).

- [ ] **Step 5b: `#reconcileTrackedBlock` (full form — Task 3 tests it).**

```ts
    #reconcileTrackedBlock(block: ForBlock): void {
        const items = this.#trackEvaluation(block.binding, () => this.#evaluate({expression: block.listExpression}));

        // The existing reconcile body runs UNCHANGED (keyed algorithm, error
        // cadence, generation guard) — items validated exactly as today
        this.#reconcileBlockWith(block, items);

        // Every surviving entry's bindings re-evaluate on ANY reconcile —
        // the array self-assign hatch means "same reference, mutated
        // contents", and $-scope values are untracked, so this is their
        // only wake-up channel
        block.entries.forEach(entry => {
            entry.boundElements.forEach(boundElement => {
                const binding = this.#bindingFor(boundElement);

                if (binding) {
                    this.#dirtyBindings.add(binding);
                }
            });

            if (entry.child) {
                const record = this.#propBindings.get(entry.child);

                if (record) {
                    this.#dirtyBindings.add(record.binding);
                }
            }
        });
    }
```

(`#reconcileBlockWith` is today's `#reconcileBlock` body minus the list-expression
evaluation — extract it so the tracked wrapper owns the frame; `#bindingFor`
looks up the entry object in the existing element/text maps and returns its
`binding`. Key expressions inside remain frameless — the frame closed before
the reconcile body runs.)

- [ ] **Step 6: eviction/destroy unsubscribe.** Every existing eviction path (`#reconcileBlock`'s sweep via `boundElements`, child eviction, `destroy()`'s map clears) additionally calls `this.#resubscribe(binding, new Set())` and `this.#dirtyBindings.delete(binding)` for each evicted binding. `destroy()` clears `#subscribersByPath` and `#dirtyBindings` wholesale.

- [ ] **Step 7: GREEN + Phase-A gate.** `npx vitest run tests/reactivity.test.ts --root packages/app.js` green; then the FULL suite. **Adjudication step:** any existing-test failure must be traced to §G flip class 2 or 3 (equal-value suppression / unrelated-write isolation) — the audits predict ZERO such failures (cadence tests use distinct values; evicted-items tests hold trivially). A failure outside those classes is an implementation bug, not a flip: fix it. Record the adjudication table (test → class or bug → resolution) in the report.

- [ ] **Step 8: commit** — `git add packages/app.js && git commit -m 'feat: per-path dependency tracking behind a synchronous flush (#17)'`

---

### Task 3: Phase A lists and components under tracking

**Files:**
- Modify: `packages/app.js/src/app.ts`, `packages/app.js/tests/reactivity.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's substrate INCLUDING `#reconcileTrackedBlock` (implemented there so Task 2 compiles standalone; this task is its test wave plus fixes).

- [ ] **Step 1 (failing tests, append to reactivity.test.ts):**

```ts
describe('lists under tracking (phase A)', () => {
    it('an unrelated write reconciles nothing (key-expression spy)', async () => {
        stubTemplates({root: '<template><ul><li data-for="items" data-key="keyOf($item)">${$item.label}</li></ul></template>'});
        const host = mountPoint();
        const keyCalls: number[] = [];
        const keyOf = (item: {id: number}) => {
            keyCalls.push(item.id);

            return item.id;
        };
        const app = new Component({
            element: host,
            data: {items: [{id: 1, label: 'a'}], other: 0},
            methods: {keyOf: keyOf as never},
        });
        await app.ready;

        const callsAfterMount = keyCalls.length;

        app.data.other = 1;

        expect(keyCalls.length).toBe(callsAfterMount);
        expect(host.querySelector('li')?.textContent).toBe('a');
    });

    it('the array self-assign hatch drives an in-place item-content update end to end', async () => {
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id">${$item.label}</li></ul></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, label: 'a'}]}});
        await app.ready;

        (app.data.items as Array<{label: string}>)[0].label = 'A2';
        app.data.items = app.data.items;

        expect(host.querySelector('li')?.textContent).toBe('A2');
    });

    it('a per-item prop binding re-seeds via the hatch (empty dependency set)', async () => {
        stubTemplates({
            root: '<template><ul><li data-for="items" data-key="$item.id"><div data-component="label" data-component-prop-item="$item"></div></li></ul></template>',
            label: `<template><span>\${item.text}</span></template>
<script>export default {};</script>`,
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, text: 't1'}]}});
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('t1');
        });

        app.data.items = [{id: 1, text: 't2'}];

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('t2');
        });
    });

    it('a key expression reading outside the item does not re-key until its block reconciles', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><ul><li data-for="items" data-key="prefix + $item.id">${$item.label}</li></ul></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, label: 'a'}], prefix: 'k'}});
        await app.ready;

        app.data.prefix = 'x';

        expect(host.querySelectorAll('li')).toHaveLength(1);
        expect(errorSpy).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: RED where the Task-2 implementation is incomplete; GREEN otherwise** (Task 2 shipped `#reconcileTrackedBlock` in full — these tests VERIFY it; failures here are bugs to fix, and fixes belong to this task), **Step 3: fix what RED exposes**, **Step 4: GREEN + full suite** (same adjudication rule), **Step 5: commit** — `git add packages/app.js && git commit -m 'feat: tracked list blocks - dirty-on-reconcile, frameless keys (#17)'`

---

### Task 4: Phase B — the microtask scheduler, `updated()`, `settle()`

**Files:**
- Modify: `packages/app.js/src/app.ts`, `packages/app.js/tests/helpers.ts`
- Test: `packages/app.js/tests/reactivity.test.ts` (append)

**Interfaces:**
- Produces: `#scheduleFlush` body becomes microtask scheduling; `#pendingFlush: {promise, resolve} | null`; public `updated(): Promise<void>`; write-back pending-sources `#writeBackSources: Set<HTMLElement>` with enrollment (post-assign, only-if-pending) and first-visit consumption in `#updateOneValue`; `settle(app)` in helpers (`await app.updated(); await flush();`).

- [ ] **Step 1 (failing tests, append):**

```ts
describe('batching (phase B)', () => {
    it('two writes coalesce into one flush and one DOM write', async () => {
        stubTemplates({root: '<template><p>${a}:${b}</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {a: 1, b: 2}});
        await app.ready;

        const paragraph = host.querySelector('p')!;
        const observer = new MutationObserver(() => {});

        observer.observe(paragraph, {characterData: true, subtree: true});

        app.data.a = 10;
        app.data.b = 20;

        expect(paragraph.textContent).toBe('1:2');

        await app.updated();

        expect(paragraph.textContent).toBe('10:20');

        const records = observer.takeRecords();

        expect(records.length).toBeLessThanOrEqual(2);
        observer.disconnect();
    });

    it('updated(): same-tick-after-write returns the pending promise; idle and destroyed resolve immediately', async () => {
        stubTemplates({root: '<template><p>${n}</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {n: 1}});
        await app.ready;

        await app.updated();

        app.data.n = 2;

        const pending = app.updated();

        expect(app.updated()).toBe(pending);

        await pending;

        expect(host.querySelector('p')?.textContent).toBe('2');

        app.destroy();
        app.data.n = 3;

        await app.updated();

        expect(host.querySelector('p')?.textContent).toBe('2');
    });

    it('destroy with a flush pending resolves the already-issued promise', async () => {
        stubTemplates({root: '<template><p>${n}</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {n: 1}});
        await app.ready;

        app.data.n = 2;

        const pending = app.updated();

        app.destroy();

        await pending;

        expect(host.querySelector('p')?.textContent).toBe('1');
    });

    it('a write inside updated().then mints a new flush', async () => {
        stubTemplates({root: '<template><p>${n}</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {n: 1}});
        await app.ready;

        app.data.n = 2;
        await app.updated().then(() => {
            app.data.n = 3;
        });
        await app.updated();

        expect(host.querySelector('p')?.textContent).toBe('3');
    });

    it('write-back sources: the typed input is skipped once; a second input on the same path updates', async () => {
        stubTemplates({root: '<template><input id="a" data-value="name"><input id="b" data-value="name"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {name: 'x'}});
        await app.ready;

        const inputA = host.querySelector('#a') as HTMLInputElement;
        const inputB = host.querySelector('#b') as HTMLInputElement;

        inputA.value = 'typed';
        inputA.dispatchEvent(new Event('input'));

        await app.updated();

        expect(inputA.value).toBe('typed');
        expect(inputB.value).toBe('typed');
        expect(app.data.name).toBe('typed');
    });

    it('a gate-suppressed write-back strands nothing: the next programmatic write still renders', async () => {
        stubTemplates({root: '<template><input data-value="name"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {name: 'same'}});
        await app.ready;

        const input = host.querySelector('input') as HTMLInputElement;

        input.value = 'same';
        input.dispatchEvent(new Event('input'));

        await app.updated();

        app.data.name = 'fresh';

        await app.updated();

        expect(input.value).toBe('fresh');
    });

    it('parent flush precedes the child flush; settle covers the chain', async () => {
        stubTemplates({
            root: '<template><div data-component="echo" data-component-prop-text="msg"></div></template>',
            echo: `<template><span>\${text}</span></template>
<script>export default {};</script>`,
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {msg: 'first'}});
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('first');
        });

        app.data.msg = 'second';

        await app.updated();
        // The parent's flush re-seeded the child; the child's own flush is a
        // later microtask — settle covers the chain at any depth
        await settle(app);

        expect(host.querySelector('span')?.textContent).toBe('second');
    });

    it('mount renders synchronously: ready-then-assert needs no updated()', async () => {
        stubTemplates({root: '<template><p>${n}</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {n: 7}});
        await app.ready;

        expect(host.querySelector('p')?.textContent).toBe('7');
    });
});
```

- [ ] **Step 2: RED** (everything renders synchronously in Phase A — the coalescing/pending assertions fail).

- [ ] **Step 3: implement.**

```ts
    #pendingFlush: {promise: Promise<void>; resolve: () => void} | null = null;

    updated(): Promise<void> {
        return this.#pendingFlush?.promise ?? Promise.resolve();
    }

    #scheduleFlush(): void {
        if (this.#pendingFlush) {
            return;
        }

        let resolve!: () => void;
        const promise = new Promise<void>(promiseResolve => {
            resolve = promiseResolve;
        });

        this.#pendingFlush = {promise, resolve};
        queueMicrotask(() => {
            const pending = this.#pendingFlush;

            this.#drain();
            // Clear BEFORE resolving so a write inside .then mints a new flush
            this.#pendingFlush = null;
            pending?.resolve();
        });
    }
```

`#drain()` keeps its body (destroyed gate included). Mount keeps calling `#drain()` directly (synchronous first paint — no scheduling). `destroy()` gains: `const pending = this.#pendingFlush; this.#pendingFlush = null; pending?.resolve();` after the clears. Write-back listener: after a successful `assign`/bare-root write, `if (this.#pendingFlush) { this.#writeBackSources.add(element); }`. `#updateOneValue`: `if (this.#writeBackSources.delete(element)) { return; }` (first-visit consumption). `helpers.ts`:

```ts
export async function settle(app: {updated(): Promise<void>}): Promise<void> {
    await app.updated();
    await flush();
}
```

- [ ] **Step 4: GREEN on reactivity.test.ts.** The FULL suite now fails widely — that is Task 5's job; run only `tests/reactivity.test.ts` + `tests/expression.test.ts` (must stay green: pure module) at this gate.

- [ ] **Step 5: commit** — `git add packages/app.js packages/app.js/tests && git commit -m 'feat: microtask flush, updated(), write-back source set (#17)'`

---

### Task 5: Phase B — the suite migration (flip class 1)

**Files:**
- Modify: every framework test file EXCEPT `expression.test.ts` (which must not change), plus the 4 smoke tests only where they assert DOM synchronously after a runtime write.

**The rules (mechanical, per the spec's §G contract):**
1. After any `app.data.X = …` (or event dispatch that writes) followed by a DOM assertion: insert `await app.updated();` (import `settle` where child components are involved and use `await settle(app);`).
2. NEVER change an assertion value. NEVER remove an assertion.
3. Mount-time assertions after `await app.ready` need nothing.
4. SFC methods that write then read the DOM imperatively (the lifecycle refs test) add `await this.updated()` INSIDE the method — this is the one non-mechanical pattern; there is exactly one instance (`lifecycle.test.ts`, the `toggle` method reading `refs.para.isConnected`).
5. Tests dispatching `input`/`change` events then asserting `app.data` need nothing (stores are synchronous); asserting the OTHER input's `.value` needs the await.
6. Smoke tests use `pollFor`, which already tolerates async — verify each smoke green before touching it; only add explicit settling where a smoke asserts immediately without polling.

- [ ] **Step 1:** migrate file by file in this order, running that file's suite after each: `ghost.test.ts`, `directives.test.ts`, `interpolation.test.ts`, `lists.test.ts`, `templates.test.ts`, `components.test.ts`, `sfc.test.ts`, `props.test.ts`, `item-components.test.ts`, `lifecycle.test.ts`, `destroy.test.ts`, `events.test.ts`, `reactivity.test.ts` (Phase-A blocks gain awaits where they assert post-write DOM). Per-file gate: `npx vitest run tests/<file> --root packages/app.js` green before the next file.
- [ ] **Step 2:** full unit suite green; then the 4 smoke tests (expect minimal or zero edits — `pollFor` absorbs timing).
- [ ] **Step 3:** `npm run typecheck && npm test` — everything green.
- [ ] **Step 4: commit** — `git add packages/app.js packages/examples && git commit -m 'test: suite migration to batched rendering - awaits added, assertion values untouched (#17)'`

---

### Task 6: Docs + the keystroke proof

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `packages/app.js/tests/reactivity.test.ts` (append the §H proof)

- [ ] **Step 1: the §H proof test** (append):

```ts
describe('the keystroke lesson', () => {
    it('typing into an input evaluates only that path\'s subscribers', async () => {
        stubTemplates({root: '<template><input data-value="draft"><p>${draft |> len}</p><ul><li data-for="items" data-key="keyOf($item)">${$item.label}</li></ul></template>'});
        const host = mountPoint();
        let keyEvaluations = 0;
        let lenEvaluations = 0;
        const app = new Component({
            element: host,
            data: {draft: '', items: [{id: 1, label: 'a'}, {id: 2, label: 'b'}]},
            methods: {
                len: ((value: string) => { lenEvaluations += 1; return value.length; }) as never,
                keyOf: ((item: {id: number}) => { keyEvaluations += 1; return item.id; }) as never,
            },
        });
        await app.ready;

        const keysAtMount = keyEvaluations;
        const lensAtMount = lenEvaluations;
        const input = host.querySelector('input') as HTMLInputElement;

        input.value = 'hello';
        input.dispatchEvent(new Event('input'));

        await app.updated();

        expect(host.querySelector('p')?.textContent).toBe('5');
        expect(lenEvaluations).toBe(lensAtMount + 1);
        expect(keyEvaluations).toBe(keysAtMount);
    });
});
```

- [ ] **Step 2: docs** (forge-agnostic prose only). `CLAUDE.md` Reactivity paragraph rewrite: paths and prefixes, the tracking frame, descendant-not-ancestor notification, the write gate with the hatch discriminator, microtask batching + `updated()`, the drain cap, dirty-on-reconcile for items, the zero-dependency freeze, and a teaching note that the coarse engine lives in git history. Public-surface sentence gains `updated()`. `README.md`: a Reactivity section — writes batch into one render per microtask; `await app.updated()` for settled DOM; equal-value writes are free; the self-assign hatches; the refs-in-methods `await this.updated()` idiom.

- [ ] **Step 3:** full gate + commit — `git add packages/app.js CLAUDE.md README.md && git commit -m 'feat: keystroke proof; reactivity docs (fixes #17)'`

---

### Task 7: Final gate (verification only, no commit)

```bash
cd /Users/mellonis/Developer/mellonis-workspace/app.js
rm -rf node_modules packages/app.js/dist
npm ci && npm run typecheck && npm test
git ls-files | grep -E '(^|/)dist/' && echo FAIL || echo "OK: no build output tracked"
(npm run ex:todo >/dev/null 2>&1 &) ; sleep 2 ; curl -s http://localhost:8123/ >/dev/null && echo "example serves" ; pkill -f 'serve.mjs todo' ; echo done
```

Expected: clean rebuild green (unit count grows by the reactivity suite; smoke 4 green); no tracked dist. Branch ready for whole-branch review and the maintainer's landing decision.
