import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

function injectedStyles(name?: string): HTMLStyleElement[] {
    const all = [...document.head.querySelectorAll<HTMLStyleElement>('style[data-component-style]')];

    return name === undefined ? all : all.filter(element => element.dataset['componentStyle'] === name);
}

const CARD_CSS = `
    .card { border: 1px solid #345; }
    :scope { display: block; }
`;

const CARD_SFC = `<template><p class="card">card</p></template>
<style>${CARD_CSS}</style>
<script>export default {};</script>`;

describe('component styles', () => {
    it('injects one <style data-component-style> per type into document.head, wrapping the file CSS in the @scope rule verbatim', async () => {
        stubTemplates({
            root: '<template><div data-component="card"></div><div data-component="card"></div></template>',
            card: CARD_SFC,
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        expect(host.querySelectorAll('p.card')).toHaveLength(2);

        const styles = injectedStyles('card');

        expect(styles).toHaveLength(1);
        expect(styles[0].parentElement).toBe(document.head);
        expect(styles[0].textContent).toBe(`@scope ([data-component="card"]) to (:scope [data-component-root] > *) {${CARD_CSS}}`);
    });

    it('accepts <style> and <script> siblings in either order', async () => {
        stubTemplates({
            root: '<template><div data-component="pre"></div><div data-component="post"></div></template>',
            pre: '<template><i>a</i></template>\n<style>.pre { color: red; }</style>\n<script>export default {};</script>',
            post: '<template><i>b</i></template>\n<script>export default {};</script>\n<style>.post { color: blue; }</style>',
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        expect([...host.querySelectorAll('i')].map(element => element.textContent)).toEqual(['a', 'b']);
        expect(injectedStyles('pre')).toHaveLength(1);
        expect(injectedStyles('post')).toHaveLength(1);
    });

    it('stamps data-component-root on the root mount and SFC wrappers, never on include wrappers', async () => {
        stubTemplates({
            root: '<template><div data-component="banner"></div><div data-component="card"></div></template>',
            banner: '<template><em>inc</em></template>',
            card: CARD_SFC,
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        expect(host.hasAttribute('data-component-root')).toBe(true);
        expect(host.querySelector('[data-component="card"]')!.hasAttribute('data-component-root')).toBe(true);
        expect(host.querySelector('[data-component="banner"]')!.hasAttribute('data-component-root')).toBe(false);
    });

    it('a <style> sibling in the root component template file rejects ready loudly', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><i>x</i></template><style>i { color: red; }</style>'});
        const app = new Component({element: mountPoint()});

        await expect(app.ready).rejects.toBe('A <style> in the "root" root component\'s template file is not supported — root styles belong to the host page\'s stylesheet');
        expect(injectedStyles()).toHaveLength(0);
    });

    it('a <style> in a template-only file is a loud error, not a silent ignore', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="banner"></div></template>',
            banner: '<template><em>inc</em></template><style>em { color: red; }</style>',
        });
        const app = new Component({element: mountPoint()});

        await expect(app.ready).rejects.toEqual(new Error('The "banner" template-only include cannot carry a <style> — an include has no scope of its own; give it a <script> to make it a component'));
        expect(injectedStyles()).toHaveLength(0);
    });

    it('a duplicate <style>, a duplicate <script>, or a stray element is the file-contract error naming all three parts', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            'root-twice': '<template><div data-component="twice"></div></template>',
            twice: '<template></template><style>.a {}</style><script>export default {};</script><style>.b {}</style>',
            'root-scripts': '<template><div data-component="scripts"></div></template>',
            scripts: '<template></template><script>export default {};</script><script>export default {};</script><style>.c {}</style>',
            'root-stray': '<template><div data-component="stray"></div></template>',
            stray: '<template></template><b>stray</b><script>export default {};</script><style>.d {}</style>',
        });

        const twiceApp = new Component({element: mountPoint(), componentName: 'root-twice'});
        await expect(twiceApp.ready).rejects.toEqual(new Error('The "twice" component file must contain only <template>, <script>, and <style>'));

        const scriptsApp = new Component({element: mountPoint(), componentName: 'root-scripts'});
        await expect(scriptsApp.ready).rejects.toEqual(new Error('The "scripts" component file must contain only <template>, <script>, and <style>'));

        const strayApp = new Component({element: mountPoint(), componentName: 'root-stray'});
        await expect(strayApp.ready).rejects.toEqual(new Error('The "stray" component file must contain only <template>, <script>, and <style>'));

        expect(injectedStyles()).toHaveLength(0);
    });

    it('a whitespace-only <style> injects nothing', async () => {
        stubTemplates({
            root: '<template><div data-component="blank"></div></template>',
            blank: '<template><i>x</i></template>\n<style>\n\n   \n</style>\n<script>export default {};</script>',
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        expect(host.querySelector('i')?.textContent).toBe('x');
        expect(injectedStyles()).toHaveLength(0);
    });

    it('clearTemplateCache removes injected styles from the DOM; a fresh mount re-injects', async () => {
        stubTemplates({
            root: '<template><div data-component="card"></div></template>',
            card: CARD_SFC,
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        expect(injectedStyles('card')).toHaveLength(1);

        Component.clearTemplateCache();

        expect(injectedStyles('card')).toHaveLength(0);

        const again = new Component({element: mountPoint()});
        await again.ready;

        expect(injectedStyles('card')).toHaveLength(1);
    });

    it('destroy() leaves injected styles in place — they are type-level, like the caches', async () => {
        stubTemplates({
            root: '<template><div data-component="card"></div></template>',
            card: CARD_SFC,
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        app.destroy();

        expect(injectedStyles('card')).toHaveLength(1);
    });

    it('quote and backslash characters in a component name arrive escaped in the injected rule', async () => {
        stubTemplates({
            root: `<template><div data-component='we"ir\\d'></div></template>`,
            'we"ir\\d': '<template><i>x</i></template>\n<style>i { color: red; }</style>\n<script>export default {};</script>',
        });
        const app = new Component({element: mountPoint()});
        await app.ready;

        const styles = injectedStyles('we"ir\\d');

        expect(styles).toHaveLength(1);
        expect(styles[0].textContent).toContain('@scope ([data-component="we\\"ir\\\\d"]) to (:scope [data-component-root] > *) {');
    });

    it('a css key in the script export warns as unknown and never injects — styles come from <style> only', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="sneaky"></div></template>',
            sneaky: '<template><i>x</i></template><script>export default {css: ".x { color: red; }"};</script>',
        });
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        expect(host.querySelector('i')?.textContent).toBe('x');
        expect(warnSpy.mock.calls.flat().join(' ')).toContain('css');
        expect(injectedStyles()).toHaveLength(0);
    });
});
