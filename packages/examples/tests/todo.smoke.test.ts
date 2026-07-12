import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('todo', 8233);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

it('adds, toggles, and removes todos through the real built framework', async () => {
    const page = browser.newPage();

    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;

    await pollFor(() => document.querySelector('form') !== null);
    expect(document.querySelector('p')?.textContent).toContain('Nothing to do');

    const input = document.querySelector('input')!;
    const form = document.querySelector('form')!;

    const add = async (title: string) => {
        input.value = title;
        input.dispatchEvent(new windowRealm.Event('input'));
        form.dispatchEvent(new windowRealm.Event('submit'));
        await pollFor(() => [...document.querySelectorAll('li')].some(li => li.textContent!.includes(title)));
    };

    await add('Learn keys');
    expect(document.querySelector('li span')?.textContent).toBe('Learn keys');
    expect(input.value).toBe('');

    await add('Ship v1');
    expect(document.querySelectorAll('li')).toHaveLength(2);

    const buttonIn = (index: number, label: string) =>
        [...document.querySelectorAll('li')[index].querySelectorAll('button')].find(b => b.textContent === label)!;

    buttonIn(0, 'toggle').click();
    await pollFor(() => document.querySelector('li s') !== null);
    expect(document.querySelector('li s')?.textContent).toBe('Learn keys');

    buttonIn(1, 'remove').click();
    await pollFor(() => document.querySelectorAll('li').length === 1);
    expect(document.querySelector('li s')?.textContent).toBe('Learn keys');
});
