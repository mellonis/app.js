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
