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

    it('write-back survives a data key named "element" (issue #11)', async () => {
        stubTemplates({root: '<template><input data-value="name"></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {element: 'decoy', name: 'before'}});
        await app.ready;

        const input = host.querySelector('input')!;

        input.value = 'after';
        input.dispatchEvent(new Event('input'));

        expect(app.data.name).toBe('after');
    });

    it('binds an input two-way for a top-level key (issue #2)', async () => {
        stubTemplates({root: '<template><input data-value="name"><span>${name}</span></template>'});
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

describe('data-display-if', () => {
    it('toggles inline display while preserving the original inline value', async () => {
        stubTemplates({root: '<template><p data-display-if="visible" style="display: flex">x</p></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {visible: false}});
        await app.ready;

        const paragraph = host.querySelector('p')!;

        expect(paragraph).not.toBeNull();
        expect(paragraph.style.display).toBe('none');

        app.data.visible = true;

        expect(paragraph.style.display).toBe('flex');
    });

    it('restores an empty inline display so stylesheet rules apply again', async () => {
        stubTemplates({root: '<template><p data-display-if="visible">x</p></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {visible: true}});
        await app.ready;

        const paragraph = host.querySelector('p')!;

        expect(paragraph.style.display).toBe('');

        app.data.visible = false;

        expect(paragraph.style.display).toBe('none');

        app.data.visible = true;

        expect(paragraph.style.display).toBe('');
    });

    it('keeps the element in the DOM so sibling structure is stable', async () => {
        stubTemplates({root: '<template><div><i data-display-if="visible">a</i><i>b</i></div></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {visible: false}});
        await app.ready;

        const wrapper = host.querySelector('div')!;

        expect(wrapper.children).toHaveLength(2);
        expect((wrapper.children[0] as HTMLElement).style.display).toBe('none');

        app.data.visible = true;

        expect(wrapper.children).toHaveLength(2);
    });

    it('works inside data-for items with item scope', async () => {
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id"><span data-display-if="$item.on">${$item.label}</span></li></ul></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {items: [{id: 1, on: true, label: 'a'}, {id: 2, on: false, label: 'b'}]}});
        await app.ready;

        const spans = [...host.querySelectorAll('span')] as HTMLElement[];

        expect(spans).toHaveLength(2);
        expect(spans[0].style.display).toBe('');
        expect(spans[1].style.display).toBe('none');

        app.data.items = [{id: 1, on: true, label: 'a'}, {id: 2, on: true, label: 'b'}];

        expect(spans[1].style.display).toBe('');
    });

    it('works on the data-for element itself (per-item visibility)', async () => {
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id" data-display-if="$item.on">${$item.label}</li></ul></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {items: [{id: 1, on: false, label: 'a'}, {id: 2, on: true, label: 'b'}]}});
        await app.ready;

        const listItems = [...host.querySelectorAll('li')] as HTMLElement[];

        expect(listItems).toHaveLength(2);
        expect(listItems[0].style.display).toBe('none');
        expect(listItems[1].style.display).toBe('');

        app.data.items = [{id: 1, on: true, label: 'a'}, {id: 2, on: true, label: 'b'}];

        expect(listItems[0].style.display).toBe('');
    });

    it('evicted items stop being toggled, without errors', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id"><span data-display-if="$item.on"></span></li></ul></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {items: [{id: 1, on: true}], other: 0}});
        await app.ready;

        const detachedSpan = host.querySelector('span')! as HTMLElement;

        app.data.items = [];
        app.data.other = 1;

        expect(detachedSpan.style.display).toBe('');
        expect(errorSpy).not.toHaveBeenCalled();
    });
});

describe('data-value: form controls only (issue #18)', () => {
    it('binds a textarea two-way', async () => {
        stubTemplates({root: '<template><textarea data-value="note"></textarea></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {note: 'before'}});
        await app.ready;

        const textarea = host.querySelector('textarea')!;

        expect(textarea.value).toBe('before');

        textarea.value = 'after';
        textarea.dispatchEvent(new Event('input'));

        expect(app.data.note).toBe('after');

        app.data.note = 'again';

        expect(textarea.value).toBe('again');
    });

    it('binds a select two-way via the change event', async () => {
        stubTemplates({root: '<template><select data-value="pick"><option value="a">A</option><option value="b">B</option></select></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {pick: 'b'}});
        await app.ready;

        const select = host.querySelector('select')!;

        expect(select.value).toBe('b');

        select.value = 'a';
        select.dispatchEvent(new Event('change'));

        expect(app.data.pick).toBe('a');
    });

    it('errors on checkbox/radio inputs (their state is checked, not value)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><input type="checkbox" data-value="agree"></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {agree: false}});
        await app.ready;

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('checked');

        const box = host.querySelector('input')!;

        box.checked = true;
        box.dispatchEvent(new Event('input'));

        expect(app.data.agree).toBe(false);
    });

    it('errors loudly on a non-form element and does not bind', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><span data-value="title">static</span></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {title: 't'}});
        await app.ready;

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('form controls');

        const span = host.querySelector('span')!;

        expect(span.textContent).toBe('static');

        app.data.title = 't2';

        expect(span.textContent).toBe('static');
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
