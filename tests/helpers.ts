import { vi } from 'vitest';
import App from '../src/app';

export function stubTemplates(templates: Record<string, string>) {
    const fetchMock = vi.fn((url: string) => {
        const match = /^\/templates\/(.+)\.html$/.exec(url);
        const name = match?.[1];

        if (name && name in templates) {
            return Promise.resolve({text: () => Promise.resolve(templates[name])});
        }

        return Promise.reject(new Error(`404: ${url}`));
    });

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
}

export function resetTemplateCache(): void {
    App.templateNameToTemplatePromiseMap.clear();
}

export function mountPoint(): HTMLElement {
    const element = document.createElement('div');

    document.body.appendChild(element);

    return element;
}

export function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}
