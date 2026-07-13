import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

const LIST_TEMPLATE = '<template><ul><li data-for="items" data-key="$item.id"><span>${$item.label}</span></li></ul></template>';

async function mountList(initialItems: unknown[], template = LIST_TEMPLATE) {
    stubTemplates({root: template});
    const host = mountPoint();
    const app = new Component({element: host, data: {items: initialItems, other: 0}});
    await app.ready;

    return {app, host};
}

describe('data-for: mount and setup errors', () => {
    it('renders one clone per item, in order, with zero console errors', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList([{id: 1, label: 'a'}, {id: 2, label: 'b'}]);

        expect([...host.querySelectorAll('li span')].map(el => el.textContent)).toEqual(['a', 'b']);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('renders an empty block for an empty array', async () => {
        const {host} = await mountList([]);

        expect(host.querySelectorAll('li')).toHaveLength(0);
        expect(host.querySelector('ul')).not.toBeNull();
    });

    it('strips data-for and data-key from clones', async () => {
        const {host} = await mountList([{id: 1, label: 'a'}]);
        const li = host.querySelector('li')!;

        expect(li.dataset['for']).toBeUndefined();
        expect(li.dataset['key']).toBeUndefined();
    });

    it('errors and renders nothing when data-key is missing', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList([{id: 1}], '<template><ul><li data-for="items"><span data-value="$item.id"></span></li></ul></template>');

        expect(host.querySelectorAll('li')).toHaveLength(0);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('data-key');
    });

    it('errors when data-for shares an element with data-show-if', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList([{id: 1}], '<template><ul><li data-for="items" data-key="$item.id" data-show-if="other"><span></span></li></ul></template>');

        expect(host.querySelectorAll('li')).toHaveLength(0);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('data-show-if');
    });

    it('errors when the template subtree contains data-component or nested data-for', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList([{id: 1}], '<template><ul><li data-for="items" data-key="$item.id"><div data-component="widget"></div></li></ul></template>');

        expect(host.querySelectorAll('li')).toHaveLength(0);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('nested');
    });

    it('errors and renders empty when the expression is not an array', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList(0 as unknown as unknown[], LIST_TEMPLATE.replace('"items"', '"other"'));

        expect(host.querySelectorAll('li')).toHaveLength(0);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('did not produce an array');
    });

    it('bans <input data-value> inside items but keeps the rest of the item working', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const template = '<template><ul><li data-for="items" data-key="$item.id"><input data-value="$item.label"><span>${$item.label}</span></li></ul></template>';
        const {app, host} = await mountList([{id: 1, label: 'a'}], template);

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('input');
        expect(host.querySelector('li span')?.textContent).toBe('a');

        const input = host.querySelector('input')!;

        input.value = 'typed';
        app.data.other = 1;

        expect(input.value).toBe('typed');
    });

    it('a nested data-for does not register a zombie block (item-scope variant)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const template = '<template><ul><li data-for="items" data-key="$item.id"><p data-for="$item.subs" data-key="$item.id"></p></li></ul></template>';
        const {app, host} = await mountList([{id: 1, subs: []}], template);

        expect(host.querySelectorAll('li')).toHaveLength(0);

        const errorsAfterMount = errorSpy.mock.calls.length;

        expect(errorsAfterMount).toBeGreaterThan(0);

        app.data.other = 1;
        app.data.other = 2;

        expect(errorSpy.mock.calls.length).toBe(errorsAfterMount);
    });

    it('a nested data-for referencing a valid data key does not reconcile invisibly', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const template = '<template><ul><li data-for="items" data-key="$item.id"><p data-for="items" data-key="$item.id"></p></li></ul></template>';
        const {app, host} = await mountList([{id: 1}], template);

        expect(host.querySelectorAll('li, p')).toHaveLength(0);

        const errorsAfterMount = errorSpy.mock.calls.length;

        app.data.other = 1;

        expect(errorSpy.mock.calls.length).toBe(errorsAfterMount);
    });
});

