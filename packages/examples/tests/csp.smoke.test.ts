import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('csp', 8238);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

it('runs with the strict-CSP page shape: no inline scripts, component code loaded from real files', async () => {
    const page = browser.newPage();
    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;

    // Two instances of the external-script component, each with its own state
    await pollFor(() => document.querySelectorAll('[data-component="tally"] button').length === 2);

    const [left, right] = [...document.querySelectorAll('[data-component="tally"] button')];

    expect(left.textContent).toBe('Left: 0');
    expect(right.textContent).toBe('Right: 0');

    left.dispatchEvent(new windowRealm.Event('click'));
    left.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => left.textContent === 'Left: 2');

    expect(right.textContent).toBe('Right: 0');
});

it('drives the badge image src from data, and absent data removes the attribute (data-src)', async () => {
    const page = browser.newPage();
    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;

    await pollFor(() => document.querySelector('#badge') !== null);

    const badge = document.querySelector('#badge')!;
    const next = document.querySelector('#badge-next')!;
    const clear = document.querySelector('#badge-clear')!;

    // Seeded null: no src at all — never src=""
    expect(badge.hasAttribute('src')).toBe(false);

    next.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => badge.getAttribute('src') === '/img/one.svg');

    next.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => badge.getAttribute('src') === '/img/two.svg');

    clear.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => !badge.hasAttribute('src'));
});
