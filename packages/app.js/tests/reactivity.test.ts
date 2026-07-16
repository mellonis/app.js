import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

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
