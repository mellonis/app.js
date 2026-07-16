import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
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
        const app = new Component({
            element: mountPoint(),
            data: {title: 'hello', user: {name: 'Ada'}},
        });
        await flush();

        expect(app.data.title).toBe('hello');
        expect((app.data.user as Record<string, unknown>).name).toBe('Ada');
    });

    it('updates a bound element when a top-level key is set', async () => {
        stubTemplates({root: '<template><span>${title}</span></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {title: 'hello'}});

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('hello');
        });

        app.data.title = 'changed';
        await app.updated();

        expect(host.querySelector('span')?.textContent).toBe('changed');
    });

    it('updates a bound element when a nested key is set', async () => {
        stubTemplates({root: '<template><span>${user.name}</span></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {user: {name: 'Ada'}}});

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('Ada');
        });

        (app.data.user as Record<string, unknown>).name = 'Grace';
        await app.updated();

        expect(host.querySelector('span')?.textContent).toBe('Grace');
    });

    it('evaluates full JS expressions over top-level keys', async () => {
        stubTemplates({root: '<template><span>${firstName + \' \' + lastName}</span></template>'});
        const host = mountPoint();
        new Component({element: host, data: {firstName: 'Ada', lastName: 'Lovelace'}});

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('Ada Lovelace');
        });
    });

    it('has a fixed shape: adding keys throws', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint(), data: {title: 'x'}});
        await flush();

        expect(() => {
            (app.data as Record<string, unknown>).extra = 1;
        }).toThrow(TypeError);
    });

    it('does not allow replacing a nested object wholesale', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint(), data: {user: {name: 'Ada'}}});
        await flush();

        expect(() => {
            (app.data as Record<string, unknown>).user = {name: 'Grace'};
        }).toThrow(TypeError);
    });

    it('stores an assigned element as-is — no value extraction magic (issue #15)', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint(), data: {title: 'x'}});
        await flush();

        const input = document.createElement('input');

        input.value = 'from input';
        app.data.title = input;

        expect(app.data.title).toBe(input);
    });

    it('does not crash when initial data contains null (issue #3)', () => {
        stubTemplates({root: '<template></template>'});

        expect(() => new Component({element: mountPoint(), data: {user: null}})).not.toThrow();
    });

    it('treats a null value as a readable, settable primitive (issue #3)', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint(), data: {user: null}});
        await flush();

        expect(app.data.user).toBeNull();

        app.data.user = 'Ada';

        expect(app.data.user).toBe('Ada');
    });

    it('treats arrays as replaceable leaf values (issue #6)', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint(), data: {items: [1, 2]}});
        await flush();

        expect(Array.isArray(app.data.items)).toBe(true);
        expect(app.data.items).toEqual([1, 2]);

        app.data.items = [3];

        expect(app.data.items).toEqual([3]);
    });

    it('does not recurse into arrays nested in objects (issue #6)', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint(), data: {user: {tags: ['a']}}});
        await flush();

        const user = app.data.user as Record<string, unknown>;

        expect(Array.isArray(user.tags)).toBe(true);

        user.tags = ['a', 'b'];

        expect(user.tags).toEqual(['a', 'b']);
    });

    it('object self-assignment triggers a pass; replacement throws loudly (issue #7 amendment)', async () => {
        stubTemplates({root: '<template><span>${user.name}</span></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {user: {name: 'Ada'}}});
        await app.ready;

        (app.data.user as {name: string}).name = 'Grace';
        app.data.user = app.data.user;
        await app.updated();

        expect(host.querySelector('span')?.textContent).toBe('Grace');
        expect(() => {
            app.data.user = {name: 'Imposter'};
        }).toThrow(TypeError);
    });
});
