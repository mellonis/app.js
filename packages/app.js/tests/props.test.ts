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
            pair: `<template><p>\${a}:\${b}</p><i id="state">\${batches}|\${lastKeys}</i></template>
<script>
    export default {
        data: () => ({batches: 0, lastKeys: ''}),
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
        expect(host.querySelector('#state')?.textContent).toBe('0|');

        app.data.x = 5;

        await vi.waitFor(() => {
            expect(host.querySelector('p')?.textContent).toBe('5:6');
        });
        // ONE batch carrying BOTH changed props — the spec's central proof
        expect(host.querySelector('#state')?.textContent).toBe('1|a,b');
    });

    it("a grandchild observes its parent's own prop traffic via onParent('props')", async () => {
        (window as unknown as {__overheard: unknown[]}).__overheard = [];
        stubTemplates({
            root: '<template><div data-component="middle" data-component-prop-x="n"></div></template>',
            middle: `<template><div data-component="leaf"></div></template>
<script>export default {};</script>`,
            leaf: `<template></template>
<script>export default {mounted() { this.events.onParent('props', event => { window.__overheard.push(event.detail); }); }};</script>`,
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {n: 1}});
        await app.ready;

        app.data.n = 2;

        await vi.waitFor(() => {
            expect((window as unknown as {__overheard: unknown[]}).__overheard).toEqual([{x: {value: 2, previous: 1}}]);
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

    it('malformed and unreferenceable prop names error; former reserved words are legal (issue #15)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="greeter" data-component-prop-class="7" data-component-prop-typeof="1" data-component-prop-who="&quot;Ada&quot;"></div></template>',
            greeter: `<template><p>\${greeting}, \${who}! (\${class})</p></template>
<script>export default {data: () => ({greeting: 'Hello'})};</script>`,
        });
        const host = mountPoint();
        new Component({element: host});

        await vi.waitFor(() => {
            expect(host.querySelector('p')?.textContent).toBe('Hello, Ada! (7)');
        });
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('typeof');
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
        await app.updated();

        expect(countPropErrors()).toBe(1);

        app.data.broken = false;
        await app.updated();
        app.data.broken = true;
        await app.updated();

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
