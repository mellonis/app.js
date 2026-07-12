import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('${} interpolation', () => {
    it('renders static and dynamic parts, updates on set, renders 0', async () => {
        stubTemplates({root: '<template><p>Count: ${count}!</p></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {count: 0}});
        await app.ready;

        expect(host.querySelector('p')?.textContent).toBe('Count: 0!');

        app.data.count = 5;

        expect(host.querySelector('p')?.textContent).toBe('Count: 5!');
    });

    it('supports multiple expressions in one text node', async () => {
        stubTemplates({root: '<template><p>${a} + ${b} = ${a + b}</p></template>'});
        const host = mountPoint();
        new App({element: host, data: {a: 1, b: 2}});
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(host.querySelector('p')?.textContent).toBe('1 + 2 = 3');
    });

    it('renders a literal ${ via the \\${ escape without binding it', async () => {
        stubTemplates({root: '<template><p>Literal \\${count} here</p></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {count: 0}});
        await app.ready;

        expect(host.querySelector('p')?.textContent).toBe('Literal ${count} here');

        app.data.count = 5;

        expect(host.querySelector('p')?.textContent).toBe('Literal ${count} here');
    });

    it('renders null and undefined as empty string', async () => {
        stubTemplates({root: '<template><p>[${maybe}]</p></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {maybe: null}});
        await app.ready;

        expect(host.querySelector('p')?.textContent).toBe('[]');

        app.data.maybe = 'x';

        expect(host.querySelector('p')?.textContent).toBe('[x]');
    });

    it('a throwing expression logs and does not block other interpolations', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><p id="bad">${oops()}</p><p id="ok">${title}</p></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {title: 't'}});
        await app.ready;

        expect(host.querySelector('#ok')?.textContent).toBe('t');
        expect(host.querySelector('#bad')?.textContent).toBe('');
        expect(errorSpy).toHaveBeenCalled();

        app.data.title = 't2';

        expect(host.querySelector('#ok')?.textContent).toBe('t2');
    });

    it('works inside data-for items with item scope and updates on replacement', async () => {
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id">${$item.label}:${$index}</li></ul></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {items: [{id: 1, label: 'a'}, {id: 2, label: 'b'}]}});
        await app.ready;

        expect([...host.querySelectorAll('li')].map(li => li.textContent)).toEqual(['a:0', 'b:1']);

        app.data.items = [{id: 2, label: 'B'}, {id: 1, label: 'a'}];

        expect([...host.querySelectorAll('li')].map(li => li.textContent)).toEqual(['B:0', 'a:1']);
    });

    it('evicted items stop updating, without errors', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id">${$item.label}</li></ul></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {items: [{id: 1, label: 'a'}], other: 0}});
        await app.ready;

        const detached = host.querySelector('li')!;

        app.data.items = [];
        app.data.other = 1;

        expect(detached.textContent).toBe('a');
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('errors and yields to data-value when interpolation sits inside a data-value element', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><span data-value="title">x ${title} y</span></template>'});
        const host = mountPoint();
        new App({element: host, data: {title: 't'}});
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(host.querySelector('span')?.textContent).toBe('t');
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('data-value');
    });

    it('an unmatched ${ is a loud wiring error and the text is left as written', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><p>${count</p></template>'});
        const host = mountPoint();
        new App({element: host, data: {count: 0}});
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(host.querySelector('p')?.textContent).toBe('${count');
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('Unmatched');
    });

    it('destroy() stops interpolation updates', async () => {
        stubTemplates({root: '<template><p>${count}</p></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {count: 1}});
        await app.ready;

        app.destroy();
        app.data.count = 2;

        expect(host.querySelector('p')?.textContent).toBe('1');
    });
});
