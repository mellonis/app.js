import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('data-show-if', () => {
    it('toggles a nested element via an anchor comment', async () => {
        stubTemplates({root: '<template><div><p data-show-if="visible">secret</p></div></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {visible: true}});

        await vi.waitFor(() => {
            expect(host.querySelector('p')).not.toBeNull();
        });

        app.data.visible = false;
        expect(host.querySelector('p')).toBeNull();

        app.data.visible = true;
        expect(host.querySelector('p')).not.toBeNull();
    });

    it('shows an initially hidden top-level element when its expression becomes truthy (issue #8)', async () => {
        stubTemplates({root: '<template><p data-show-if="visible">secret</p></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {visible: false}});
        await app.ready;

        expect(host.querySelector('p')).toBeNull();

        app.data.visible = true;
        expect(host.querySelector('p')).not.toBeNull();

        app.data.visible = false;
        expect(host.querySelector('p')).toBeNull();
    });
});

describe('data-value', () => {
    it('binds an input two-way for a nested key', async () => {
        stubTemplates({root: '<template><input data-value="user.name"></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {user: {name: 'before'}}});

        const input = await vi.waitFor(() => {
            const el = host.querySelector('input');
            expect(el).not.toBeNull();
            return el!;
        });
        expect(input.value).toBe('before');

        input.value = 'after';
        input.dispatchEvent(new Event('input'));

        expect((app.data.user as Record<string, unknown>).name).toBe('after');
    });

    it('binds an input two-way for a top-level key (issue #2)', async () => {
        stubTemplates({root: '<template><input data-value="name"><span data-value="name"></span></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {name: 'before'}});
        await app.ready;

        const input = host.querySelector('input')!;
        expect(input.value).toBe('before');

        input.value = 'after';
        input.dispatchEvent(new Event('input'));

        expect(app.data.name).toBe('after');
        expect(host.querySelector('span')?.textContent).toBe('after');
    });
});

describe('data-on-*', () => {
    it('dispatches click to the named method, bound to the app, with the event', async () => {
        stubTemplates({root: '<template><button data-on-click="hit">go</button></template>'});
        const host = mountPoint();
        const calls: Array<{self: unknown; event: Event}> = [];
        const app = new App({
            element: host,
            methods: {
                hit(this: unknown, event: Event) {
                    calls.push({self: this, event});
                },
            },
        });

        const button = await vi.waitFor(() => {
            const el = host.querySelector('button');
            expect(el).not.toBeNull();
            return el!;
        });

        button.click();

        expect(calls).toHaveLength(1);
        expect(calls[0].self).toBe(app);
        expect(calls[0].event).toBeInstanceOf(Event);
    });

    it('dispatches submit to the named method', async () => {
        stubTemplates({root: '<template><form data-on-submit="onSubmit"></form></template>'});
        const host = mountPoint();
        const onSubmit = vi.fn();
        new App({element: host, methods: {onSubmit}});

        const form = await vi.waitFor(() => {
            const el = host.querySelector('form');
            expect(el).not.toBeNull();
            return el!;
        });

        form.dispatchEvent(new Event('submit'));

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('ignores unknown method names without throwing', async () => {
        stubTemplates({root: '<template><button data-on-click="missing">go</button></template>'});
        const host = mountPoint();
        new App({element: host});

        const button = await vi.waitFor(() => {
            const el = host.querySelector('button');
            expect(el).not.toBeNull();
            return el!;
        });

        expect(() => button.click()).not.toThrow();
    });
});
