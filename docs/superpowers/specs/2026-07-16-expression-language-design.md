# Design: parsed expression language (issue #15)

**Date:** 2026-07-16
**Branch:** `issue-15-expression-language`
**Issues:** implements [#15](https://github.com/mellonis/app.js/issues/15); retires the eval channels (#11/#12 machinery) and the #7-era reserved-identifier prop ban (MF-6 class); unlocks #17 (the resolver is the future dependency-collection point)

## Decisions made with the maintainer

| Decision | Choice |
|---|---|
| Engine | **Tokenizer → Pratt parser → tree-walking evaluator** over a defined subset (issue dossier, 2026-07-13); parse once per unique source, cached forever (pure) |
| Pipes | **F#-style `\|>`** — RHS evaluates to a function, called with the piped value; deliberately diverges from TC39's Hack direction (documented with rationale) |
| Identifier resolution | **`$`-scope → `props` → `data` → `methods` → globals whitelist → loud error** — explicit ordered chain, replacing `var`-prologue shadowing |
| Placement | **New `src/expression.ts`** — pure module, zero imports from `app.ts`, the package's first deliberate second file |
| Old engine | **Deleted outright** — `eval`, the `#evaluationScope`/`#evaluationElement` channels, the prologue builder, and `RESERVED_IDENTIFIERS` all go; no fallback flag |
| Write-back | **Path assignment by the framework** — no assignment operators in the language; `data-value` expressions must be **static dot-only** member paths rooted in data |
| Mixing `\|>` with `?:` | **Parse error without parentheses** — explicit ambiguity refusal, a teaching moment instead of a precedence surprise |
| Dangerous members | **`constructor` / `__proto__` / `prototype` access is a loud error** — closes the classic sandbox escape; the "safer by construction" claim must be true |

## A. The module — `src/expression.ts`

Pure and standalone: no `Component` import, no DOM types, no framework state. The
public surface:

```ts
export class ExpressionParseError extends Error {
    readonly source: string;
    readonly position: number;          // 0-based offset into source
}

export interface Resolution {
    found: boolean;
    value?: unknown;
}

export type IdentifierResolver = (name: string) => Resolution;

export interface CompiledExpression {
    readonly source: string;
    readonly assignable: boolean;       // true iff the AST is a STATIC dot path rooted at an identifier
    readonly rootIdentifier?: string;   // the path root when assignable (audit S9 — the
                                        // prop-root wiring ban reads this, not a source regex)
    evaluate(resolve: IdentifierResolver): unknown;
    assign(resolve: IdentifierResolver, value: unknown): void;  // throws unless assignable
}

export function compile(source: string): CompiledExpression;   // throws ExpressionParseError
export function renderCaret(error: ExpressionParseError): string;  // two-line render: source, then caret
// (attribute sources are single-line and tab-free; ${} interpolation sources
// can be multi-line — the caret render is best-effort there, stated honestly)
```

- `compile` results are cached in a module-level `Map<string, CompiledExpression>`
  — parsing is deterministic and pure, so the cache never invalidates and is NOT
  touched by `clearTemplateCache()` (stated, not accidental).
- The evaluator is a tree walk over a discriminated-union AST; arrows evaluate to
  real JS closures that layer their parameter bindings over the outer resolver
  (parameters shadow the chain — the only shadowing left in the system, and it is
  lexical and visible).

## B. The language

### Grammar (precedence, loosest first)

| Level | Construct | Notes |
|---|---|---|
| 1 | `\|>` (left-assoc) | RHS must evaluate to a function; **mixing with `?:` at one nesting level without parentheses is a parse error** ("parenthesize the ternary or the pipe") |
| 2 | `?:` (right-assoc) | branches parse at level 2 |
| 3 | `??` | short-circuits; mixing `??` with `&&`/`\|\|` without parens is a parse error (JS rule, kept) |
| 4 | `\|\|` | short-circuits |
| 5 | `&&` | short-circuits |
| 6 | `===` `!==` | no loose equality — `==`/`!=` are parse errors naming the fix |
| 7 | `<` `<=` `>` `>=` | |
| 8 | `+` `-` | |
| 9 | `*` `/` `%` | `%` is remainder only (no Hack topic) |
| 10 | unary `!` `-` `+` `typeof` | |
| 11 | call `f(a, ...b)` / member `a.b`, `a?.b`, `a[b]`, `a?.[b]` | postfix, left-assoc |
| 12 | primary | literals, identifiers, `( … )`, array literals `[a, ...b]`, arrow functions |

### Literals and primaries

- Strings (single AND double quotes — attributes force `&quot;` for one of
  them). Escapes, enumerated (audit S7): `\\`, `\'`, `\"`, `\n`, `\t` —
  any other character after a backslash is a parse error naming the supported
  set. Numbers: decimal digits, leading-dot (`.5`), signed exponent (`1e3`,
  `1e-3`); a trailing dot (`1.`) is a parse error ("write 1 or 1.0").
  `true`/`false`/`null`/`undefined` are literals, not identifiers.
- Array literals with spread: `[...todos, draft]`.
- **Arrow functions**: `x => expr` and `(a, b) => expr` — expression bodies only,
  simple identifier parameters only (no destructuring, no defaults, no rest) —
  covers `todos.filter(todo => !todo.done)` and the documented
  `[...todos].sort((a, b) => …)` idiom.
- **Arrow-head disambiguation, pinned** (audit S1 — the one place a bare Pratt
  loop is insufficient): on `(`, the tokenizer-level lookahead scans to the
  MATCHING `)` (counting nesting) and peeks one token — `=>` means arrow head
  (validate: only identifiers and commas inside), anything else means grouping
  (in which case a top-level comma is the usual comma-operator parse error).
  Pure token-stream lookahead; no parser-state backtracking.
- **Arrow bodies parse at level 2** (audit S2): a bare `|>` inside an
  unparenthesized arrow body is a parse error ("parenthesize the pipe") —
  consistent with the `|>`/`?:` refusal; `x => (a |> f)` is the sanctioned
  form.
- **Three more arrow pins** (audit-2 SC-2): `() => expr` (zero parameters) is
  a targeted parse error ("arrow functions here take at least one parameter")
  — nothing in view code needs it; a BARE identifier head (`x => y`) is
  detected by a one-token peek after an identifier in primary position; and an
  unparenthesized arrow as a pipe RHS (`a |> x => b`) is a parse error
  ("parenthesize the arrow on the right of |>") — the same explicit-ambiguity
  refusal as the other mixing rules.
- Identifiers: any `[A-Za-z_$][\w$]*` **including former reserved words** — the
  language has no statements, so `class`, `for`, `new` are plain identifiers; the
  #7-era reserved-identifier prop ban is retired (prop names become free; the
  empty-name and malformed-attribute errors stay).

