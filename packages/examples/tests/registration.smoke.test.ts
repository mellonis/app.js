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

    // A clean submit — the success view renders as a card component, its
    // title projected into a named slot and the JSON summary into the
    // default slot
    form.dispatchEvent(new windowRealm.Event('submit'));
    await pollFor(() => document.querySelector('pre') !== null);

    expect(document.querySelector('.card h2')?.textContent).toBe('You\'re in.');

    const summary = JSON.parse(document.querySelector('.card pre')!.textContent!);

    expect(summary).toEqual({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        subscribe: true,
        channel: 'phone',
        contacts: [{kind: 'phone', value: '+1 555 0100'}],
        agreed: true,
    });
});

it('a contact-typed channel demands a matching contact (cross-field rule)', async () => {
    const page = browser.newPage();

    await page.goto(`${example.baseUrl}/`);
    await page.waitUntilComplete();

    const document = page.mainFrame.document;
    const windowRealm = page.mainFrame.window;

    await pollFor(() => document.querySelector('form') !== null);

    const [nameInput, emailInput] = [...document.querySelectorAll('input')] as unknown as HTMLInputElement[];
    const form = document.querySelector('form')!;

    nameInput.value = 'Ruslan';
    nameInput.dispatchEvent(new windowRealm.Event('input'));
    emailInput.value = 'r@example.com';
    emailInput.dispatchEvent(new windowRealm.Event('input'));

    const checkboxes = () => [...document.querySelectorAll('input[type="checkbox"]')] as unknown as HTMLInputElement[];
    const subscribe = checkboxes()[0];

    subscribe.checked = true;
    subscribe.dispatchEvent(new windowRealm.Event('change'));
    await pollFor(() => document.querySelector('fieldset') !== null);

    const telegramRadio = ([...document.querySelectorAll('input[type="radio"]')] as unknown as HTMLInputElement[])
        .find(radio => radio.value === 'telegram')!;

    telegramRadio.checked = true;
    telegramRadio.dispatchEvent(new windowRealm.Event('change'));

    const agree = checkboxes().at(-1)!;

    agree.checked = true;
    agree.dispatchEvent(new windowRealm.Event('change'));

    const submitButton = document.querySelector('button[type="submit"]') as unknown as HTMLButtonElement;

    await pollFor(() => submitButton.disabled === false);
    form.dispatchEvent(new windowRealm.Event('submit'));

    // No telegram contact exists: the cross-field rule must block the submit
    await pollFor(() => [...document.querySelectorAll('p.error')].some(error => (error.textContent ?? '').includes('telegram')));
    expect(document.body.textContent).not.toContain('"channel"');

    // Add a telegram contact; the error clears live, then submit succeeds
    const addButton = ([...document.querySelectorAll('button')] as unknown as HTMLButtonElement[])
        .find(button => (button.textContent ?? '').toLowerCase().includes('add'))!;

    addButton.click();
    await pollFor(() => document.querySelector('select') !== null);

    const kindSelect = document.querySelector('select') as unknown as HTMLInputElement;

    kindSelect.value = 'telegram';
    kindSelect.dispatchEvent(new windowRealm.Event('change'));

    const handleInput = ([...document.querySelectorAll('input')] as unknown as HTMLInputElement[])
        .find(input => (input.placeholder ?? '').includes('handle'))!;

    handleInput.value = 'mellonis';
    handleInput.dispatchEvent(new windowRealm.Event('input'));

    await pollFor(() => ![...document.querySelectorAll('p.error')].some(error => (error.textContent ?? '').includes('telegram')));
    form.dispatchEvent(new windowRealm.Event('submit'));
    await pollFor(() => (document.body.textContent ?? '').includes('"channel": "telegram"'));
});
