import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

const ITEM_SFC = `<template><span>\${todo.title}</span><button data-on-click="remove">x</button></template>
<script>
    export default {
        methods: {
            remove() {
                this.events.emit('removed', this.props.todo.id);
            },
        },
    };
</script>`;

const LIST_ROOT = '<template><ul><li data-for="todos" data-key="$item.id"><div data-component="todo-item" data-component-prop-todo="$item" data-component-on-removed="onRemoved"></div></li></ul></template>';

describe('per-item components', () => {
    it('instantiates one child per item with item-scope props; handlers get (event, item, index)', async () => {
        const calls: Array<{detail: unknown; id: unknown; index: unknown}> = [];

        stubTemplates({root: LIST_ROOT, 'todo-item': ITEM_SFC});
        const host = mountPoint();
        const app = new Component({
            element: host,
            data: {todos: [{id: 1, title: 'a'}, {id: 2, title: 'b'}]},
            methods: {
                onRemoved(event, item, index) {
                    calls.push({detail: (event as CustomEvent).detail, id: (item as {id: number}).id, index});
                },
            },
        });
        await app.ready;
        await vi.waitFor(() => {
            expect([...host.querySelectorAll('span')].map(s => s.textContent)).toEqual(['a', 'b']);
        });

        ([...host.querySelectorAll('button')][1] as HTMLButtonElement).click();

        expect(calls).toEqual([{detail: 2, id: 2, index: 1}]);
    });

    it('re-seeds item props on immutable replacement; child reuse for stable keys', async () => {
        stubTemplates({root: LIST_ROOT, 'todo-item': ITEM_SFC});
        const host = mountPoint();
        const app = new Component({element: host, data: {todos: [{id: 1, title: 'a'}]}, methods: {onRemoved() {}}});
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('a');
        });

        const spanBefore = host.querySelector('span');

        app.data.todos = [{id: 1, title: 'A2'}];

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('A2');
        });
        expect(host.querySelector('span')).toBe(spanBefore);
    });

    it('eviction destroys the child; later passes are error-free; re-add creates a fresh instance', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({root: LIST_ROOT, 'todo-item': ITEM_SFC});
        const host = mountPoint();
        const app = new Component({element: host, data: {todos: [{id: 1, title: 'a'}], other: 0}, methods: {onRemoved() {}}});
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelector('span')).not.toBeNull();
        });

        const detachedButton = host.querySelector('button') as HTMLButtonElement;

        app.data.todos = [];
        app.data.other = 1;
        app.data.other = 2;

        detachedButton.click();

        expect(errorSpy).not.toHaveBeenCalled();

        app.data.todos = [{id: 1, title: 'again'}];

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('again');
        });
    });

    it('eviction mid-definition-load abandons silently (nothing constructed, no later errors)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({root: LIST_ROOT, 'todo-item': ITEM_SFC});
        const host = mountPoint();
        const app = new Component({element: host, data: {todos: [{id: 1, title: 'a'}], other: 0}, methods: {onRemoved() {}}});

        // Evict before the (first-ever) definition fetch resolves
        app.data.todos = [];

        await app.ready;
        await new Promise(resolve => setTimeout(resolve, 10));

        app.data.other = 1;

        expect(host.querySelector('span')).toBeNull();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('template-only includes inside items stay banned (loud, once per entry)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({
            root: '<template><ul><li data-for="items" data-key="$item.id"><div data-component="plain"></div></li></ul></template>',
            plain: '<template><em>inc</em></template>',
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1}], other: 0}});
        await app.ready;

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat().join(' ')).toContain('template-only');
        });

        const errorsAfter = errorSpy.mock.calls.length;

        app.data.other = 1;
        app.data.other = 2;

        expect(errorSpy.mock.calls.length).toBe(errorsAfter);
        expect(host.querySelector('em')).toBeNull();
    });

    it('bans data-component on a form control inside items', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({
            root: '<template><ul><li data-for="items" data-key="$item.id"><input data-component="todo-item"><span>${$item.id}</span></li></ul></template>',
            'todo-item': ITEM_SFC,
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1}]}});
        await app.ready;

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat().join(' ')).toContain('data-component cannot be placed on a form control');
        });

        const input = host.querySelector('input')!;

        expect(input.dataset['componentRoot']).toBeUndefined();
        expect(host.querySelector('li span')?.textContent).toBe('1');
    });

    it('logs once per entry when an item component template fails to load; the rest of the item still renders', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({
            root: '<template><ul><li data-for="items" data-key="$item.id"><div data-component="missing"></div><span>${$item.label}</span></li></ul></template>',
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, label: 'a'}], other: 0}});
        await app.ready;

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat().join(' ')).toContain('Can\'t load the "missing" component');
        });

        expect(host.querySelector('li span')?.textContent).toBe('a');

        const loadErrorCalls = errorSpy.mock.calls.filter(call => String(call[0]).includes('Can\'t load the "missing" component'));

        expect(loadErrorCalls).toHaveLength(1);

        app.data.other = 1;
        app.data.other = 2;
        await app.updated();

        expect(errorSpy.mock.calls.filter(call => String(call[0]).includes('Can\'t load the "missing" component'))).toHaveLength(1);
    });

    it('a cleanup final-emit that prunes the list cannot resurrect evicted elements', async () => {
        stubTemplates({
            root: '<template><ul><li data-for="todos" data-key="$item.id"><div data-component="pruner" data-component-prop-todo="$item" data-component-on-gone="onGone"></div></li></ul></template>',
            pruner: `<template><span>\${todo.title}</span></template>
<script>
    export default {
        mounted() {
            return () => {
                this.events.emit('gone', this.props.todo.id);
            };
        },
    };
</script>`,
        });
        const host = mountPoint();
        const app = new Component({
            element: host,
            data: {todos: [{id: 1, title: 'a'}, {id: 2, title: 'b'}, {id: 3, title: 'c'}]},
            methods: {
                onGone(event) {
                    const goneId = (event as CustomEvent).detail as number;

                    if (goneId === 1) {
                        this.data.todos = (this.data.todos as Array<{id: number}>).filter(todo => todo.id !== 2);
                    }
                },
            },
        });
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelectorAll('span')).toHaveLength(3);
        });

        // Evict id 1; its cleanup emits 'gone', the handler prunes id 2
        // mid-sweep — the re-entrant pass must win, no zombies
        app.data.todos = (app.data.todos as Array<{id: number}>).filter(todo => todo.id !== 1);

        await vi.waitFor(() => {
            expect([...host.querySelectorAll('span')].map(s => s.textContent)).toEqual(['c']);
        });
        expect(host.querySelectorAll('li')).toHaveLength(1);
    });

    it('a cleanup final-emit that REORDERS survivors wins over the stale outer pass (issue #23)', async () => {
        stubTemplates({
            root: '<template><ul><li data-for="todos" data-key="$item.id"><div data-component="reorderer" data-component-prop-todo="$item" data-component-on-gone="onGone"></div></li></ul></template>',
            reorderer: `<template><span>\${todo.title}</span></template>
<script>
    export default {
        mounted() {
            return () => {
                this.events.emit('gone', this.props.todo.id);
            };
        },
    };
</script>`,
        });
        const host = mountPoint();
        const app = new Component({
            element: host,
            data: {todos: [{id: 1, title: 'a'}, {id: 2, title: 'b'}, {id: 3, title: 'c'}]},
            methods: {
                onGone(event) {
                    if ((event as CustomEvent).detail === 1) {
                        this.data.todos = [{id: 2, title: 'b'}, {id: 3, title: 'c'}];
                    }
                },
            },
        });
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelectorAll('span')).toHaveLength(3);
        });

        // Evict id 1 with survivors ordered [c, b]; the cleanup's handler
        // re-sets them to [b, c] mid-sweep — the newer pass must win
        app.data.todos = [{id: 3, title: 'c'}, {id: 2, title: 'b'}];

        await vi.waitFor(() => {
            expect([...host.querySelectorAll('span')].map(s => s.textContent)).toEqual(['b', 'c']);
        });
    });

    it('a cleanup final-emit that ADDS an item mid-sweep renders it (issue #22)', async () => {
        stubTemplates({
            root: '<template><ul><li data-for="todos" data-key="$item.id"><div data-component="adder" data-component-prop-todo="$item" data-component-on-gone="onGone"></div></li></ul></template>',
            adder: `<template><span>\${todo.title}</span></template>
<script>
    export default {
        mounted() {
            return () => {
                this.events.emit('gone', this.props.todo.id);
            };
        },
    };
</script>`,
        });
        const host = mountPoint();
        const app = new Component({
            element: host,
            data: {todos: [{id: 1, title: 'a'}, {id: 2, title: 'b'}]},
            methods: {
                onGone(event) {
                    if ((event as CustomEvent).detail === 1) {
                        this.data.todos = [...(this.data.todos as Array<{id: number; title: string}>), {id: 4, title: 'd'}];
                    }
                },
            },
        });
        await app.ready;
        await vi.waitFor(() => {
            expect(host.querySelectorAll('span')).toHaveLength(2);
        });

        // Evict id 1; its cleanup emits, the handler APPENDS id 4 mid-sweep —
        // desired: the added item renders (today the outer sweep destroys it)
        app.data.todos = (app.data.todos as Array<{id: number}>).filter(todo => todo.id !== 1);

        await vi.waitFor(() => {
            expect([...host.querySelectorAll('span')].map(s => s.textContent)).toEqual(['b', 'd']);
        });
    });

    it('recursion through items is rejected as a cycle (block-captured chain), even on a late pass', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({
            tree: `<template><ul><li data-for="kids" data-key="$item.id"><div data-component="tree" data-component-prop-kids="$item.kids"></div></li></ul></template>
<script>export default {data: () => ({})};</script>`,
            root: '<template><div data-component="tree" data-component-prop-kids="topKids"></div></template>',
        });
        const host = mountPoint();
        const app = new Component({element: host, data: {topKids: []}});
        await app.ready;

        app.data.topKids = [{id: 1, kids: []}];

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat().join(' ')).toContain('cycle');
        });
    });
});