### Explicitly out (loud parse errors)

Assignment operators (all of them — see §D write-back), statements and `;`,
`,`-sequences, object literals, template literals, regex literals, `new`,
`function`, loose equality, comma operator, increment/decrement, Hack-style `%`
topic, **optional call `?.(`** (call what you resolved — `a?.b` then a plain
call is enough for view code), **`**`** (use `Math.pow`), **`in` /
`instanceof`** (former reserved words are identifiers now — when a COMPLETE
expression is followed by a trailing identifier token spelled `in` or
`instanceof`, the trailing-garbage path emits a targeted error naming the
exclusion instead of "unexpected identifier"; this covers `todos.length in x`
and parenthesized left sides too), and **bitwise operators**
(`&`, `^`, `<<`, `>>`, `>>>`; bare `|` is already claimed by the pipe tokenizer
and errors as "did you mean |> or ||"). (Object literals out means the `data-component-prop-cfg="{a: 1}"`
fresh-identity footgun becomes *impossible* — the spec note in #7's design is
superseded for the better.)

### Evaluation semantics

- JS semantics throughout: member access on `null`/`undefined` throws `TypeError`
  (the props throwing-seed behavior depends on this — `maybe.value` with
  `maybe = null` must throw); `?.` short-circuits to `undefined`.
- Method calls `a.b(c)` invoke with `this = a` (`todos.filter(...)`,
  `title.toUpperCase()`); bare calls `currency(x)` invoke with `this = undefined`
  (component methods are pre-bound, so this is safe).
