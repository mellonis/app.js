import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
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
        const app = new Component({element: host, data: {visible: true}});

        await vi.waitFor(() => {
            expect(host.querySelector('p')).not.toBeNull();
        });

        app.data.visible = false;
        await app.updated();
        expect(host.querySelector('p')).toBeNull();

        app.data.visible = true;
        await app.updated();
        expect(host.querySelector('p')).not.toBeNull();
    });

    it('shows an initially hidden top-level element when its expression becomes truthy (issue #8)', async () => {
        stubTemplates({root: '<template><p data-show-if="visible">secret</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {visible: false}});
        await app.ready;

        expect(host.querySelector('p')).toBeNull();

        app.data.visible = true;
        await app.updated();
        expect(host.querySelector('p')).not.toBeNull();

        app.data.visible = false;
        await app.updated();
        expect(host.querySelector('p')).toBeNull();
    });

    it('a parse error at wiring logs a caret once and skips only that binding (issue #15)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><p data-show-if="count >">broken</p><i>${count}</i></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {count: 1}});
        await app.ready;

        expect(host.querySelector('i')?.textContent).toBe('1');
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('^');

        const callsAfterMount = errorSpy.mock.calls.length;

        app.data.count = 2;
        await app.updated();

        expect(host.querySelector('i')?.textContent).toBe('2');
        expect(errorSpy.mock.calls.length).toBe(callsAfterMount);
    });
});

describe('data-value', () => {
    it('binds an input two-way for a nested key', async () => {
        stubTemplates({root: '<template><input data-value="user.name"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {user: {name: 'before'}}});

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
        const app = new Component({element: host, data: {element: 'decoy', name: 'before'}});
        await app.ready;

        const input = host.querySelector('input')!;

        input.value = 'after';
        input.dispatchEvent(new Event('input'));

        expect(app.data.name).toBe('after');
    });

    it('binds an input two-way for a top-level key (issue #2)', async () => {
        stubTemplates({root: '<template><input data-value="name"><span>${name}</span></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {name: 'before'}});
        await app.ready;

        const input = host.querySelector('input')!;
        expect(input.value).toBe('before');

        input.value = 'after';
        input.dispatchEvent(new Event('input'));

        expect(app.data.name).toBe('after');
        await app.updated();
        expect(host.querySelector('span')?.textContent).toBe('after');
    });
});

describe('data-value write-back routing (issue #24)', () => {
    it('a parenthesized bare root still writes back through the ghost', async () => {
        stubTemplates({root: '<template><input data-value="(title)"><p>${title}</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {title: 'before'}});
        await app.ready;

        const input = host.querySelector('input')!;

        input.value = 'after';
        input.dispatchEvent(new Event('input'));

        expect(app.data.title).toBe('after');

        await app.updated();

        expect(host.querySelector('p')?.textContent).toBe('after');
    });
});

describe('data-value: assignable paths only', () => {
    it('errors loudly on computed and optional steps and does not bind either input', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><input id="computed" data-value="items[0]"><input id="optional" data-value="user?.name"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: ['before'], user: {name: 'before'}}});
        await app.ready;

        const dotPathErrors = errorSpy.mock.calls.filter(call => String(call[0]).includes('data-value needs a plain dot path'));

        expect(dotPathErrors).toHaveLength(2);

        const computed = host.querySelector<HTMLInputElement>('#computed')!;
        const optional = host.querySelector<HTMLInputElement>('#optional')!;

        // No binding means no initial render either
        expect(computed.value).toBe('');
        expect(optional.value).toBe('');

        computed.value = 'typed';
        computed.dispatchEvent(new Event('input'));
        optional.value = 'typed';
        optional.dispatchEvent(new Event('input'));

        expect(app.data.items).toEqual(['before']);
        expect((app.data.user as Record<string, unknown>).name).toBe('before');
    });

    it('catches and logs a write-back that throws mid-path', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><input data-value="user.address.city"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {user: {address: undefined}}});
        await app.ready;

        const input = host.querySelector('input')!;

        input.value = 'typed';

        expect(() => input.dispatchEvent(new Event('input'))).not.toThrow();

        const writeBackErrors = errorSpy.mock.calls.filter(call => String(call[0]).includes('Can\'t write back the "user.address.city" expression'));

        expect(writeBackErrors).toHaveLength(1);
        expect(writeBackErrors[0]![2]).toBeInstanceOf(TypeError);
        expect((app.data.user as Record<string, unknown>).address).toBeUndefined();
    });
});

