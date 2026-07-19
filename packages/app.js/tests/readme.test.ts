import { describe, expect, it } from 'vitest';
import Component from '../src/app';
import { mountPoint, settle, stubTemplates } from './helpers';

// The README's Hello world snippet is the first code a student runs, so it is
// pinned here against silent rot: the template and options below are that
// section verbatim, with one TS-only accommodation — data is typed
// Record<string, unknown>, so the counter write needs a cast that the
// README's plain-JS snippet does not.
describe('README hello world', () => {
    it('renders and counts exactly as written', async () => {
        // Copied verbatim from README's Hello world section
        stubTemplates({
            root: `<template>
    <h1>Hello, \${name}!</h1>
    <button data-on-click="bump">clicks: \${count}</button>
</template>`,
        });
        const host = mountPoint();
        const app = new Component({
            element: host,
            data: {name: 'world', count: 0},
            methods: {
                bump() { (this.data as {count: number}).count += 1; },
            },
        });

        await app.ready;
        await settle(app);

        expect(host.querySelector('h1')?.textContent).toBe('Hello, world!');
        expect(host.querySelector('button')?.textContent).toBe('clicks: 0');

        host.querySelector('button')!.dispatchEvent(new Event('click'));
        await settle(app);

        expect(host.querySelector('button')?.textContent).toBe('clicks: 1');
    });
});