- `x |> f` evaluates `f` then calls `f(x)`; non-function RHS → loud `TypeError`
  naming the pipe ("right side of |> is not a function: …").
- `typeof missing` throws through the resolver like any other identifier miss —
  simpler than JS's undeclared-variable special case, documented as a deliberate
  divergence.
- **Sandbox rule**: member access (static or computed, optional or not) to
  `constructor`, `__proto__`, or `prototype` throws a loud error — this closes
  `"".constructor.constructor('…')()`, the eval-escape that would otherwise
  falsify the safety claim. Computed access checks the evaluated key at runtime.
- Honesty note (documented, not guarded): expressions have no assignment, but a
  CALL can still side-effect (a method invoked in an expression may write data).
  "Side-effect-free" is true of the grammar, not of everything it can reach —
  same class as before, stated plainly.

## C. Identifier resolution — the chain in `app.ts`

The framework builds one `IdentifierResolver` per evaluation:

1. **`$`-scope** — `$item` / `$index` / `$array` when a `scopeRef` is live
   (resolved through `#scopeForBinding`, exactly as today);
2. **`props`** — `Object.hasOwn(this.props, name)`;
3. **`data`** — `Object.hasOwn(this.data, name)` (the ghost — getters fire, which
   is also the future #17 dependency-collection point, noted not built);
4. **`methods`** — `Object.hasOwn(this.methods, name)` (bound; the formatters bag
   that makes `price |> currency` work with zero new machinery);
5. **globals whitelist** — a frozen module-level map in `app.ts` (policy is the
   framework's, not the parser's), trimmed to what view code needs (audit S5):
   `Math`, `JSON`, `Number`, `String`, `Boolean`, `Array`, `isNaN`, `isFinite`,
   `parseInt`, `parseFloat`. **`Object` is deliberately absent** — it would
   grant reflective mutation (`Object.defineProperty` on ghosts) that view
   expressions have no business doing; **`Date` is absent** — bare `Date()`
   (no `new` in the language) returns a string footgun, and date formatting
   belongs in methods. `undefined` is a literal (§B), not a whitelist entry;
6. **miss** — the evaluator throws a loud reference error naming the identifier
   AND the chain ("`fitler` is not defined ($-scope, props, data, methods,
   globals)") — caught by the existing per-binding conventions.

Data/prop/method name collisions need no rule beyond the order: first hit wins,
and #7 already rejects data/prop collisions at construction.

## D. Integration — what changes in `app.ts`

- **Compile at wiring time.** Every directive expression and `${}` interpolation
  compiles when its binding is wired. `ExpressionParseError` → loud error with
  the two-line caret render (`console.error(message + '\n' + renderCaret(e))`,
  plus the element) and the binding is skipped — a NEW, earlier error class than
  today's per-pass runtime throw (parse errors fire once at wiring, not per pass;
  no cadence machinery needed).
