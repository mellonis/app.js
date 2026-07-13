import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('destroy()', () => {
    it('aborts event listeners', async () => {
        stubTemplates({root: '<template><button data-on-click="hit">go</button></template>'});
        const host = mountPoint();
        const hit = vi.fn();
        const app = new Component({element: host, methods: {hit}});
        await app.ready;

        app.destroy();
        host.querySelector('button')!.click();

        expect(hit).not.toHaveBeenCalled();
    });

    it('stops reacting to data changes but leaves the DOM in place', async () => {
        stubTemplates({root: '<template><span>${title}</span></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {title: 'before'}});
        await app.ready;

        app.destroy();
        app.data.title = 'after';

        expect(host.querySelector('span')?.textContent).toBe('before');
        expect(app.data.title).toBe('after');
    });

    it('aborts input write-back', async () => {
        stubTemplates({root: '<template><input data-value="name"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {name: 'before'}});
        await app.ready;

        app.destroy();

        const input = host.querySelector('input')!;

        input.value = 'typed';
        input.dispatchEvent(new Event('input'));

        expect(app.data.name).toBe('before');
    });

    it('stops list reconciliation', async () => {
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id"></li></ul></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1}]}});
        await app.ready;

        expect(host.querySelectorAll('li')).toHaveLength(1);

        app.destroy();
        app.data.items = [{id: 1}, {id: 2}];

        expect(host.querySelectorAll('li')).toHaveLength(1);
    });

    it('rejects ready quietly when destroyed before mount settles', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({root: '<template><p>content</p></template>'});

        const host = mountPoint();
        const app = new Component({element: host});

        app.destroy();

        await expect(app.ready).rejects.toEqual(new Error('The component was destroyed'));
        expect(host.querySelector('p')).toBeNull();

        await new Promise(resolve => setTimeout(resolve, 0));

        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('is idempotent', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint()});
        await app.ready;

        app.destroy();

        expect(() => app.destroy()).not.toThrow();
    });
});
