import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('component loading', () => {
    it('loads nested components', async () => {
        stubTemplates({
            root: '<template><div data-component="child"></div></template>',
            child: '<template><span class="c">child</span></template>',
        });
        const host = mountPoint();
        new App({element: host});

        await vi.waitFor(() => {
            expect(host.querySelector('[data-component="child"] .c')).not.toBeNull();
        });
    });

    it('allows the same component twice as siblings (issue #1)', async () => {
        stubTemplates({
            root: '<template><div data-component="widget"></div><div data-component="widget"></div></template>',
            widget: '<template><span class="w">w</span></template>',
        });
        const host = mountPoint();
        new App({element: host});

        await vi.waitFor(() => {
            expect(host.querySelectorAll('.w')).toHaveLength(2);
        });
    });

    it('allows the same component in two different branches (issue #1)', async () => {
        stubTemplates({
            root: '<template><div data-component="left"></div><div data-component="right"></div></template>',
            left: '<template><div data-component="widget"></div></template>',
            right: '<template><div data-component="widget"></div></template>',
            widget: '<template><span class="w">w</span></template>',
        });
        const host = mountPoint();
        new App({element: host});

        await vi.waitFor(() => {
            expect(host.querySelectorAll('.w')).toHaveLength(2);
        });
    });

    it('still rejects a self-including component', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({selfy: '<template><div data-component="selfy"></div></template>'});
        const app = new App({element: mountPoint(), componentName: 'selfy'});

        await expect(app.ready).rejects.toBe('A component cycle was detected during loading');
    });

    it('still rejects a mutual cycle (a → b → a)', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            a: '<template><div data-component="b"></div></template>',
            b: '<template><div data-component="a"></div></template>',
        });
        const app = new App({element: mountPoint(), componentName: 'a'});

        await expect(app.ready).rejects.toBe('A component cycle was detected during loading');
    });

    it('renders remaining bindings when one expression throws (issue #4)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><span data-value="oops()"></span><span id="ok" data-value="title"></span></template>',
        });
        const host = mountPoint();
        new App({element: host, data: {title: 't'}});

        await vi.waitFor(() => {
            expect(host.querySelector('#ok')?.textContent).toBe('t');
        }, {timeout: 300});
        expect(errorSpy.mock.calls.flat()).toContain('Can\'t evaluate the "oops()" expression');
    });

    it('applies remaining bindings when a show-if expression throws (issue #4)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div><p data-show-if="oops()">maybe</p></div><span id="ok" data-value="title"></span></template>',
        });
        const host = mountPoint();
        new App({element: host, data: {title: 't'}});

        await vi.waitFor(() => {
            expect(host.querySelector('#ok')?.textContent).toBe('t');
        });
        expect(errorSpy.mock.calls.flat()).toContain('Can\'t evaluate the "oops()" expression');
    });

    it('exposes a ready promise that resolves after the initial mount (issue #5)', async () => {
        stubTemplates({root: '<template><span class="r">mounted</span></template>'});
        const host = mountPoint();
        const app = new App({element: host});

        await app.ready;

        expect(host.querySelector('.r')).not.toBeNull();
    });

    it('rejects ready with the original error when mounting fails (issue #5)', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({});
        const app = new App({element: mountPoint()});

        await expect(app.ready).rejects.toEqual(new Error('404: /templates/root.html'));
    });

    it('rejects a template file whose first child is not a <template> element', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<div>not a template</div>'});
        new App({element: mountPoint()});

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat()).toContain('A component template file must have a <template> element as its first child');
        });
    });
});
