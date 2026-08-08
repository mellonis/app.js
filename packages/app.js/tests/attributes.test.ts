import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('data-src', () => {
    it('renders the src attribute from a data expression', async () => {
        stubTemplates({root: '<template><img data-src="photo.url"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {photo: {url: '/photo/1'}}});
        await app.ready;

        expect(host.querySelector('img')?.getAttribute('src')).toBe('/photo/1');
    });

    it('updates the attribute after a data write', async () => {
        stubTemplates({root: '<template><img data-src="photo.url"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {photo: {url: '/photo/1'}}});
        await app.ready;

        const img = host.querySelector('img')!;

        expect(img.getAttribute('src')).toBe('/photo/1');

        (app.data.photo as {url: string}).url = '/photo/2';
        await app.updated();

        expect(img.getAttribute('src')).toBe('/photo/2');
    });

    it('removes the attribute when the expression turns null', async () => {
        stubTemplates({root: '<template><img data-src="photo.url"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {photo: {url: '/photo/1'}}});
        await app.ready;

        const img = host.querySelector('img')!;

        expect(img.getAttribute('src')).toBe('/photo/1');

        (app.data.photo as {url: string | null}).url = null;
        await app.updated();

        expect(img.hasAttribute('src')).toBe(false);
    });

    it('removes the attribute when the expression turns empty-string (issue #36)', async () => {
        stubTemplates({root: '<template><img data-src="photo.url"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {photo: {url: '/photo/1'}}});
        await app.ready;

        const img = host.querySelector('img')!;

        expect(img.getAttribute('src')).toBe('/photo/1');

        (app.data.photo as {url: string}).url = '';
        await app.updated();

        expect(img.hasAttribute('src')).toBe(false);
    });

    it('works inside data-for items with item scope', async () => {
        stubTemplates({root: '<template><ul><li data-for="items" data-key="$item.id"><img data-src="$item.url"></li></ul></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, url: '/photo/1'}, {id: 2, url: '/photo/2'}]}});
        await app.ready;

        const images = [...host.querySelectorAll('img')] as HTMLImageElement[];

        expect(images).toHaveLength(2);
        expect(images[0].getAttribute('src')).toBe('/photo/1');
        expect(images[1].getAttribute('src')).toBe('/photo/2');

        app.data.items = [{id: 1, url: '/photo/1'}, {id: 2, url: '/photo/2-updated'}];
        await app.updated();

        expect(images[1].getAttribute('src')).toBe('/photo/2-updated');
    });

    it('rejects data-src on a script element with a loud error, siblings unaffected (issue #37)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({root: '<template><script data-src="url"></script><img data-src="url"></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {url: '/photo/1'}});
        await app.ready;

        const script = host.querySelector('script')!;

        expect(script.hasAttribute('src')).toBe(false);
        expect(host.querySelector('img')?.getAttribute('src')).toBe('/photo/1');
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('data-src cannot drive a <script>');

        app.data.url = '/photo/2';
        await app.updated();

        expect(script.hasAttribute('src')).toBe(false);
    });

    it('rejects data-src on a script inside a data-for item (issue #37)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        stubTemplates({root: '<template><div data-for="items" data-key="$item.id"><script data-src="$item.url"></script></div></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {items: [{id: 1, url: '/item.js'}]}});
        await app.ready;

        const script = host.querySelector('script')!;

        expect(script.hasAttribute('src')).toBe(false);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('data-src cannot drive a <script>');
    });

    it('works on the data-for element itself (per-item images)', async () => {
        stubTemplates({root: '<template><div><img data-for="photos" data-key="$item.id" data-src="$item.url"></div></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {photos: [{id: 1, url: '/photo/1'}, {id: 2, url: '/photo/2'}]}});
        await app.ready;

        const images = [...host.querySelectorAll('img')] as HTMLImageElement[];

        expect(images).toHaveLength(2);
        expect(images[0].getAttribute('src')).toBe('/photo/1');
        expect(images[1].getAttribute('src')).toBe('/photo/2');

        app.data.photos = [{id: 1, url: '/photo/1-updated'}, {id: 2, url: '/photo/2'}];
        await app.updated();

        expect(images[0].getAttribute('src')).toBe('/photo/1-updated');
    });
});
