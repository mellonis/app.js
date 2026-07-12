import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/app';
import { resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
});

describe('App.loadTemplate', () => {
    it('fetches each template once and caches the promise', async () => {
        const fetchMock = stubTemplates({widget: '<template><i></i></template>'});

        await App.loadTemplate('widget');
        await App.loadTemplate('widget');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('/templates/widget.html');
    });

    it('evicts a failed fetch from the cache so it can be retried', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        stubTemplates({});

        await expect(App.loadTemplate('late')).rejects.toBeUndefined();
        expect(App.templateNameToTemplatePromiseMap.has('late')).toBe(false);

        const fetchMock = stubTemplates({late: '<template></template>'});

        await expect(App.loadTemplate('late')).resolves.toBe('<template></template>');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
