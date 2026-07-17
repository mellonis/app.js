import { afterAll, beforeAll, expect, it } from 'vitest';
import { Browser } from 'happy-dom';
import type { Element as HappyElement, HTMLButtonElement, HTMLInputElement, HTMLParagraphElement } from 'happy-dom';
import { pollFor, startExample, stopExample, type RunningExample } from './helpers';

let example: RunningExample;
let browser: Browser;

beforeAll(async () => {
    example = await startExample('registration', 8235);
    browser = new Browser({settings: {enableJavaScriptEvaluation: true}});
});

afterAll(async () => {
    await browser.close();
    stopExample(example);
});

it('drives the full registration flow: submit-first validation, live fixes, reveal, contacts, the gate, and the summary', async () => {
    const page = browser.newPage();

    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;

    await pollFor(() => document.querySelector('form') !== null);

    // Grab the stable handles up front, before contact rows (which carry
    // their own same-shaped input/error markup) exist to confuse a later
    // untargeted query
    const [nameInput, emailInput] = [...document.querySelectorAll('input')] as unknown as HTMLInputElement[];
    const [nameError, emailError] = [...document.querySelectorAll('p.error')] as unknown as HTMLParagraphElement[];
    const form = document.querySelector('form')!;

    // Invalid submit — first submit paints every error at once
    form.dispatchEvent(new windowRealm.Event('submit'));

    await pollFor(() => nameError.textContent !== '' && emailError.textContent !== '');
    expect(nameError.textContent).not.toBe('');
    expect(emailError.textContent).not.toBe('');

    // Now in live mode: fixing the name clears just its own error
    nameInput.value = 'Ada Lovelace';
    nameInput.dispatchEvent(new windowRealm.Event('input'));
    await pollFor(() => nameError.textContent === '');
    expect(emailError.textContent).not.toBe('');

    emailInput.value = 'ada@example.com';
    emailInput.dispatchEvent(new windowRealm.Event('input'));
    await pollFor(() => emailError.textContent === '');

    // The revealed section: checkbox → fieldset, then a radio inside it
    expect(document.querySelector('fieldset')).toBeNull();

    const subscribeCheckbox = document.querySelectorAll('input[type="checkbox"]')[0] as unknown as HTMLInputElement;

    subscribeCheckbox.checked = true;
    subscribeCheckbox.dispatchEvent(new windowRealm.Event('change'));
    await pollFor(() => document.querySelector('fieldset') !== null);

    const phoneRadio = [...document.querySelectorAll('input[type="radio"]')]
        .find(radio => (radio as unknown as HTMLInputElement).value === 'phone') as unknown as HTMLInputElement;

    phoneRadio.checked = true;
    phoneRadio.dispatchEvent(new windowRealm.Event('change'));
    await pollFor(() => phoneRadio.checked);

    // Repeatable contacts: add two rows through the real child components
    const rows = () => [...document.querySelectorAll('li')];
    const addButton = [...document.querySelectorAll('button')].find(button => button.textContent === 'Add contact')!;

    addButton.click();
    await pollFor(() => rows().length === 1 && rows()[0].querySelector('input') !== null);

    addButton.click();
    await pollFor(() => rows().length === 2 && rows()[1].querySelector('input') !== null);

    // Edit the first row's local draft — the child emits "changed", the
    // parent's map updates in response
    const firstRowValueInput = rows()[0].querySelector('input') as unknown as HTMLInputElement;

    firstRowValueInput.value = '+1 555 0100';
    firstRowValueInput.dispatchEvent(new windowRealm.Event('input'));
    await pollFor(() => firstRowValueInput.value === '+1 555 0100');

    // Remove the second row — the child emits "removed"
    const removeButtonIn = (row: HappyElement) => [...row.querySelectorAll('button')].find(button => button.textContent === 'Remove')!;

    removeButtonIn(rows()[1]).click();
    await pollFor(() => rows().length === 1);
    expect((rows()[0].querySelector('input') as unknown as HTMLInputElement).value).toBe('+1 555 0100');

    // The gate: data-disabled-if keeps Submit inert until agreed flips
    const submitButton = [...document.querySelectorAll('button')].find(button => button.textContent === 'Submit') as unknown as HTMLButtonElement;

    expect(submitButton.disabled).toBe(true);

    const agreedCheckbox = document.querySelectorAll('input[type="checkbox"]')[1] as unknown as HTMLInputElement;

    agreedCheckbox.checked = true;
    agreedCheckbox.dispatchEvent(new windowRealm.Event('change'));
    await pollFor(() => submitButton.disabled === false);

    // A clean submit — the success view renders the piped JSON summary
    form.dispatchEvent(new windowRealm.Event('submit'));
    await pollFor(() => document.querySelector('pre') !== null);

    const summary = JSON.parse(document.querySelector('pre')!.textContent!);

    expect(summary).toEqual({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        subscribe: true,
        channel: 'phone',
        contacts: [{kind: 'phone', value: '+1 555 0100'}],
        agreed: true,
    });
});
