import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import type { HTMLInputElement } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('profile', 8237);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

it('keeps an editable child\'s draft separate from the parent\'s value, per instance', async () => {
    const page = browser.newPage();
    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;

    await pollFor(() => document.querySelectorAll('input').length === 2);

    const [nameInput, taglineInput] = [...document.querySelectorAll('input')] as unknown as HTMLInputElement[];
    const preview = document.querySelector('#preview')!;
    // The dirty marker is an interpolation, not a directive — a clean field
    // renders an empty span, so count the ones actually reading "unsaved"
    const dirtyCount = () => [...document.querySelectorAll('.dirty')].filter(el => el.textContent === 'unsaved').length;

    // Seeded from the parent's values through props
    expect(nameInput.value).toBe('Ada Lovelace');
    expect(taglineInput.value).toBe('Mathematician');
    expect(preview.textContent).toBe('Ada Lovelace — Mathematician');

    // Typing moves the DRAFT only: the parent's value is untouched
    nameInput.value = 'Ada King';
    nameInput.dispatchEvent(new windowRealm.Event('input'));
    await pollFor(() => dirtyCount() === 1);
    expect(preview.textContent).toBe('Ada Lovelace — Mathematician');

    // Cancel restores the draft from the prop; the parent never moved
    const [nameCancel] = [...document.querySelectorAll('button')].filter(b => b.textContent === 'Cancel');
    nameCancel.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => nameInput.value === 'Ada Lovelace');
    expect(preview.textContent).toBe('Ada Lovelace — Mathematician');

    // Save commits the draft upward
    nameInput.value = 'Ada King';
    nameInput.dispatchEvent(new windowRealm.Event('input'));
    const [nameSave] = [...document.querySelectorAll('button')].filter(b => b.textContent === 'Save');
    nameSave.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => preview.textContent === 'Ada King — Mathematician');

    // Per-instance state: edit BOTH, cancel one, the other's draft survives.
    // This is the assertion that catches shared state between instances.
    nameInput.value = 'Ada L.';
    nameInput.dispatchEvent(new windowRealm.Event('input'));
    taglineInput.value = 'First programmer';
    taglineInput.dispatchEvent(new windowRealm.Event('input'));
    await pollFor(() => dirtyCount() === 2);

    nameCancel.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => nameInput.value === 'Ada King');

    expect(taglineInput.value).toBe('First programmer');
    expect(dirtyCount()).toBe(1);

    // Tagline's own Save must commit through saveTagline, not saveName — a
    // wiring bug pointing both fields at the same handler would go
    // undetected if only the name field's Save were ever exercised.
    const [, taglineSave] = [...document.querySelectorAll('button')].filter(b => b.textContent === 'Save');
    taglineSave.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => preview.textContent === 'Ada King — First programmer');
    expect(dirtyCount()).toBe(0);

    // Reset is the only action that hands a field a prop value its own draft
    // doesn't already hold, which is what exercises the child's "props"
    // re-seed listener — everything above passes even without it.
    nameInput.value = 'Zzz';
    nameInput.dispatchEvent(new windowRealm.Event('input'));
    await pollFor(() => dirtyCount() === 1);

    const [resetButton] = [...document.querySelectorAll('button')].filter(b => b.textContent === 'Reset');
    resetButton.dispatchEvent(new windowRealm.Event('click'));
    await pollFor(() => nameInput.value === 'Ada Lovelace');

    expect(taglineInput.value).toBe('Mathematician');
    expect(dirtyCount()).toBe(0);
    expect(preview.textContent).toBe('Ada Lovelace — Mathematician');
});
