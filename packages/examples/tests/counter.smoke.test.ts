import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('counter', 8231);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

it('renders and counts through the real built framework over real HTTP', async () => {
    const page = browser.newPage();
    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const count = () => document.querySelector('p')?.textContent;

    // Interpolation always assigns String(value) to a Text node, so the zero
    // render works even under happy-dom 20.10.6 (whose Element#textContent
    // setter drops falsy non-strings — capricorn86/happy-dom#2236; only
    // data-value bindings that assign numeric 0 are still affected)
    await pollFor(() => count() === 'Count: 0');

    const buttons = [...document.querySelectorAll('button')];
    const plus = buttons.find(button => button.textContent === '+1')!;
    const minus = buttons.find(button => button.textContent === '-1')!;

    plus.click();
    expect(count()).toBe('Count: 1');

    plus.click();
    expect(count()).toBe('Count: 2');

    minus.click();
    expect(count()).toBe('Count: 1');
});
