import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('form', 8232);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

it('submits the form and logs the collected values to the console', async () => {
    const page = browser.newPage();
    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;

    await pollFor(() => document.querySelector('form') !== null);

    expect(document.querySelector('p')?.textContent).toBe('Preview: (no name), (no email)');

    const [nameInput, emailInput] = [...document.querySelectorAll('input')];
    nameInput.value = 'Ada';
    nameInput.dispatchEvent(new windowRealm.Event('input'));
    emailInput.value = 'ada@lovelace.dev';
    emailInput.dispatchEvent(new windowRealm.Event('input'));

    expect(document.querySelector('p')?.textContent).toBe('Preview: Ada, ada@lovelace.dev');

    document.querySelector('form')!.dispatchEvent(new windowRealm.Event('submit'));

    expect(page.virtualConsolePrinter.readAsString()).toContain('Submitted: name=Ada, email=ada@lovelace.dev');
});