- **`#evaluate` becomes a thin adapter**: look up the compiled expression (cache),
  build the resolver, `evaluate()`. All existing call sites and error-cadence
  conventions (#4 per-binding, #12 once-while-broken, prop cadence) are UNCHANGED
  — they wrap the evaluate call exactly as they wrapped eval.
- **Write-back** (`data-value` two-way): the expression must satisfy
  `compiled.assignable` — **a STATIC dot-only member path rooted at a bare
  identifier** (audit S4, tightened): computed steps (`user[key]`), `?.`
  anywhere (JS forbids optional chains in assignment targets), calls, pipes,
  and literals all make an expression non-assignable — loud wiring error. The
  dot-only rule buys a guarantee: every intermediate step traverses a nested
  ghost (arrays are leaves and cannot appear mid-path in dot form), so the
  final set ALWAYS fires a ghost setter — "fires the setter exactly as today"
  becomes true by construction rather than by accident (the eval engine's
  `items[0].title = …` silently bypassed reactivity; that foot-gun is now
  unrepresentable in write-back). At input time, `assign(resolver,
  element.value)` resolves the ROOT through a **data-only** resolver (props
  are already banned at wiring — #7 MF-2; `$`-scope inputs are banned in
  items — #6) and walks the chain. The `#evaluationElement` channel dies; the ghost's
  input-element special case (`newValue instanceof HTMLInputElement…`) is
  RETIRED — `assign` passes `element.value` directly. **But that branch welded
  two behaviors together, and only one is magic** (audit M2): it was also the
  sole carrier of the SOURCE ELEMENT into `#runUpdatePass(sourceElement)`,
  whose `#updateValues` guard skips re-writing the input currently being
  edited. That skip is PRESERVED, not deleted, with the lifecycle pinned (audit-2
  MF-1): the write-back listener sets `#writeBackSource`, calls `assign`
  inside `try/finally`, and the `finally` clears the field (an `assign` that
  throws mid-path — `user.email` while `user` is null — must not leave a stale
  source for the next unrelated pass to consume). **`#runUpdatePass` consumes
  the field into a local at ENTRY (read-once-and-clear)** — nested passes
  triggered mid-pass (phase-1 reconciliation → cleanup emit → handler write)
  see null and re-write normally, exactly reproducing today's
  `#runUpdatePass(sourceElement)` argument semantics; the outer sourced pass
  keeps its element all the way to `#updateValues`. One narrow, named, internal channel survives — as an
  argument slot for the pass, not an eval scope hack. (Rationale for caring:
  re-writing the focused input is a same-string set — modern browsers preserve
  the caret, but IME composition and older engines do not, and no happy-dom
  test can catch a regression here. Untestable behavior must be preserved by
  construction, not hope.)
- **Deleted**: the prologue builder, `#evaluationScope`, `#evaluationElement`,
  `RESERVED_IDENTIFIERS` + `isValidPropName`'s reserved check (prop-name rule
  relaxes to: valid identifier shape, non-empty — `class` becomes a legal prop),
  the `eval` call and its `try/finally` scope juggling.
- **`data-on-*` handler values stay method NAMES** — not expressions; unchanged.
- **SFC `<script>` loading is untouched** — `data:` imports remain the one CSP
  relaxation; the README CSP note is updated to say exactly that (expressions no
  longer need `unsafe-eval`; component scripts still need `script-src data:` or
  equivalent).

## E. Errors — the teaching surface

- Parse error render (wiring time, once):

```
Can't parse the "todos.fitler(t => !t.done" expression:
todos.fitler(t => !t.done
                         ^ expected ')'
```

- Runtime errors keep today's text and cadence per binding kind; the unknown-
  identifier message names the full chain (§C.6).
- The `==` parse error teaches: "use === (loose equality is not part of this
  language)". The `|>`/`?:` mixing error teaches: "parenthesize". The sandbox
  error teaches: "constructor/__proto__/prototype are not reachable from
  expressions". The non-assignable `data-value` error — the one users will
  actually hit — teaches the rule and the why: "data-value needs a plain dot
  path (name, user.email) — computed steps and ?. can't guarantee a reactive
  write" (audit-2 SC-7).
- Prop-name residual (audit-2 SC-7): the #7 reserved-identifier ban is retired,
  but five names remain unreferenceable in the language itself — `typeof` (an
  operator token) and `true`/`false`/`null`/`undefined` (literals). Prop
  validation keeps exactly that five-name ban (loud error); everything else,
  including `class` and `for`, is now legal.

## F. Compatibility contract

The existing suite is the oracle, with exactly TWO knowingly-flipped behaviors:

1. `props.test.ts` "reserved-identifier … loud errors": `class` as a prop name
   becomes LEGAL (the test retargets to malformed/empty names only, and gains a
   positive `data-component-prop-class` case).
2. `ghost.test.ts` "stores an input element's value when one is assigned": the
   ghost's input-element branch is retired with the write-back change — the test
   flips to assert the element is stored AS-IS (plain setter semantics; the
   framework no longer routes elements through data writes).

The remaining 129 unit + 3 smoke must pass unmodified: every expression in
every shipped template, test, and example is inside the subset (verified against
the corpus while drafting: `!todo.done`, `user.name`, `firstName + ' ' +
lastName`, `$item.label + ':' + $index + '/' + $array.length`, `0 / 0`,
`"static"`, `maybe.value`, `broken ? boomFn() : name`, `x + 1`,
`n => n * 2`-class arrows, `[...]` spreads, `items.filter(...)`).

