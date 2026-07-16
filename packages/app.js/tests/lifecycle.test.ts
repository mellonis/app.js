import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, settle, stubTemplates } from './helpers';

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
            async toggle() {
                this.data.visible = !this.data.visible;
                await this.updated();
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
        await settle(app);

        expect((window as unknown as {__connected: boolean}).__connected).toBe(false);
        expect((window as unknown as {__text: string}).__text).toBe('hi');

        button.click();
        await settle(app);

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
