import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, settle, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('content projection (slots)', () => {
    it('projects default-bucket text and elements in order', async () => {
        stubTemplates({
            root: '<template><div data-component="card">Hello <span id="a">A</span> <span id="b">B</span></div></template>',
            card: '<template><div class="body"><slot>fallback</slot></div></template>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        const body = document.querySelector('.body');

        expect(body?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Hello A B');
        expect(body?.querySelector('#a')).not.toBeNull();
        expect(body?.querySelector('#b')).not.toBeNull();
    });

    it('two elements sharing one data-slot name land in the same bucket, in order', async () => {
        stubTemplates({
            root: '<template><div data-component="card"><span data-slot="x">1</span><span data-slot="x">2</span></div></template>',
            card: '<template><div class="x-slot"><slot name="x">none</slot></div></template>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        expect(document.querySelector('.x-slot')?.textContent).toBe('12');
    });

    it('routes a named data-slot alongside default-bucket content', async () => {
        stubTemplates({
            root: '<template><div data-component="card"><span data-slot="title">T</span><span id="body">B</span></div></template>',
            card: `<template><h2><slot name="title">Untitled</slot></h2><div class="body"><slot>Empty</slot></div></template>
<script>export default {};</script>`,
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        expect(document.querySelector('h2')?.textContent).toBe('T');
        expect(document.querySelector('.body')?.textContent).toBe('B');
    });

    it('a nested data-slot (not top-level) is inert; its ancestor goes wholesale to the default bucket', async () => {
        stubTemplates({
            root: '<template><div data-component="card"><div id="wrap"><span data-slot="title">Nested</span></div></div></template>',
            card: `<template><h2><slot name="title">Untitled</slot></h2><div class="body"><slot>Empty</slot></div></template>
<script>export default {};</script>`,
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        expect(document.querySelector('h2')?.textContent).toBe('Untitled');
        expect(document.querySelector('.body #wrap span')?.textContent).toBe('Nested');
    });

    it('data-slot on a nested data-component wrapper routes the whole wrapper and the child still mounts', async () => {
        stubTemplates({
            root: '<template><div data-component="card"><div data-component="avatar" data-slot="title"></div></div></template>',
            avatar: '<template><em>Av</em></template>\n<script>export default {};</script>',
            card: '<template><h2><slot name="title">Untitled</slot></h2></template>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        expect(document.querySelector('h2 [data-component="avatar"] em')?.textContent).toBe('Av');
    });

    it('fallback renders when the bucket is empty, including its own nested component', async () => {
        stubTemplates({
            root: '<template><div data-component="card"></div></template>',
            card: '<template><div class="body"><slot><span data-component="fallback-widget"></span></slot></div></template>\n<script>export default {};</script>',
            'fallback-widget': '<template><em>FB</em></template>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        // No vi.waitFor: the fallback's own nested component mount must fold
        // into the promise chain ready awaits, not merely happen eventually
        expect(document.querySelector('.body [data-component="fallback-widget"] em')?.textContent).toBe('FB');
    });

    it('a filled bucket never wires its fallback: the fallback template is never fetched', async () => {
        const fetchMock = stubTemplates({
            root: '<template><div data-component="card"><span id="x">content</span></div></template>',
            card: '<template><div class="body"><slot><span data-component="fallback-widget"></span></slot></div></template>\n<script>export default {};</script>',
            'fallback-widget': '<template><em>FB</em></template>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        expect(document.querySelector('.body #x')?.textContent).toBe('content');
        expect(fetchMock.mock.calls.map(call => call[0])).not.toContain('/templates/fallback-widget.html');
    });

    it('projected content resolves through the parent scope', async () => {
        stubTemplates({
            root: '<template><div data-component="card">${title}</div></template>',
            card: '<template><div class="body"><slot>fallback</slot></div></template>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint(), data: {title: 'Hello'}});
        await app.ready;

        expect(document.querySelector('.body')?.textContent).toBe('Hello');
    });

    it('a parent write updates projected content rendered inside the child', async () => {
        stubTemplates({
            root: '<template><div data-component="card">${title}</div></template>',
            card: '<template><div class="body"><slot>fallback</slot></div></template>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint(), data: {title: 'Hello'}});
        await app.ready;

        app.data.title = 'Changed';
        await settle(app);

        expect(document.querySelector('.body')?.textContent).toBe('Changed');
    });

    it('hidden-at-migration: a projected default-bucket data-show-if element hides, then shows, after relocation', async () => {
        stubTemplates({
            root: '<template><div data-component="card"><span id="maybe" data-show-if="visible">shown</span></div></template>',
            card: '<template><div class="body"><slot>none</slot></div></template>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint(), data: {visible: false}});
        await app.ready;

        expect(document.querySelector('#maybe')).toBeNull();

        app.data.visible = true;
        await settle(app);

        expect(document.querySelector('.body #maybe')?.textContent).toBe('shown');
    });

    it('hidden-at-migration: the named case via a data-slot wrapper', async () => {
        stubTemplates({
            root: '<template><div data-component="card"><div data-slot="title"><span id="maybe" data-show-if="visible">shown</span></div></div></template>',
            card: '<template><h2><slot name="title">Untitled</slot></h2></template>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint(), data: {visible: false}});
        await app.ready;

        expect(document.querySelector('#maybe')).toBeNull();

        app.data.visible = true;
        await settle(app);

        expect(document.querySelector('h2 #maybe')?.textContent).toBe('shown');
    });

    it('a projected data-for reconciles inside a slot via a routed wrapper', async () => {
        stubTemplates({
            root: '<template><div data-component="card"><div data-slot="items"><div data-for="items" data-key="$item.id"><span>${$item.name}</span></div></div></div></template>',
            card: '<template><div class="list"><slot name="items">none</slot></div></template>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint(), data: {items: [{id: 1, name: 'a'}, {id: 2, name: 'b'}]}});
        await app.ready;

        expect([...document.querySelectorAll('.list span')].map(el => el.textContent)).toEqual(['a', 'b']);

        app.data.items = [...(app.data.items as unknown[]), {id: 3, name: 'c'}];
        await settle(app);

        expect([...document.querySelectorAll('.list span')].map(el => el.textContent)).toEqual(['a', 'b', 'c']);
    });

    it('a slot region under a child data-show-if detaches and reattaches with projected content intact', async () => {
        stubTemplates({
            root: '<template><div data-component="card"><span id="content">C</span></div></template>',
            card: `<template>
<button id="toggle" data-on-click="toggle">t</button>
<div id="region" data-show-if="expanded"><slot>fallback</slot></div>
<div data-component="spacer"></div>
</template>
<script>
export default {
    data: () => ({expanded: true}),
    methods: {
        toggle() { this.data.expanded = !this.data.expanded; },
    },
};
</script>`,
            spacer: '<template><i>spacer</i></template>',
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        expect(document.querySelector('#region #content')?.textContent).toBe('C');

        (document.querySelector('#toggle') as HTMLButtonElement).click();
        await settle(app);

        expect(document.querySelector('#region')).toBeNull();

        (document.querySelector('#toggle') as HTMLButtonElement).click();
        await settle(app);

        expect(document.querySelector('#region #content')?.textContent).toBe('C');
    });

    it('a slot detached at distribution time (an include sibling forces the early drain) still fills correctly', async () => {
        stubTemplates({
            root: '<template><div data-component="card"><span id="content">C</span></div></template>',
            card: `<template>
<button id="toggle" data-on-click="toggle">t</button>
<div id="region" data-show-if="expanded"><slot>fallback</slot></div>
<div data-component="spacer"></div>
</template>
<script>
export default {
    data: () => ({expanded: false}),
    methods: {
        toggle() { this.data.expanded = !this.data.expanded; },
    },
};
</script>`,
            spacer: '<template><i>spacer</i></template>',
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        expect(document.querySelector('#region')).toBeNull();
        expect(document.querySelector('#content')).toBeNull();

        (document.querySelector('#toggle') as HTMLButtonElement).click();
        await settle(app);

        expect(document.querySelector('#region #content')?.textContent).toBe('C');
    });

    describe('loud errors', () => {
        it('combo ban: data-slot with data-show-if on the same element errors and routes to the default bucket', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({
                root: '<template><div data-component="card"><span data-slot="title" data-show-if="cond">T</span></div></template>',
                card: `<template><h2><slot name="title">Untitled</slot></h2><div class="rest"><slot>none</slot></div></template>
<script>export default {};</script>`,
            });
            const app = new Component({element: mountPoint(), data: {cond: true}});
            await app.ready;

            expect(document.querySelector('h2')?.textContent).toBe('Untitled');
            expect(document.querySelector('.rest')?.textContent).toBe('T');
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/data-slot/);
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/data-show-if/);
        });

        it('combo ban: data-slot with data-for on the same element errors and the data-slot is ignored', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({
                root: '<template><div data-component="card"><div data-slot="items" data-for="items" data-key="$item">${$item}</div></div></template>',
                card: '<template><div class="body"><slot name="items">none</slot></div></template>\n<script>export default {};</script>',
            });
            const app = new Component({element: mountPoint(), data: {items: [1, 2]}});
            await app.ready;

            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/data-slot/);
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/data-for/);
        });

        it('an empty data-slot="" is a loud error; content still routes to the default bucket', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({
                root: '<template><div data-component="card"><span data-slot="">oops</span></div></template>',
                card: '<template><div class="body"><slot>none</slot></div></template>\n<script>export default {};</script>',
            });
            const app = new Component({element: mountPoint()});
            await app.ready;

            expect(document.querySelector('.body')?.textContent).toBe('oops');
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/data-slot/);
        });

        it('duplicate slot names (including two defaults) error; the first slot wins', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({
                root: '<template><div data-component="card"></div></template>',
                card: '<template><slot>a</slot><slot>b</slot></template>\n<script>export default {};</script>',
            });
            const app = new Component({element: mountPoint()});
            await app.ready;

            expect(document.body.textContent).toContain('a');
            expect(document.body.textContent).not.toContain('b');
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/duplicate/i);
        });

        it('a data-slot name with no matching <slot name> is a loud error', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({
                root: '<template><div data-component="card"><span data-slot="nope">x</span></div></template>',
                card: '<template><div class="body"><slot>none</slot></div></template>\n<script>export default {};</script>',
            });
            const app = new Component({element: mountPoint()});
            await app.ready;

            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/nope/);
        });

        it('meaningful default-bucket content with no default slot is a loud error and the content is dropped', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({
                root: '<template><div data-component="card">Loose text and <span>elem</span></div></template>',
                card: '<template><h2><slot name="title">T</slot></h2></template>\n<script>export default {};</script>',
            });
            const app = new Component({element: mountPoint()});
            await app.ready;

            expect(document.querySelector('h2')?.textContent).toBe('T');
            expect(document.body.textContent).not.toContain('elem');
            expect(document.body.textContent).not.toContain('Loose text');
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/default/i);
        });

        it('wrapper content on a slotless template is a loud error and the content is removed', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({
                root: '<template><div data-component="card">I am extra</div></template>',
                card: '<template><span id="only">card body</span></template>\n<script>export default {};</script>',
            });
            const app = new Component({element: mountPoint()});
            await app.ready;

            expect(document.body.textContent).not.toContain('I am extra');
            expect(document.querySelector('#only')?.textContent).toBe('card body');
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/slot/i);
        });

        it('a <slot> inside the child\'s own data-for block is a loud error and is removed', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({
                root: '<template><div data-component="card"></div></template>',
                card: '<template><div data-for="items" data-key="$item"><slot>x</slot></div></template>\n<script>export default {data: () => ({items: [1, 2]})};</script>',
            });
            const app = new Component({element: mountPoint()});
            await app.ready;

            expect(document.querySelector('slot')).toBeNull();
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/data-for/);
        });

        it('a nested <slot> inside another slot\'s fallback is a loud error and the inner slot is removed', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({
                root: '<template><div data-component="card"></div></template>',
                card: '<template><slot name="outer"><span>outer-fallback <slot name="inner">inner-fallback</slot></span></slot></template>\n<script>export default {};</script>',
            });
            const app = new Component({element: mountPoint()});
            await app.ready;

            expect(document.body.textContent).toContain('outer-fallback');
            expect(document.body.textContent).not.toContain('inner-fallback');
            expect(document.querySelector('slot')).toBeNull();
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/nest/i);
        });

        it('a <slot> in the root component\'s template is a loud error (no parent to project from)', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({root: '<template><div><slot>x</slot></div></template>'});
            const app = new Component({element: mountPoint()});
            await app.ready;

            expect(document.body.textContent).toContain('x');
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/root/i);
        });

        it('directives on the <slot> element itself are a loud error', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({
                root: '<template><div data-component="card"></div></template>',
                card: '<template><slot name="title" data-show-if="cond">fallback</slot></template>\n<script>export default {data: () => ({cond: true})};</script>',
            });
            const app = new Component({element: mountPoint()});
            await app.ready;

            expect(document.body.textContent).not.toContain('fallback');
            expect(document.querySelector('slot')).toBeNull();
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/directive/i);
        });

        it('wrapper content on a data-component inside a data-for item is an unconditional loud error', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            stubTemplates({
                root: '<template><ul><li data-for="items" data-key="$item.id"><div data-component="widget">stray</div></li></ul></template>',
                widget: '<template><em>W</em></template>\n<script>export default {};</script>',
            });
            const app = new Component({element: mountPoint(), data: {items: [{id: 1}]}});
            await app.ready;

            await vi.waitFor(() => {
                expect(document.querySelector('em')?.textContent).toBe('W');
            });
            expect(document.body.textContent).not.toContain('stray');
            expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/data-for/);
        });
    });

    it('whitespace-only wrapper content on a slotless template is not an error', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({
            root: '<template><div data-component="card">\n   \n</div></template>',
            card: '<template><span id="only">body</span></template>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        expect(document.querySelector('#only')?.textContent).toBe('body');
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('template-only includes with content keep today\'s precede-and-mix semantics (regression)', async () => {
        stubTemplates({
            root: '<template><div data-component="banner">extra content</div></template>',
            banner: '<template><em>banner-body</em></template>',
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        expect(document.body.textContent).toContain('extra content');
        expect(document.querySelector('em')?.textContent).toBe('banner-body');
    });
});

it('a bare projected data-for fills the slot and reconciles (anchors count as content)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    stubTemplates({
        root: '<template><div data-component="box"><p data-for="items" data-key="$item">${$item}</p></div></template>',
        box: `<template><section><slot>FALLBACK</slot></section></template>
<script>export default {};</script>`,
    });
    const host = mountPoint();
    const app = new Component({element: host, data: {items: [1, 2]}});
    await app.ready;
    await settle(app);

    expect(host.textContent).not.toContain('FALLBACK');
    expect([...host.querySelectorAll('p')].map(p => p.textContent)).toEqual(['1', '2']);

    app.data.items = [1, 2, 3];

    await settle(app);

    expect([...host.querySelectorAll('p')].map(p => p.textContent)).toEqual(['1', '2', '3']);
    expect(errorSpy).not.toHaveBeenCalled();
});

it('a bare projected data-show-if hidden at distribution can still appear later', async () => {
    stubTemplates({
        // The template-only include mounts fast and drains the parent early,
        // hiding the projected span behind its anchor before the slow child
        // component's definition resolves
        root: '<template><div data-component="plain"></div><div data-component="box"><span data-show-if="visible">peek</span></div></template>',
        plain: '<template><i>inc</i></template>',
        box: `<template><section><slot>FALLBACK</slot></section></template>
<script>export default {};</script>`,
    });
    const host = mountPoint();
    const app = new Component({element: host, data: {visible: false}});
    await app.ready;
    await settle(app);

    expect(host.textContent).not.toContain('FALLBACK');

    app.data.visible = true;

    await settle(app);

    expect(host.querySelector('section span')?.textContent).toBe('peek');
});