describe('data-for: reconciliation', () => {
    it('preserves DOM node identity for stable keys across replacement', async () => {
        const {app, host} = await mountList([{id: 1, label: 'a'}, {id: 2, label: 'b'}]);
        const [first, second] = [...host.querySelectorAll('li')];

        app.data.items = [{id: 1, label: 'a2'}, {id: 2, label: 'b2'}];

        const after = [...host.querySelectorAll('li')];

        expect(after[0]).toBe(first);
        expect(after[1]).toBe(second);
        expect(after.map(li => li.querySelector('span')!.textContent)).toEqual(['a2', 'b2']);
    });

    it('reorders by moving existing nodes, not recreating them', async () => {
        const {app, host} = await mountList([{id: 1, label: 'a'}, {id: 2, label: 'b'}, {id: 3, label: 'c'}]);
        const byLabel = new Map([...host.querySelectorAll('li')].map(li => [li.querySelector('span')!.textContent, li]));

        app.data.items = [{id: 3, label: 'c'}, {id: 1, label: 'a'}, {id: 2, label: 'b'}];

        const after = [...host.querySelectorAll('li')];

        expect(after[0]).toBe(byLabel.get('c'));
        expect(after[1]).toBe(byLabel.get('a'));
        expect(after[2]).toBe(byLabel.get('b'));
    });

    it('appends and prepends without recreating survivors', async () => {
        const {app, host} = await mountList([{id: 2, label: 'b'}]);
        const survivor = host.querySelector('li')!;

        app.data.items = [{id: 1, label: 'a'}, {id: 2, label: 'b'}, {id: 3, label: 'c'}];

        const after = [...host.querySelectorAll('li')];

        expect(after).toHaveLength(3);
        expect(after[1]).toBe(survivor);
        expect(after.map(li => li.querySelector('span')!.textContent)).toEqual(['a', 'b', 'c']);
    });

    it('removes items and stops updating their detached elements', async () => {
        const {app, host} = await mountList([{id: 1, label: 'a'}, {id: 2, label: 'b'}]);
        const removed = host.querySelectorAll('li')[1];

        app.data.items = [{id: 1, label: 'a'}];

        expect(host.querySelectorAll('li')).toHaveLength(1);
        expect(removed.isConnected).toBe(false);

        const detachedSpan = removed.querySelector('span')!;
        const frozenText = detachedSpan.textContent;

        app.data.other = 1;

        expect(detachedSpan.textContent).toBe(frozenText);
    });

    it('self-assignment after an in-place push reconciles (no identity short-circuit)', async () => {
        const {app, host} = await mountList([{id: 1, label: 'a'}]);

        (app.data.items as unknown[]).push({id: 2, label: 'b'});

        expect(host.querySelectorAll('li')).toHaveLength(1);

        app.data.items = app.data.items;

        expect(host.querySelectorAll('li')).toHaveLength(2);
    });

    it('duplicate keys: first wins, error logs once while persisting, relogs after a clean pass', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {app, host} = await mountList([{id: 1, label: 'first'}, {id: 1, label: 'second'}]);

        expect([...host.querySelectorAll('span')].map(s => s.textContent)).toEqual(['first']);
        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.other = 1;

        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.items = [{id: 1, label: 'clean'}];
        app.data.items = [{id: 1, label: 'x'}, {id: 1, label: 'y'}];

        expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('a throwing key expression skips that item, keeps source indexes, and continues', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {host} = await mountList([{id: 1, label: 'a'}, null, {id: 3, label: 'c'}]);

        expect([...host.querySelectorAll('span')].map(s => s.textContent)).toEqual(['a', 'c']);
        expect(errorSpy).toHaveBeenCalled();
    });
});

