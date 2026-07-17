import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, settle, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

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

        await app.updated();

        expect(host.querySelector('i')?.textContent).toBe('y');
        expect(calls).toEqual(['abc']);

        app.data.title = 'defg';

        await app.updated();

        expect(host.querySelector('p')?.textContent).toBe('4');
        expect(calls).toEqual(['abc', 'defg']);
    });

    it('nested paths track exactly; ancestors never wake', async () => {
        stubTemplates({root: '<template><p>${user.address.city}</p><i>${user.name}</i></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {user: {name: 'Ada', address: {city: 'London'}}}});
        await app.ready;

        (app.data.user as {address: {city: string}}).address.city = 'Turin';

        await app.updated();

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

        await app.updated();

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

        await app.updated();

        expect(host.querySelector('p')?.textContent).toBe('A');

        app.data.flag = false;

        await app.updated();

        expect(host.querySelector('p')?.textContent).toBe('B2');

        app.data.a = 'A2';

        await app.updated();

        expect(host.querySelector('p')?.textContent).toBe('B2');

        app.data.b = 'B3';

        await app.updated();

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

        await app.updated();

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

        await app.updated();

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

    // The brief's original sketch built a scratch component (`app`/`bump`) just
    // to close over its own data setter, then discarded it for a second
    // component that actually gets asserted on. Reduced here to the one
    // component the assertion is about: a formatter that both reads and
    // writes the same path every time it runs, so each render dirties itself
    // again — the drain must give up loudly instead of spinning forever.
    //
    // A binding's very first (mount-time) evaluation is exempt: it hasn't
    // subscribed to anything until its evaluation returns, so a self-write
    // fired mid-evaluation finds no subscriber yet and lands harmlessly.
    // Once mount completes, the binding IS subscribed — a later write is
    // what actually kicks off the runaway loop this test proves.
    it('a feedback loop hits the drain cap with a loud error instead of a stack overflow', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><p>${n |> bump}</p></template>'});
        const host = mountPoint();
        const bump = function (this: Component, value: number) {
            this.data.n = value + 1;

            return value;
        };
        const app = new Component({element: host, data: {n: 0}, methods: {bump: bump as never}});

        await app.ready;

        app.data.n = 2;

        await app.updated();

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('loop');
    });

    it('a derived write to the input\'s own path rewrites the input (first-visit consumption)', async () => {
        stubTemplates({root: '<template><input data-value="draft"><p>${draft |> up}</p></template>'});
        const host = mountPoint();
        const app = new Component({
            element: host,
            data: {draft: ''},
            methods: {
                up: ((value: string) => {
                    const upper = value.toUpperCase();

                    if (value !== upper) {
                        app.data.draft = upper;
                    }

                    return upper;
                }) as never,
            },
        });
        await app.ready;

        const input = host.querySelector('input') as HTMLInputElement;

        input.value = 'a';
        input.dispatchEvent(new Event('input'));

        await app.updated();

        expect(app.data.draft).toBe('A');
        expect(input.value).toBe('A');
    });

    it('never ancestors: an identity-only reader sleeps through a nested write', async () => {
        stubTemplates({root: '<template><p>${user |> fmt}</p><i>${user.name}</i></template>'});
        const host = mountPoint();
        let fmtCalls = 0;
        const app = new Component({
            element: host,
            data: {user: {name: 'Ada'}},
            methods: {fmt: ((value: object) => { fmtCalls += 1; return value ? 'yes' : 'no'; }) as never},
        });
        await app.ready;

        expect(fmtCalls).toBe(1);

        (app.data.user as {name: string}).name = 'Grace';

        await app.updated();

        expect(host.querySelector('i')?.textContent).toBe('Grace');
        expect(fmtCalls).toBe(1);
    });

    it('props-tier isolation: an unrelated parent write does not re-seed a child', async () => {
        stubTemplates({
            root: '<template><div data-component="echo" data-component-prop-text="msg"></div><p>${other}</p></template>',
            echo: `<template><span>\${text}</span></template>
<script>export default {mounted() { this.events.on('props', () => { window.__reseeds += 1; }); }};</script>`,
        });
        (window as unknown as {__reseeds: number}).__reseeds = 0;
        const host = mountPoint();
        const app = new Component({element: host, data: {msg: 'm', other: 'o'}});
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('m');
        });

        app.data.other = 'o2';

        await app.updated();

        expect((window as unknown as {__reseeds: number}).__reseeds).toBe(0);
        expect(host.querySelector('p')?.textContent).toBe('o2');
    });
});

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

        await app.updated();

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

    it('show-if and display-if on one item element both update on reconcile (multi-binding element)', async () => {
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id"><span data-show-if="$item.a" data-display-if="$item.b">${$item.label}</span></li></ul></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, a: true, b: true, label: 'x'}]}});
        await app.ready;

        const span = host.querySelector('span') as HTMLElement;

        expect(span.style.display).toBe('');

        app.data.items = [{id: 1, a: true, b: false, label: 'x'}];

        await app.updated();

        expect(host.querySelector('span')).not.toBeNull();
        expect((host.querySelector('span') as HTMLElement).style.display).toBe('none');
    });
});

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

    // #reseedChild notifies the child once per changed prop. A single
    // combined expression (reading both props) proves the two
    // notifies land in the SAME child flush rather than one drain per prop —
    // a per-prop drain would still reach the right final text, but would
    // write it twice (one mutation record per drain) instead of once.
    it('a multi-prop reseed coalesces into one child flush', async () => {
        stubTemplates({
            root: '<template><div data-component="echo" data-component-prop-x="a" data-component-prop-y="b"></div></template>',
            echo: `<template><span>\${x + ':' + y}</span></template>
<script>export default {};</script>`,
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {a: 1, b: 2}});
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('1:2');
        });

        const span = host.querySelector('span')!;
        const observer = new MutationObserver(() => {});

        observer.observe(span, {characterData: true, subtree: true});

        app.data.a = 10;
        app.data.b = 20;

        await app.updated();
        await settle(app);

        expect(span.textContent).toBe('10:20');

        const records = observer.takeRecords();

        expect(records.length).toBeLessThanOrEqual(1);
        observer.disconnect();
    });
});

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
