import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('cards', 8236);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

it('projects, falls back, and keeps projected content reactive through the real built framework', async () => {
    const page = browser.newPage();

    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;

    await pollFor(() => document.querySelectorAll('.card').length === 3);

    // The card component's own CSS arrived in the page head, once, scoped
    const injectedStyle = document.head.querySelector('style[data-component-style="card"]');

    expect(injectedStyle).not.toBeNull();
    expect(injectedStyle!.textContent).toContain('@scope ([data-component="card"]) to (:scope [data-component-root] > *) {');

    const [about, guests, empty] = [...document.querySelectorAll('.card')];

    // Named routing replaced the title fallback; the empty card kept both fallbacks
    expect(about.querySelector('h2')?.textContent).toBe('JS study group');
    expect(empty.querySelector('h2')?.textContent).toBe('Untitled');
    expect(empty.querySelector('.card-body')?.textContent).toContain('Nothing here yet.');

    // The details paragraph was hidden when its content migrated into the card;
    // a parent-owned handler still swaps it back in, inside the child's subtree
    const detailsShown = () => about.textContent!.includes('coffee machine');

    expect(detailsShown()).toBe(false);
    [...about.querySelectorAll('button')].find(button => button.textContent === 'Details')!.click();
    await pollFor(detailsShown);

    // Projected interpolation and the projected list read the parent's data
    expect(guests.querySelector('h2')?.textContent).toBe('Guests (2)');
    expect([...guests.querySelectorAll('li')].map(li => li.querySelector('span')?.textContent)).toEqual(['Ada', 'Linus']);

    const input = guests.querySelector('input')!;
    const form = guests.querySelector('form')!;

    input.value = 'Grace';
    input.dispatchEvent(new windowRealm.Event('input'));
    form.dispatchEvent(new windowRealm.Event('submit'));
    await pollFor(() => guests.querySelectorAll('li').length === 3);
    expect(guests.querySelector('h2')?.textContent).toBe('Guests (3)');
    expect(input.value).toBe('');

    // Handlers inside the projected list resolve through the parent too
    [...guests.querySelectorAll('li')][0].querySelector('button')!.click();
    await pollFor(() => guests.querySelectorAll('li').length === 2);
    expect([...guests.querySelectorAll('li')].map(li => li.querySelector('span')?.textContent)).toEqual(['Linus', 'Grace']);
    expect(guests.querySelector('h2')?.textContent).toBe('Guests (2)');
});
