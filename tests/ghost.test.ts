import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/app';
import { flush, mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('ghost reactivity', () => {
    it('exposes initial data', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new App({
            element: mountPoint(),
            data: {title: 'hello', user: {name: 'Ada'}},
        });
        await flush();

        expect(app.data.title).toBe('hello');
        expect((app.data.user as Record<string, unknown>).name).toBe('Ada');
    });

    it('updates a bound element when a top-level key is set', async () => {
        stubTemplates({root: '<template><span data-value="title"></span></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {title: 'hello'}});

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('hello');
        });

        app.data.title = 'changed';

        expect(host.querySelector('span')?.textContent).toBe('changed');
    });

    it('updates a bound element when a nested key is set', async () => {
        stubTemplates({root: '<template><span data-value="user.name"></span></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {user: {name: 'Ada'}}});

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('Ada');
        });

        (app.data.user as Record<string, unknown>).name = 'Grace';

        expect(host.querySelector('span')?.textContent).toBe('Grace');
    });

    it('evaluates full JS expressions over top-level keys', async () => {
        stubTemplates({root: '<template><span data-value="firstName + \' \' + lastName"></span></template>'});
        const host = mountPoint();
        new App({element: host, data: {firstName: 'Ada', lastName: 'Lovelace'}});

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('Ada Lovelace');
        });
    });

    it('has a fixed shape: adding keys throws', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new App({element: mountPoint(), data: {title: 'x'}});
        await flush();

        expect(() => {
            (app.data as Record<string, unknown>).extra = 1;
        }).toThrow(TypeError);
    });

    it('does not allow replacing a nested object wholesale', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new App({element: mountPoint(), data: {user: {name: 'Ada'}}});
        await flush();

        expect(() => {
            (app.data as Record<string, unknown>).user = {name: 'Grace'};
        }).toThrow(TypeError);
    });

    it('stores an input element\'s value when one is assigned', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new App({element: mountPoint(), data: {title: 'x'}});
        await flush();

        const input = document.createElement('input');
        input.value = 'from input';
        app.data.title = input;

        expect(app.data.title).toBe('from input');
    });

    it.fails('does not crash when initial data contains null (issue #3)', () => {
        stubTemplates({root: '<template></template>'});

        expect(() => new App({element: mountPoint(), data: {user: null}})).not.toThrow();
    });
});