## G. Showcase

The todo example gains a formatter pipe — a `left` method
(`todos => todos.filter(todo => !todo.done).length`) and
`${todos |> left} left` in the footer — the `|>` story in one line, smoke-tested.

## H. Testing

New `packages/app.js/tests/expression.test.ts` (pure unit, imports
`../src/expression` only):

- Tokenizer: strings both quotes; every escape in the enumerated set (`\\`,
  `\'`, `\"`, `\n`, `\t`) plus a REJECTED escape (`\q`); numbers incl.
  `.5`, `1e3`, `1e-3`, and the `1.` trailing-dot error; operators incl. `|>`
  vs `||` vs bare `|` ("did you mean |> or ||"), `?.` vs `?` `:`, spread vs
  dot.
- Parser: full precedence table (one fixture per adjacent pair), right-assoc
  ternary, left-assoc pipes, the `|>`/`?:` paren rule, `??` mixing rule, `==`
  rejection, arrow forms (bare head, parenthesized multi-param, zero-param
  error, pipe-RHS-unparenthesized error, non-identifier head `(a.b) =>`
  error), the `in`/`instanceof`/`**`/`?.(`/bitwise targeted errors, spread
  positions, trailing garbage, empty source, unterminated string, position
  accuracy (asserted offsets), `renderCaret` shape.
- Evaluator: resolver chain via stub resolvers, shadowing by arrow params,
  short-circuits (`&&`/`||`/`??` and `?.`), method-call `this` binding, pipe
  happy path + non-function RHS error, sandbox rule (static, computed, optional
  variants), member-on-null TypeError, `typeof` on a missing identifier (pins a
  choice: `typeof missing` still throws through the resolver — simpler than JS's
  special case, documented).
- `assignable` + `assign`: root identifier, nested dot path; REJECTS computed
  steps, `?.` anywhere, calls/pipes/arrows/literals (dot-only rule); assign
  through a stub resolver mutates the right target; `rootIdentifier` exposed.

Integration additions (existing files): the eval/Function-stub smoke variant
(success criterion 1 — listed here so the test plan is self-contained);
pipe-with-method formatter through `${}`;
unknown-identifier chain error text; parse-error-at-wiring (caret logged once,
binding skipped, siblings live); `class` prop positive; write-back nested path
still fires the ghost setter (existing tests already cover — the flip list in §F
is exhaustive).

## I. Out of scope

Hack pipes / `%` topic; object & template literals; regex; destructuring or
default params; assignment operators; statements; `new`; dependency tracking
(#17 — the resolver is deliberately the seam, nothing more); any change to SFC
script loading; `data-on-*` becoming expressions.

## Success criteria

1. Eval removal proven by a test that actually discriminates (audit M1:
   happy-dom has ZERO CSP machinery — probed: `eval` runs under a forbidding
   header, so a CSP-header smoke would be vacuously green today). Instead: a
   smoke variant that **stubs `window.eval`, `globalThis.eval`, and `Function`
   to throw** for a full todo run (mount + add/toggle/remove) — RED against
   today's engine, green only after the rewrite; SFC loading survives the stub
   because `data:` dynamic `import()` uses neither (probed under happy-dom's
   module loader). Mechanism, pinned (audit-2 SC-1): a stub variant PAGE in
   the example web root — an inline CLASSIC `<script>` in `<head>` making
   **explicit `window.X =` assignments** (happy-dom evaluates classic scripts
   in a function scope, so bare `var`/declarations would silently stub nothing
   — the vacuous-green failure mode all over again), followed by the normal
   module bootstrap. Plus the static gate: `grep -rc 'eval(' packages/app.js/src`
   → zero. A real-browser check with the actual
   `script-src 'self' data:` header is documented as a manual, out-of-CI
   verification (happy-dom cannot host it honestly).
2. Suite green: 131 + 3 minus the two enumerated flips, plus the new expression
   suite (~45 tests) and integration additions.
3. `src/expression.ts` imports nothing from `app.ts`; `app.ts` imports only the
   public surface (§A).
4. The todo pipe showcase renders and updates over real HTTP.
5. No new dependencies; framework runtime dependencies still none.
