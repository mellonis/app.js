# csp example — the strict-CSP posture, demonstrated

Spec for the seventh ladder example, written alongside the upstream fixes for
the field report (issue #35): the `<script src>` component loading path landed
specifically so a `script-src 'self'` app could keep using single-file
components, and this example is that posture made runnable.

## Decisions

- **Page shape.** `<meta http-equiv="Content-Security-Policy"
  content="script-src 'self'">`, boot code in `/js/main.js` (a root-level
  `/main.js` would be shadowed by serve.mjs's dist-candidate check, which
  routes root-level `*.js` at the framework build first), component code in
  `templates/tally.js`, named by `<script src="./tally.js">` and resolved
  against the component file's own URL.
- **Component content is deliberately minimal** — a per-instance tally button
  with a parent-supplied label. The example teaches the LOADING PATH; state,
  props, and lifecycle are earlier rungs' material, and duplicating them here
  would bury the one new idea.
- **`data-src` rounds out the field-report themes** — a badge `<img>` driven
  by a null-seeded data key, cycling through two bundled SVGs and clearing
  back to null. It shows the directive's whole contract in one control: the
  attribute follows the expression, and null (or `''`) REMOVES it — the img
  never carries `src=""`. Serving the SVGs made `serve.mjs` grow an
  `image/svg+xml` content-type entry.
- **`tally.html` opens with a comment** — exercising the also-new
  leading-comment tolerance in template parsing on a real page, not just in
  the unit suite.
- **What the smoke test can and cannot prove.** happy-dom does not enforce
  CSP, so `tests/csp.smoke.test.ts` (port 8238) asserts the page SHAPE works:
  external boot module, http-loaded component module, two instances with
  independent state. The policy itself bites only in a real browser — open
  the page there to watch it hold (and to watch the inline/data: forms fail).

## Coverage

Two smoke tests. The first: mount renders both tally buttons with their
seeded labels, clicking one advances only that instance — the suite's only
real-browser-shaped coverage of `<script src>` component loading (the unit
test for it rides a `file://` fixture through node's own loader). The second:
the badge starts with NO src attribute, cycles through both SVG urls, and
clearing removes the attribute again — the suite's only real-browser coverage
of `data-src` at all.