describe('data-for: item scope and handlers', () => {
    it('exposes $item, $index (source), and $array to item expressions', async () => {
        const template = '<template><div><p data-for="items" data-key="$item.id"><span>${$item.label + \':\' + $index + \'/\' + $array.length}</span></p></div></template>';
        const {host} = await mountList([{id: 1, label: 'a'}, {id: 2, label: 'b'}], template);

        expect([...host.querySelectorAll('span')].map(s => s.textContent)).toEqual(['a:0/2', 'b:1/2']);
    });

    it('re-evaluates last-item detection after append ($array from the registry)', async () => {
        const template = '<template><div><p data-for="items" data-key="$item.id"><em data-show-if="$index === $array.length - 1">last</em><span>${$item.label}</span></p></div></template>';
        const {app, host} = await mountList([{id: 1, label: 'a'}], template);

        expect(host.querySelectorAll('em')).toHaveLength(1);

        app.data.items = [...(app.data.items as unknown[]), {id: 2, label: 'b'}];

        const marked = [...host.querySelectorAll('em')];

        expect(marked).toHaveLength(1);
        expect(marked[0].closest('p')!.querySelector('span')!.textContent).toBe('b');
    });

    it('per-item data-show-if toggles with item replacement', async () => {
        const template = '<template><div><p data-for="items" data-key="$item.id"><b data-show-if="$item.done">done</b></p></div></template>';
        const {app, host} = await mountList([{id: 1, done: false}], template);

        expect(host.querySelector('b')).toBeNull();

        app.data.items = [{id: 1, done: true}];

        expect(host.querySelector('b')).not.toBeNull();
    });

    it('handlers receive (event, item, index), correct even after reorder', async () => {
        const received: Array<{item: {id: number}; index: number | undefined}> = [];

        stubTemplates({root: '<template><div><button data-for="items" data-key="$item.id" data-on-click="pick">${$item.label}</button></div></template>'});

        const host = mountPoint();
        const app = new Component({
            element: host,
            data: {items: [{id: 1, label: 'a'}, {id: 2, label: 'b'}]},
            methods: {
                pick(event, item, index) {
                    received.push({item: item as {id: number}, index});
                },
            },
        });

        await app.ready;

        const buttonFor = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!;

        buttonFor('a').click();

        expect(received[0].item.id).toBe(1);
        expect(received[0].index).toBe(0);

        app.data.items = [{id: 2, label: 'b'}, {id: 1, label: 'a'}];

        buttonFor('a').click();

        expect(received[1].item.id).toBe(1);
        expect(received[1].index).toBe(1);
    });

    it('handlers outside blocks still receive only a meaningful event', async () => {
        let sawItem: unknown = 'sentinel';

        stubTemplates({root: '<template><button data-on-click="hit">go</button></template>'});

        const host = mountPoint();
        const app = new Component({
            element: host,
            methods: {
                hit(event, item) {
                    sawItem = item;
                },
            },
        });

        await app.ready;
        host.querySelector('button')!.click();

        expect(sawItem).toBeUndefined();
    });

    it('template integrity: root-expression data-show-if inside items never corrupts the clone source', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const template = '<template><div><p data-for="items" data-key="$item.id"><em data-show-if="showDetails">details</em></p></div></template>';

        stubTemplates({root: template});

        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1}], showDetails: false}});

        await app.ready;

        expect(host.querySelector('em')).toBeNull();

        app.data.items = [...(app.data.items as unknown[]), {id: 2}];
        app.data.showDetails = true;

        expect(host.querySelectorAll('em')).toHaveLength(2);
        expect(errorSpy).not.toHaveBeenCalled();
    });
});

describe('data-for: error cadence (issue #12)', () => {
    it('a persistently throwing list expression logs once, re-arms after a clean pass', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const template = '<template><ul><li data-for="broken ? missingFn() : items" data-key="$item.id"></li></ul></template>';

        stubTemplates({root: template});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1}], broken: true, other: 0}});
        await app.ready;

        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.other = 1;
        app.data.other = 2;

        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.broken = false;

        expect(host.querySelectorAll('li')).toHaveLength(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.broken = true;

        expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('a persistent non-array result logs once, re-arms after a clean pass', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const template = '<template><ul><li data-for="value" data-key="$item.id"></li></ul></template>';

        stubTemplates({root: template});
        const host = mountPoint();
        const app = new Component({element: host, data: {value: 5, other: 0}});
        await app.ready;

        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.other = 1;

        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.value = [];

        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.value = 5;

        expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('a persistently throwing key expression logs once, re-arms after a clean pass', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const {app} = await mountList([null]);

        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.other = 1;

        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.items = [{id: 1, label: 'a'}];

        expect(errorSpy).toHaveBeenCalledTimes(1);

        app.data.items = [null];

        expect(errorSpy).toHaveBeenCalledTimes(2);
    });
});
