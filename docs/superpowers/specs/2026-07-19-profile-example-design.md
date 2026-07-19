# Profile example — design

**Goal:** a sixth runnable example, `packages/examples/profile/`, sitting between `cards` and `registration` in the ladder. It exists to teach exactly one idea that the capstone currently drops on the student with three others: **a form control cannot bind to a prop, because props are read-only inputs — so an editable child keeps its own draft.**

## Why it exists

`registration`'s `contact-row` introduces the local-draft pattern alongside per-item components inside a `data-for`, Zod validation, submit-then-live timing, and a revealed section. Its `mounted()` comment is good, but the pattern is the hardest idea in the repo and arrives with no precursor.

`todo` already teaches a child component with props and events — but display-only: `todo-item` renders and emits, holding no state of its own. The step from "child that displays" to "child that edits" is the missing rung.

## What the page is

A tiny profile card with **two** independent `editable-field` instances (name, tagline) and a preview line reading the parent's committed values.

```
Profile

  Name     [ Ada Lovelace_ ]  (Save) (Cancel)  unsaved
  Tagline  [ Mathematician ]  (Save) (Cancel)

  Preview: Ada Lovelace — Mathematician
```

Two instances are deliberate and nearly free: they demonstrate per-instance `data` — edit both, each keeps its own draft; cancel one, the other is untouched.

## Files

| Path | Role |
|---|---|
| `packages/examples/profile/index.html` | parent state + methods, mounts the root |
| `packages/examples/profile/templates/root.html` | the two field slots and the preview line |
| `packages/examples/profile/templates/editable-field.html` | the SFC: template, `<style>`, `<script>` |
| `packages/examples/tests/profile.smoke.test.ts` | smoke test on its own port |

Plus: `profile` script in `packages/examples/package.json`, `ex:profile` at the root, README ladder + Quick start + Repository layout, CLAUDE.md's examples list.

## The component contract

**Parent → child:** `data-component-prop-value="name"` (the committed truth).
**Child → parent:** `data-component-on-committed="saveName"` — the payload is the new string.

Each field is wired to **its own handler** (`saveName`, `saveTagline`). Deliberately no `{field, value}` envelope and no id convention: inventing one would be a second new idea, and the parent already knows which child it wrote.

**Child internals:**

```js
export default {
    data: () => ({draft: ''}),
    methods: {
        commit() { this.events.emit('committed', this.data.draft); },
        cancel() { this.data.draft = this.props.value; },
    },
    mounted() {
        const seedFromProp = () => { this.data.draft = this.props.value; };

        seedFromProp();
        this.events.on('props', seedFromProp);
    },
};
```

The template binds `data-value="draft"` — never the prop — and shows a dirty marker through an expression already taught: `${draft === value ? '' : 'unsaved'}`.

## Scope discipline — exactly one new idea

**In:** props are read-only, so an editable child copies to `data`; seeding at `mounted()`; re-seeding on the `props` event; committing upward with `emit`.

**Deliberately out**, because each would be a second new concept:
- `data-disabled-if` on the Save/Cancel buttons — tempting (disable when clean), but `registration` introduces that directive. Buttons stay always-enabled; the dirty state shows as text via a ternary, which needs no new vocabulary.
- Any list / `data-for` — `todo` owns that lesson; repeating it here would blur what is new.
- Validation of any kind — that is the capstone's job.
- A `{field, value}` payload envelope or per-field ids.

## Reactivity notes that must hold

- After `commit()`, the parent writes its own key; that re-seeds the child's props and fires `props`, so `seedFromProp` runs and assigns a draft value **equal to what is already there**. The equality gate suppresses it — no second render, no caret disturbance. Correct, and worth a comment in the file.
- `cancel()` when the draft is already clean is likewise a suppressed no-op.
- A parent-side change that did *not* originate in the child (none on this page, but true generally) flows down through the same `props` event and updates the input.
- `data-value` on the child's input renders through the drain's skip-if-equal rule, so typing keeps its caret.

## Testing

`profile.smoke.test.ts`, on its own port, driving the built framework over HTTP:

1. Both inputs render seeded from the parent's values; preview matches.
2. Typing into the name field leaves the preview unchanged — the draft has diverged from the truth.
3. Cancel snaps that input back to the parent's value; the preview never moved.
4. Type again, Save — preview updates.
5. **Independence:** edit both fields, cancel one, and assert the other's draft survived. This is the assertion that would catch shared state between instances, and the reason there are two fields at all.

Each assertion must be one a broken implementation could fail — no asserting a value that holds whether or not the mechanism works.

## Documentation riders

- README ladder: insert as **5**, renumber `registration` to **6**.
- README Quick start: `npm run ex:profile` line.
- README Repository layout: add `profile/` to the examples list.
- CLAUDE.md: add `profile/` to the examples list in "What this is".
- The `<script>` carries a comment stating the rule in one sentence — props are inputs; a control needs something writable — since that sentence is the whole point of the example.

## Rejected alternatives

- **Editable rows in a list** — closer to the capstone, but teaches the local draft and the per-item-component dimension together, and `todo` already covers the list half.
- **Live edit, emitting on every keystroke** — simplest, and what `contact-row` actually does, but the draft then looks like ceremony rather than a consequence of props being read-only. Save/Cancel is what proves the draft is a separate thing from the truth.
- **A parent-level "reset to defaults" button** — would make the `props` re-seed unmistakable by pushing new values into both children mid-edit. Cut as one moving part too many; the re-seed is still exercised on every Save.
