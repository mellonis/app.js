# Design: the registration capstone — `data-disabled-if` + a heavy form with Zod

**Date:** 2026-07-17
**Branch:** `issue-25-26-registration` (after the #19/#20 forms pair lands)
**Issues:** a small framework directive and a capstone example, filed separately (directive first — the example depends on it)

## Decisions made with the maintainer

| Decision | Choice |
|---|---|
| Zod delivery | **devDependency of the examples workspace + serve alias** (`/zod.js` → the installed ESM build) — CI/smoke stay offline; the framework's zero-dep claim untouched; the lesson "integrate a real library" is the point |
| Disabled semantics | **New framework directive `data-disabled-if`** — real `el.disabled` toggling, not a hide-workaround; lands first with its own tests |
| Validation timing | **Submit-first, then live** — first submit paints all errors; afterwards each edit revalidates (clear-on-fix) |
| Placement | **New example `packages/examples/registration/`** (`npm run ex:registration`); the simple form example stays the gentle step |
| Repeatable sections | **Per-item single-file components** — the sanctioned architecture (in-item `data-value` is banned by design); rows hold local drafts and speak in events |

## A. The directive — `data-disabled-if="expr"` (framework, ships first)

- Truthy expression → `element.disabled = true`; falsy → `false`. Mirrors
  `data-display-if` in every structural way: wired at both sites (root and
  in-item with item scope), a tracked binding (its own kind in the binding
  union and drain phase alongside display), allowed on a `data-for` element
  itself, compile-at-wiring with the caret error.
- Allowed ONLY on elements that honor `disabled`: `input`, `textarea`,
  `select`, `button` (the form-control set plus button). Anywhere else: loud
  setup error naming the rule.
- Interactions, pinned: composes freely with `data-value` on the same control
  (a disabled input keeps its binding; the browser suppresses user events, so
  write-back simply never fires while disabled — no framework special case);
  composes with `data-show-if`/`data-display-if` (independent bindings — the
  multi-binding-element fix already guarantees each dirties independently).
- Tests: toggle on/off (root + in-item), the non-disableable loud error,
  same-element composition with `data-value` and `data-show-if`, item-scope
  expression, eviction cleanliness. Docs: CLAUDE.md directives list + README
  attributes line.

## B. The example — `packages/examples/registration/`

One page, four teaching beats, every recent framework feature load-bearing:

**Data shape (root component):**

```js
data: {
    name: '', email: '',
    subscribe: false,          // reveals the preferences section
    channel: 'email',          // radio group inside it
    contacts: [],              // repeatable rows: {id, kind: 'phone'|'telegram', value}
    agreed: false,             // gates the submit button
    errors: [],                // [{field, message}] — an ARRAY, replaced wholesale on
                               // each validation (ghosts are non-extensible, so an
                               // object map could never gain keys; the array leaf is
                               // the replace-only shape that fits)
    submitted: false,          // switches validation to live mode
    done: false,               // success view
}
```

**Beat 1 — basics + errors.** `name`/`email` inputs via `data-value`, each with
an error line: `<p class="error" data-display-if="errorFor('name')">${errorFor('name')}</p>`
— `errorFor(field)` is a method scanning the errors array; called inside an
expression it runs under the open tracking frame, so its `errors` read
subscribes the binding automatically (methods-in-expressions collect too — a
deliberate lesson).
Each input also carries `data-on-input="touch"` (the wildcard directive) — the
coexistence of a binding and a behavior listener on one control is itself a
lesson. `touch(event)` revalidates only when `submitted` is true.

**Beat 2 — the revealed section.** `<input type="checkbox" data-value="subscribe">`;
`<fieldset data-show-if="subscribe">` containing the `channel` radio group
(three radios sharing `data-value="channel"`). Checkbox → section is the
`data-show-if` story; the radios are #19's showcase.

**Beat 3 — repeatable contacts.** `data-for="contacts"` over per-item
`contact-row` single-file components: props `contact` (the item) and `error`
(that row's message: `data-component-prop-error="errorFor('contact:' + $item.id)"`); local drafts
(`kind` select + `value` input bound to CHILD data, seeded in `mounted()` via
the props event pattern); emits `changed` `{id, kind, value}` on either edit
and `removed` `{id}`. Parent: `addContact` (id from a counter, capped at 5 —
the cap error comes from Zod), `contactChanged`, `contactRemoved`. This is the
E2-channel worked example, live.

**Beat 4 — the gate and the finish.** `<input type="checkbox" data-value="agreed">`;
the submit `<button data-disabled-if="!agreed">` — the new directive's
showcase (disabled ≠ hidden: visible, gray, inert). On submit: Zod
`safeParse`; on failure map issues into `errors` (flat keys: `name`, `email`,
`channel`, and `contact:<id>` for rows) and set `submitted = true`; on success
set `done = true` → a `data-show-if="done"` summary rendering the payload via
a pipe (`${form() |> pretty}` — `pretty` is `JSON.stringify` with indent, a
formatter method).

**The schema (in `index.html`, imported from `/zod.js`):**

```js
const schema = z.object({
    name: z.string().min(2, 'At least 2 characters'),
    email: z.string().email('Not an email'),
    subscribe: z.boolean(),
    channel: z.enum(['email', 'phone', 'telegram']),
    contacts: z.array(z.object({
        kind: z.enum(['phone', 'telegram']),
        value: z.string().min(3, 'At least 3 characters'),
    })).max(5, 'Five contacts at most'),
    agreed: z.literal(true),
});
```

Validation lives in ONE method (`validate()`) that safeParses a plain snapshot
of the data (strip ghosts via structural copy), maps `issues` →
`[{field, message}]`, and REPLACES `data.errors` wholesale (the array-leaf
rule) — one flush paints every error line thanks to batching.

## C. Plumbing

- `zod` (current v3 line, exact pin) joins `packages/examples/package.json`
  devDependencies; `serve.mjs` gains a `/zod.js` alias to the package's single
  ESM bundle (same pattern and traversal-safety as the framework alias). The
  no-eval smoke page is untouched (registration is a separate page; Zod's own
  CSP behavior is its own business — not our claim).
  Pinned at 3.24.4 — the last v3 release shipping a single-file ESM bundle
  (`lib/index.mjs`); later v3 versions restructured into a modular tree that
  the single-alias pattern deliberately does not chase.
- `npm run ex:registration` (port 8123 like the others); smoke test on its own
  port drives the FULL flow offline: invalid submit → all errors painted; fix
  name → its error clears live (submitted mode); toggle subscribe → section
  appears; pick a radio; add two contacts, edit one (child emits → parent map
  updates), remove one; check agreed → button enables (assert `disabled`
  flips); submit → summary visible with the piped JSON.
- Docs: README gains the example in the Quick-start list + one paragraph on
  what it demonstrates (including "the framework composes with real libraries —
  Zod arrives as a plain ES module"); CLAUDE.md commands/example lists updated.

## D. Sequencing and scope

1. Land the in-review #19/#20 branch first (checkbox/radio + wildcard events
   are load-bearing here).
2. This branch: directive commit (with its tests) → example commit (+ deps and
   serve alias) → docs. Two issues filed; the example issue carries this spec's
   §B as its body.
3. Out of scope: form-level `data-disabled-if` cascading (`<fieldset disabled>`
   semantics), async validators, Zod error i18n, any framework validation
   API (validation stays userland — that IS the lesson), touching the other
   examples.

## Success criteria

1. The directive's suite passes with the same-element composition cases; the
   framework remains zero-runtime-dependency (`packages/app.js/package.json`
   untouched).
2. The registration smoke drives the full flow offline, green.
3. Every recent feature appears load-bearing at least once: checkbox + radio
   bindings (#19), a wildcard event listener beside a binding (#20), a
   revealed section, per-item components with props/events (#7), a pipe
   formatter (#15), batched error painting via the object hatch (#17), and the
   new directive.
4. `updated()`/`settle` idioms appear in the smoke where DOM is asserted after
   writes — the example doubles as documentation of the testing pattern.