describe('data-display-if', () => {
    it('toggles inline display while preserving the original inline value', async () => {
        stubTemplates({root: '<template><p data-display-if="visible" style="display: flex">x</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {visible: false}});
        await app.ready;

        const paragraph = host.querySelector('p')!;

        expect(paragraph).not.toBeNull();
        expect(paragraph.style.display).toBe('none');

        app.data.visible = true;
        await app.updated();

        expect(paragraph.style.display).toBe('flex');
    });

    it('restores an empty inline display so stylesheet rules apply again', async () => {
        stubTemplates({root: '<template><p data-display-if="visible">x</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {visible: true}});
        await app.ready;

        const paragraph = host.querySelector('p')!;

        expect(paragraph.style.display).toBe('');

        app.data.visible = false;
        await app.updated();

        expect(paragraph.style.display).toBe('none');

        app.data.visible = true;
        await app.updated();

        expect(paragraph.style.display).toBe('');
    });

    it('keeps the element in the DOM so sibling structure is stable', async () => {
        stubTemplates({root: '<template><div><i data-display-if="visible">a</i><i>b</i></div></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {visible: false}});
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
        const app = new Component({element: host, data: {items: [{id: 1, on: true, label: 'a'}, {id: 2, on: false, label: 'b'}]}});
        await app.ready;

        const spans = [...host.querySelectorAll('span')] as HTMLElement[];

        expect(spans).toHaveLength(2);
        expect(spans[0].style.display).toBe('');
        expect(spans[1].style.display).toBe('none');

        app.data.items = [{id: 1, on: true, label: 'a'}, {id: 2, on: true, label: 'b'}];
        await app.updated();

        expect(spans[1].style.display).toBe('');
    });

    it('works on the data-for element itself (per-item visibility)', async () => {
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id" data-display-if="$item.on">${$item.label}</li></ul></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, on: false, label: 'a'}, {id: 2, on: true, label: 'b'}]}});
        await app.ready;

        const listItems = [...host.querySelectorAll('li')] as HTMLElement[];

        expect(listItems).toHaveLength(2);
        expect(listItems[0].style.display).toBe('none');
        expect(listItems[1].style.display).toBe('');

        app.data.items = [{id: 1, on: true, label: 'a'}, {id: 2, on: true, label: 'b'}];
        await app.updated();

        expect(listItems[0].style.display).toBe('');
    });

    it('evicted items stop being toggled, without errors', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id"><span data-display-if="$item.on"></span></li></ul></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, on: true}], other: 0}});
        await app.ready;

        const detachedSpan = host.querySelector('span')! as HTMLElement;

        app.data.items = [];
        app.data.other = 1;

        expect(detachedSpan.style.display).toBe('');
        expect(errorSpy).not.toHaveBeenCalled();
    });
});

describe('data-disabled-if', () => {
    it('toggles element.disabled on write (root)', async () => {
        stubTemplates({root: '<template><input data-disabled-if="locked"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {locked: true}});
        await app.ready;

        const input = host.querySelector('input')!;

        expect(input.disabled).toBe(true);

        app.data.locked = false;
        await app.updated();
        expect(input.disabled).toBe(false);

        app.data.locked = true;
        await app.updated();
        expect(input.disabled).toBe(true);
    });

    it('works inside data-for items with item scope', async () => {
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id"><button data-disabled-if="$item.locked">${$item.label}</button></li></ul></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, locked: true, label: 'a'}, {id: 2, locked: false, label: 'b'}]}});
        await app.ready;

        const buttons = [...host.querySelectorAll('button')] as HTMLButtonElement[];

        expect(buttons[0].disabled).toBe(true);
        expect(buttons[1].disabled).toBe(false);

        app.data.items = [{id: 1, locked: false, label: 'a'}, {id: 2, locked: false, label: 'b'}];
        await app.updated();

        expect(buttons[0].disabled).toBe(false);
    });

    it('works on the data-for element itself', async () => {
        stubTemplates({root: '<template><div><button data-for="items" data-key="$item.id" data-disabled-if="$item.locked">${$item.label}</button></div></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, locked: true, label: 'a'}, {id: 2, locked: false, label: 'b'}]}});
        await app.ready;

        const buttons = [...host.querySelectorAll('button')] as HTMLButtonElement[];

        expect(buttons).toHaveLength(2);
        expect(buttons[0].disabled).toBe(true);
        expect(buttons[1].disabled).toBe(false);

        app.data.items = [{id: 1, locked: false, label: 'a'}, {id: 2, locked: false, label: 'b'}];
        await app.updated();

        expect(buttons[0].disabled).toBe(false);
    });

    it('errors loudly on a non-disableable element and does not bind', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><p data-disabled-if="true">text</p></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {}});
        await app.ready;

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('input, textarea, select, button');

        const paragraph = host.querySelector('p')!;

        expect(() => app.updated()).not.toThrow();
        expect(paragraph.textContent).toBe('text');
    });

    it('composes with data-value on the same control (disabled input keeps its binding)', async () => {
        stubTemplates({root: '<template><input data-value="name" data-disabled-if="locked"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {name: 'before', locked: true}});
        await app.ready;

        const input = host.querySelector('input')!;

        expect(input.disabled).toBe(true);
        expect(input.value).toBe('before');

        app.data.name = 'after';
        await app.updated();
        expect(input.value).toBe('after');

        app.data.locked = false;
        await app.updated();
        expect(input.disabled).toBe(false);

        input.value = 'typed';
        input.dispatchEvent(new Event('input'));
        expect(app.data.name).toBe('typed');
    });

    it('composes with data-show-if on the same element (independent bindings)', async () => {
        stubTemplates({root: '<template><div><button data-show-if="visible" data-disabled-if="locked">go</button></div></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {visible: true, locked: true}});
        await app.ready;

        const button = host.querySelector('button') as HTMLButtonElement;

        expect(button.disabled).toBe(true);

        app.data.locked = false;
        await app.updated();
        expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(false);

        app.data.visible = false;
        await app.updated();
        expect(host.querySelector('button')).toBeNull();

        app.data.visible = true;
        await app.updated();
        expect(host.querySelector('button')).not.toBeNull();
        expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    });

    it('evicted items stop being toggled, without errors', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id"><button data-disabled-if="$item.locked"></button></li></ul></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, locked: true}], other: 0}});
        await app.ready;

        const detachedButton = host.querySelector('button') as HTMLButtonElement;

        app.data.items = [];
        app.data.other = 1;

        expect(detachedButton.disabled).toBe(true);
        expect(errorSpy).not.toHaveBeenCalled();
    });
});

describe('data-value: form controls only (issue #18)', () => {
    it('binds a textarea two-way', async () => {
        stubTemplates({root: '<template><textarea data-value="note"></textarea></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {note: 'before'}});
        await app.ready;

        const textarea = host.querySelector('textarea')!;

        expect(textarea.value).toBe('before');

        textarea.value = 'after';
        textarea.dispatchEvent(new Event('input'));

        expect(app.data.note).toBe('after');

        app.data.note = 'again';
        await app.updated();

        expect(textarea.value).toBe('again');
    });

    it('binds a select two-way via the change event', async () => {
        stubTemplates({root: '<template><select data-value="pick"><option value="a">A</option><option value="b">B</option></select></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {pick: 'b'}});
        await app.ready;

        const select = host.querySelector('select')!;

        expect(select.value).toBe('b');

        select.value = 'a';
        select.dispatchEvent(new Event('change'));

        expect(app.data.pick).toBe('a');
    });

    it('errors on file inputs (write-back is impossible; use data-on-change instead)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><input type="file" data-value="upload"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {upload: null}});
        await app.ready;

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('data-on-change');

        const input = host.querySelector('input')!;

        input.dispatchEvent(new Event('change'));

        expect(app.data.upload).toBe(null);
    });

    it('errors loudly on a non-form element and does not bind', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><span data-value="title">static</span></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {title: 't'}});
        await app.ready;

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('form controls');

        const span = host.querySelector('span')!;

        expect(span.textContent).toBe('static');

        app.data.title = 't2';

        expect(span.textContent).toBe('static');
    });
});

describe('data-value: checkbox and radio (issue #19)', () => {
    it('binds a checkbox two-way via checked', async () => {
        stubTemplates({root: '<template><input type="checkbox" data-value="agree"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {agree: false}});
        await app.ready;

        const box = host.querySelector('input')!;

        expect(box.checked).toBe(false);

        box.checked = true;
        box.dispatchEvent(new Event('change'));

        expect(app.data.agree).toBe(true);

        app.data.agree = false;
        await app.updated();

        expect(box.checked).toBe(false);
    });

    it('coerces a truthy non-boolean into checked and writes back real booleans', async () => {
        stubTemplates({root: '<template><input type="checkbox" data-value="agree"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {agree: 1}});
        await app.ready;

        const box = host.querySelector('input')!;

        expect(box.checked).toBe(true);

        box.checked = false;
        box.dispatchEvent(new Event('change'));

        expect(app.data.agree).toBe(false);

        box.checked = true;
        box.dispatchEvent(new Event('change'));

        expect(app.data.agree).toBe(true);
    });

    it('binds a group of radios sharing one expression', async () => {
        stubTemplates({root: '<template><input type="radio" value="a" data-value="pick"><input type="radio" value="b" data-value="pick"><input type="radio" value="c" data-value="pick"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {pick: 'b'}});
        await app.ready;

        const [a, b, c] = [...host.querySelectorAll('input')] as HTMLInputElement[];

        expect(a.checked).toBe(false);
        expect(b.checked).toBe(true);
        expect(c.checked).toBe(false);

        c.checked = true;
        c.dispatchEvent(new Event('change'));

        expect(app.data.pick).toBe('c');

        await app.updated();

        expect(a.checked).toBe(false);
        expect(b.checked).toBe(false);
        expect(c.checked).toBe(true);
    });
});

describe('data-on-*', () => {
    it('dispatches click to the named method, bound to the app, with the event', async () => {
        stubTemplates({root: '<template><button data-on-click="hit">go</button></template>'});
        const host = mountPoint();
        const calls: Array<{self: unknown; event: Event}> = [];
        const app = new Component({
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
        new Component({element: host, methods: {onSubmit}});

        const form = await vi.waitFor(() => {
            const el = host.querySelector('form');
            expect(el).not.toBeNull();
            return el!;
        });

        form.dispatchEvent(new Event('submit'));

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('a typo in the method name logs loudly at wiring time, not at click, and clicking does nothing (issue #27)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({root: '<template><button data-on-click="missing">go</button></template>'});
        const host = mountPoint();
        new Component({element: host});

        const button = await vi.waitFor(() => {
            const el = host.querySelector('button');
            expect(el).not.toBeNull();
            return el!;
        });

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('missing');

        const errorsAtMount = errorSpy.mock.calls.length;

        expect(() => button.click()).not.toThrow();
        expect(errorSpy.mock.calls.length).toBe(errorsAtMount);
    });

    it('a valid method registers with no wiring error (guards against false positives)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({root: '<template><button data-on-click="hit">go</button></template>'});
        const host = mountPoint();
        const hit = vi.fn();
        new Component({element: host, methods: {hit}});

        const button = await vi.waitFor(() => {
            const el = host.querySelector('button');
            expect(el).not.toBeNull();
            return el!;
        });

        expect(errorSpy).not.toHaveBeenCalled();

        button.click();

        expect(hit).toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('a typo in an in-item handler logs once per clone wiring (issue #27)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id" data-on-click="oops">${$item.label}</li></ul></template>'});
        const host = mountPoint();
        const app = new Component({
            element: host,
            data: {items: [{id: 1, label: 'a'}, {id: 2, label: 'b'}]},
        });
        await app.ready;

        const oopsErrors = errorSpy.mock.calls.filter(call => call.some(arg => typeof arg === 'string' && arg.includes('oops')));

        expect(oopsErrors).toHaveLength(2);

        const errorsAfterMount = errorSpy.mock.calls.length;

        host.querySelectorAll('li').forEach(item => {
            expect(() => item.dispatchEvent(new Event('click'))).not.toThrow();
        });

        expect(errorSpy.mock.calls.length).toBe(errorsAfterMount);
    });
});

describe('data-on-*: binds any DOM event by name (issue #20)', () => {
    it('binds data-on-change on a select', async () => {
        stubTemplates({root: '<template><select data-on-change="picked"><option value="a">A</option><option value="b">B</option></select></template>'});
        const host = mountPoint();
        const picked = vi.fn();
        new Component({element: host, methods: {picked}});

        const select = await vi.waitFor(() => {
            const el = host.querySelector('select');
            expect(el).not.toBeNull();
            return el!;
        });

        select.dispatchEvent(new Event('change'));

        expect(picked).toHaveBeenCalledTimes(1);
    });

    it('binds data-on-keydown on an input', async () => {
        stubTemplates({root: '<template><input data-on-keydown="keyed"></template>'});
        const host = mountPoint();
        const keyed = vi.fn();
        new Component({element: host, methods: {keyed}});

        const input = await vi.waitFor(() => {
            const el = host.querySelector('input');
            expect(el).not.toBeNull();
            return el!;
        });

        input.dispatchEvent(new KeyboardEvent('keydown'));

        expect(keyed).toHaveBeenCalledTimes(1);
    });

    it('binds data-on-input on an input (previously silently ignored)', async () => {
        stubTemplates({root: '<template><input data-on-input="typed"></template>'});
        const host = mountPoint();
        const typed = vi.fn();
        new Component({element: host, methods: {typed}});

        const input = await vi.waitFor(() => {
            const el = host.querySelector('input');
            expect(el).not.toBeNull();
            return el!;
        });

        input.dispatchEvent(new Event('input'));

        expect(typed).toHaveBeenCalledTimes(1);
    });

    it('fires both handlers when an element carries two data-on-* attributes', async () => {
        stubTemplates({root: '<template><button data-on-click="onClick" data-on-mouseenter="onEnter">go</button></template>'});
        const host = mountPoint();
        const onClick = vi.fn();
        const onEnter = vi.fn();
        new Component({element: host, methods: {onClick, onEnter}});

        const button = await vi.waitFor(() => {
            const el = host.querySelector('button');
            expect(el).not.toBeNull();
            return el!;
        });

        button.dispatchEvent(new Event('mouseenter'));
        button.click();

        expect(onEnter).toHaveBeenCalledTimes(1);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('an in-item data-on-mouseenter receives (event, item, index)', async () => {
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id" data-on-mouseenter="hover">${$item.label}</li></ul></template>'});
        const host = mountPoint();
        const calls: Array<{item: unknown; index: number | undefined}> = [];
        const app = new Component({
            element: host,
            data: {items: [{id: 1, label: 'a'}, {id: 2, label: 'b'}]},
            methods: {
                hover(event: Event, item?: unknown, index?: number) {
                    calls.push({item, index});
                },
            },
        });
        await app.ready;

        const listItems = host.querySelectorAll('li');
        listItems[1].dispatchEvent(new Event('mouseenter'));

        expect(calls).toEqual([{item: {id: 2, label: 'b'}, index: 1}]);
    });

    it('a typo in the event name binds silently and never fires (documents the trade-off)', async () => {
        stubTemplates({root: '<template><button data-on-clikc="hit">typo</button><button data-on-click="hit">correct</button></template>'});
        const host = mountPoint();
        const hit = vi.fn();
        new Component({element: host, methods: {hit}});

        const buttons = await vi.waitFor(() => {
            const els = host.querySelectorAll('button');
            expect(els).toHaveLength(2);
            return [...els] as HTMLButtonElement[];
        });

        buttons[0].click();
        expect(hit).not.toHaveBeenCalled();

        buttons[1].click();
        expect(hit).toHaveBeenCalledTimes(1);
    });
});
