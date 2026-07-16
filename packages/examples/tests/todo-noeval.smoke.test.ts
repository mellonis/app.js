import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('todo', 8234);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

// The stub in noeval.html disables window.eval/window.Function before any
// other script runs. This test proves the framework never needed them: the
// full todo flow — mount, add, toggle, remove, and the |> pipe footer —
// works identically to todo.smoke.test.ts under real HTTP with no-eval on.
it('adds, toggles, and removes todos through the real built framework with eval and Function disabled', async () => {
    const page = browser.newPage();

    await page.goto(`${example.baseUrl}/noeval.html`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;
    const footer = () => [...document.querySelectorAll('p')].find(p => p.textContent!.endsWith('left'));

    await pollFor(() => document.querySelector('form') !== null);
    expect(document.querySelector('p')?.textContent).toContain('Nothing to do');
    expect(footer()?.textContent).toBe('0 left');

    const input = document.querySelector('input')!;
    const form = document.querySelector('form')!;

    const add = async (title: string) => {
        input.value = title;
        input.dispatchEvent(new windowRealm.Event('input'));
        // Let the typed-input flush settle (and its write-back skip-once
        // consume) before submit's own write to the same path, so the
        // draft-clearing render isn't stranded behind it
        await new Promise(resolve => setTimeout(resolve, 0));
        form.dispatchEvent(new windowRealm.Event('submit'));
        await pollFor(() => [...document.querySelectorAll('li')].some(li => li.textContent!.includes(title)));
    };

    await add('Learn keys');
    expect(document.querySelector('li span')?.textContent).toBe('Learn keys');
    expect(input.value).toBe('');
    expect(footer()?.textContent).toBe('1 left');

    await add('Ship v1');
    expect(document.querySelectorAll('li')).toHaveLength(2);
    expect(footer()?.textContent).toBe('2 left');

    const buttonIn = (index: number, label: string) =>
        [...document.querySelectorAll('li')[index].querySelectorAll('button')].find(b => b.textContent === label)!;

    buttonIn(0, 'toggle').click();
    await pollFor(() => document.querySelector('li s') !== null);
    expect(document.querySelector('li s')?.textContent).toBe('Learn keys');
    expect(footer()?.textContent).toBe('1 left');

    buttonIn(1, 'remove').click();
    await pollFor(() => document.querySelectorAll('li').length === 1);
    expect(document.querySelector('li s')?.textContent).toBe('Learn keys');
    expect(footer()?.textContent).toBe('0 left');

    expect(typeof windowRealm.eval).toBe('function');
    expect(() => windowRealm.eval('1')).toThrow('eval is disabled on this page');
    expect(() => new windowRealm.Function('return 1')()).toThrow('Function is disabled on this page');
});
