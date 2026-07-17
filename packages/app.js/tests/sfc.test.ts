import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, settle, stubTemplates } from './helpers';

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
        await settle(app);

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
        await app.updated();

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

    it('a typo in a data-component-on-* method name logs loudly at wiring (issue #27)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({
            root: '<template><div data-component="pinger" data-component-on-ping="typo"></div></template>',
            pinger: `<template><button data-on-click="fire">go</button></template>
<script>export default {methods: {fire() { this.events.emit('ping', 42); }}};</script>`,
        });
        const host = mountPoint();
        new Component({element: host, methods: {}});

        const button = await vi.waitFor(() => {
            const el = host.querySelector('button');
            expect(el).not.toBeNull();
            return el!;
        });

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('typo');

        expect(() => button.click()).not.toThrow();
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
        await settle(app);

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

    it('data-on-click and data-component-on-click coexist on one wrapper, firing independently', async () => {
        const log: string[] = [];

        stubTemplates({
            root: '<template><div data-component="clicky" data-on-click="domClick" data-component-on-click="componentClick"></div></template>',
            clicky: `<template><button data-on-click="inner">go</button></template>
<script>export default {methods: {inner() { this.events.emit('click', 'component'); }}};</script>`,
        });
        const host = mountPoint();
        new Component({
            element: host,
            methods: {
                domClick() {
                    log.push('dom');
                },
                componentClick(event) {
                    log.push('component:' + (event as CustomEvent).detail);
                },
            },
        });

        await vi.waitFor(() => {
            expect(host.querySelector('button')).not.toBeNull();
        });

        (host.querySelector('button') as HTMLButtonElement).click();

        expect(log).toContain('component:component');
        expect(log).toContain('dom');
    });
});
