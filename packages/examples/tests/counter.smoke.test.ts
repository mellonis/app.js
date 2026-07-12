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
    const count = () => document.querySelector('span[data-value="count"]')?.textContent;

    // Gate on the buttons existing (proof the initial async render has landed) rather than
    // count() === '0': happy-dom 20.10.6's Element#textContent setter no-ops on falsy values
    // (`if (textContent) { ... }` in its source), so the real, spec-correct `textContent = 0`
    // the framework performs for count 0 never becomes the string "0" in this environment.
    await pollFor(() => document.querySelectorAll('button').length === 2);

    const buttons = [...document.querySelectorAll('button')];
    const plus = buttons.find(button => button.textContent === '+1')!;
    const minus = buttons.find(button => button.textContent === '-1')!;

    plus.click();
    expect(count()).toBe('1');

    plus.click();
    expect(count()).toBe('2');

    minus.click();
    expect(count()).toBe('1');
});
