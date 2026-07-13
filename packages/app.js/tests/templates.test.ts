import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
});

describe('Component.loadTemplate', () => {
    it('fetches each template once and caches the promise', async () => {
        const fetchMock = stubTemplates({widget: '<template><i></i></template>'});

        await Component.loadTemplate('widget');
        await Component.loadTemplate('widget');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('/templates/widget.html');
    });

    it('evicts a failed fetch from the cache so it can be retried', async () => {
        stubTemplates({});

        await expect(Component.loadTemplate('late')).rejects.toEqual(new Error('404: /templates/late.html'));

        const fetchMock = stubTemplates({late: '<template></template>'});

        await expect(Component.loadTemplate('late')).resolves.toBe('<template></template>');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('evicts an HTTP error response so it can be retried (issue #9)', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: false,
            status: 404,
            text: () => Promise.resolve('<h1>Not Found</h1>'),
        })));

        await expect(Component.loadTemplate('late')).rejects.toEqual(new Error('HTTP 404 for late'));

        const fetchMock = stubTemplates({late: '<template></template>'});

        await expect(Component.loadTemplate('late')).resolves.toBe('<template></template>');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
