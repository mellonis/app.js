# Expression Language Implementation Plan (issue #15)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the eval expression engine with a pure tokenizer → Pratt parser → tree-walking evaluator (`src/expression.ts`), an explicit resolver chain, F# pipes, and path-based write-back — CSP-honest and sandbox-true.

**Architecture:** `src/expression.ts` is pure (no Component/DOM imports); `app.ts` owns policy (resolver chain, globals whitelist) and adapts its seven `#evaluate` call-site shapes to `compile()`/`evaluate()`/`assign()`. The eval call, both `#evaluation*` channels, the prologue builder, and the reserved-identifier prop ban are deleted; the source-element skip survives via an entry-consumed `#writeBackSource` slot.

**Tech Stack:** TypeScript 7 (existing), vitest 4 + happy-dom (existing), zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-16-expression-language-design.md` — **binding, including both audit rounds' folds.** Spec wins conflicts; report them.

## Global Constraints

- **NEVER `git commit` without maintainer authorization** — the controller holds per-plan pre-authorization or pauses at each Commit step.
- **No Claude/AI attribution** anywhere.
- **Documentation-authority rule (maintainer, global):** code comments carry substance in prose ONLY — no issue numbers, no `spec §N`, no audit tags, no forge URLs in any code comment, README, or docs text this plan produces. The spec/plan may link; code may not.
- Baseline: **131 unit + 3 smoke green.** Exactly TWO tests may change semantics (the flips in Task 3); everything else stays green unmodified.
- `src/expression.ts` imports nothing from `app.ts`; `app.ts` imports only `compile`, `renderCaret`, `ExpressionParseError`, and the types.
- Framework runtime dependencies: none. `dist/` never committed.

---

### Task 1: Branch setup

**Files:** none (git only)

- [ ] **Step 1:**

```bash
cd /Users/mellonis/Developer/mellonis-workspace/app.js
git checkout master && git pull origin master
git checkout -b issue-15-expression-language
npm test
```

Expected: clean tree, branch created, 131 + 3 green.

---

### Task 2: `src/expression.ts` — the complete module

**Files:**
- Create: `packages/app.js/src/expression.ts`
- Test (create): `packages/app.js/tests/expression.test.ts`

**Interfaces:**
- Produces (Task 3 relies on these EXACT exports): `compile(source: string): CompiledExpression` (throws `ExpressionParseError`); `renderCaret(error: ExpressionParseError): string`; `class ExpressionParseError extends Error { source: string; position: number }`; `interface Resolution {found: boolean; value?: unknown}`; `type IdentifierResolver = (name: string) => Resolution`; `interface CompiledExpression {source; assignable; rootIdentifier?; evaluate(resolve); assign(resolve, value)}`.
- Black-box testing only: the test file imports ONLY the public surface and drives everything through `compile`+`evaluate`/`assign` with stub resolvers.

- [ ] **Step 1: Write the complete failing test file** — `packages/app.js/tests/expression.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compile, renderCaret, ExpressionParseError } from '../src/expression';
import type { IdentifierResolver } from '../src/expression';

function resolver(vars: Record<string, unknown>): IdentifierResolver {
    return name => Object.hasOwn(vars, name) ? {found: true, value: vars[name]} : {found: false};
}

function evalWith(source: string, vars: Record<string, unknown> = {}): unknown {
    return compile(source).evaluate(resolver(vars));
}

function parseErrorOf(source: string): ExpressionParseError {
    try {
        compile(source);
    } catch (error) {
        if (error instanceof ExpressionParseError) {
            return error;
        }
    }
    throw new Error(`expected a parse error for: ${source}`);
}

describe('tokenizer', () => {
    it('strings in both quotes with the enumerated escape set', () => {
        expect(evalWith("'a\\'b'")).toBe("a'b");
        expect(evalWith('"a\\"b"')).toBe('a"b');
        expect(evalWith("'x\\\\y'")).toBe('x\\y');
        expect(evalWith("'l1\\nl2'")).toBe('l1\nl2');
        expect(evalWith("'a\\tb'")).toBe('a\tb');
    });

    it('rejects an unsupported escape naming the set', () => {
        expect(parseErrorOf("'a\\qb'").message).toContain('escape');
    });

    it('rejects an unterminated string with its position', () => {
        const error = parseErrorOf("'abc");
        expect(error.message).toContain('nterminated');
        expect(error.position).toBe(0);
    });

    it('numbers: decimals, leading dot, signed exponents', () => {
        expect(evalWith('42')).toBe(42);
        expect(evalWith('3.14')).toBe(3.14);
        expect(evalWith('.5')).toBe(0.5);
        expect(evalWith('1e3')).toBe(1000);
        expect(evalWith('1e-3')).toBe(0.001);
    });

    it('rejects a trailing dot with a teaching message', () => {
        expect(parseErrorOf('1.').message).toContain('1.0');
    });

    it('bare | teaches |> and ||', () => {
        const message = parseErrorOf('a | b').message;
        expect(message).toContain('|>');
        expect(message).toContain('||');
    });
});

describe('literals, identifiers, resolution', () => {
    it('true/false/null/undefined are literals, not identifiers', () => {
        const never: IdentifierResolver = () => { throw new Error('resolver must not be called'); };
        expect(compile('true').evaluate(never)).toBe(true);
        expect(compile('false').evaluate(never)).toBe(false);
        expect(compile('null').evaluate(never)).toBe(null);
        expect(compile('undefined').evaluate(never)).toBe(undefined);
    });

    it('a missing identifier throws naming the identifier', () => {
        expect(() => evalWith('ghost')).toThrow(/"ghost" is not defined/);
    });

    it('former reserved words are plain identifiers', () => {
        expect(evalWith('class + for', {class: 1, for: 2})).toBe(3);
    });
});

describe('operators and precedence', () => {
    it('arithmetic precedence and unary forms', () => {
        expect(evalWith('1 + 2 * 3')).toBe(7);
        expect(evalWith('-x + +y', {x: 1, y: 2})).toBe(1);
        expect(evalWith('!done', {done: false})).toBe(true);
        expect(evalWith('10 % 3')).toBe(1);
    });

    it('comparisons bind tighter than logical ops, ternary above all but pipes', () => {
        expect(evalWith('a < 2 && b > 1 ? "y" : "n"', {a: 1, b: 2})).toBe('y');
        expect(evalWith('a === 1 || b === 9', {a: 0, b: 9})).toBe(true);
    });

    it('ternary is right-associative', () => {
        expect(evalWith('a ? 1 : b ? 2 : 3', {a: false, b: true})).toBe(2);
    });

    it('&&, ||, ?? short-circuit', () => {
        const trap = {get boom() { throw new Error('evaluated'); }};
        expect(evalWith('false && t.boom', {t: trap})).toBe(false);
        expect(evalWith('true || t.boom', {t: trap})).toBe(true);
        expect(evalWith('"v" ?? t.boom', {t: trap})).toBe('v');
        expect(evalWith('null ?? "d"')).toBe('d');
    });

    it('?? mixed with && or || without parens is a parse error', () => {
        expect(parseErrorOf('a ?? b || c').message).toContain('parenthes');
        expect(evalWith('(a ?? b) || c', {a: null, b: false, c: 'z'})).toBe('z');
    });

    it('loose equality teaches strict', () => {
        expect(parseErrorOf('a == b').message).toContain('===');
        expect(parseErrorOf('a != b').message).toContain('!==');
    });

    it('typeof works on values and throws on missing identifiers', () => {
        expect(evalWith('typeof n', {n: 5})).toBe('number');
        expect(() => evalWith('typeof ghost')).toThrow(/"ghost" is not defined/);
    });

    it('in, instanceof, **, and bitwise ops are targeted parse errors', () => {
        expect(parseErrorOf('a in b').message).toContain('not part of this language');
        expect(parseErrorOf('todos.length in x').message).toContain('not part of this language');
        expect(parseErrorOf('a instanceof b').message).toContain('not part of this language');
        expect(parseErrorOf('a ** b').message).toContain('Math.pow');
        expect(parseErrorOf('a & b').message).toContain('&&');
    });
});

describe('members, calls, optional chaining', () => {
    it('dot, computed, and mixed access', () => {
        const vars = {user: {name: 'Ada', tags: ['x', 'y']}, key: 'name'};
        expect(evalWith('user.name', vars)).toBe('Ada');
        expect(evalWith('user[key]', vars)).toBe('Ada');
        expect(evalWith('user.tags[1]', vars)).toBe('y');
    });

    it('member access on null throws; ?. short-circuits', () => {
        expect(() => evalWith('user.name', {user: null})).toThrow(TypeError);
        expect(evalWith('user?.name', {user: null})).toBe(undefined);
        expect(evalWith('user?.["name"]', {user: undefined})).toBe(undefined);
    });

    it('?. before a digit is not swallowed by the tokenizer', () => {
        expect(evalWith('ok ? .5 : 1', {ok: true})).toBe(0.5);
    });

    it('method calls bind this to the receiver', () => {
        expect(evalWith('items.filter(x => x > 1).length', {items: [1, 2, 3]})).toBe(2);
        expect(evalWith('name.toUpperCase()', {name: 'ada'})).toBe('ADA');
    });

    it('bare calls invoke with undefined this; spread flattens call args', () => {
        expect(evalWith('sum(...nums, 4)', {sum: (...ns: number[]) => ns.reduce((a, b) => a + b, 0), nums: [1, 2, 3]})).toBe(10);
    });

    it('optional call syntax is a targeted parse error', () => {
        expect(parseErrorOf('f?.(1)').message).toContain('not part of this language');
    });

    it('array literals with spread', () => {
        expect(evalWith('[...items, 9]', {items: [1, 2]})).toEqual([1, 2, 9]);
        expect(evalWith('[1, [2]].length')).toBe(2);
    });
});

describe('sandbox', () => {
    it('constructor, __proto__, prototype are blocked on every access form', () => {
        expect(() => evalWith('s.constructor', {s: ''})).toThrow(/not reachable/);
        expect(() => evalWith('s["const" + "ructor"]', {s: ''})).toThrow(/not reachable/);
        expect(() => evalWith('s?.constructor', {s: ''})).toThrow(/not reachable/);
        expect(() => evalWith('a.__proto__', {a: {}})).toThrow(/not reachable/);
        expect(() => evalWith('f.prototype', {f: () => 0})).toThrow(/not reachable/);
    });
});

describe('arrows', () => {
    it('bare-identifier head and parenthesized multi-param head', () => {
        expect(evalWith('items.map(x => x * 2)', {items: [1, 2]})).toEqual([2, 4]);
        expect(evalWith('pair((a, b) => a - b)', {pair: (f: (a: number, b: number) => number) => f(9, 4)})).toBe(5);
    });

    it('params shadow the outer chain', () => {
        expect(evalWith('items.map(x => x + inc)', {items: [1], inc: 10, x: 999})).toEqual([11]);
    });

    it('zero-param arrows are a targeted parse error', () => {
        expect(parseErrorOf('run(() => 1)').message).toContain('at least one parameter');
    });

    it('a non-identifier head is a parse error', () => {
        expect(() => compile('(a.b) => 1')).toThrow(ExpressionParseError);
    });

    it('arrow bodies stop below pipes', () => {
        expect(parseErrorOf('items.map(x => x |> f)').message).toContain('parenthes');
        expect(evalWith('items.map(x => (x |> f))', {items: [2], f: (n: number) => n * 10})).toEqual([20]);
    });
});

describe('pipes', () => {
    it('pipes left to right', () => {
        const vars = {n: 3, double: (x: number) => x * 2, inc: (x: number) => x + 1};
        expect(evalWith('n |> double |> inc', vars)).toBe(7);
    });

    it('pipes into a parenthesized arrow', () => {
        expect(evalWith('n |> (x => x * 10)', {n: 4})).toBe(40);
    });

    it('an unparenthesized arrow on the pipe right is a parse error', () => {
        expect(parseErrorOf('n |> x => x').message).toContain('parenthes');
    });

    it('a non-function pipe right throws naming the pipe', () => {
        expect(() => evalWith('n |> m', {n: 1, m: 2})).toThrow(/right side of \|>/);
    });

    it('mixing |> with ?: without parens is a parse error, both directions', () => {
        expect(parseErrorOf('a ? b : c |> f').message).toContain('parenthes');
        expect(parseErrorOf('a |> f ? b : c').message).toContain('parenthes');
        expect(evalWith('(a ? b : c) |> f', {a: true, b: 2, c: 3, f: (x: number) => x + 1})).toBe(3);
    });
});

describe('parse errors and renderCaret', () => {
    it('reports an accurate position for trailing garbage', () => {
        const error = parseErrorOf('a b');
        expect(error.position).toBe(2);
    });

    it('empty source is a parse error', () => {
        expect(() => compile('')).toThrow(ExpressionParseError);
        expect(() => compile('   ')).toThrow(ExpressionParseError);
    });

    it('renderCaret puts the caret under the position', () => {
        const error = parseErrorOf('todos.filter(t => !t.done');
        const [line, caret] = renderCaret(error).split('\n');
        expect(line).toBe('todos.filter(t => !t.done');
        expect(caret.indexOf('^')).toBe(error.position);
    });
});

describe('assignable paths', () => {
    it('static dot paths are assignable and expose the root', () => {
        expect(compile('name').assignable).toBe(true);
        expect(compile('name').rootIdentifier).toBe('name');
        expect(compile('user.contact.email').assignable).toBe(true);
        expect(compile('user.contact.email').rootIdentifier).toBe('user');
    });

    it('computed steps, ?., calls, pipes, arrows, literals are not assignable', () => {
        for (const source of ['user[key]', 'user?.name', 'load()', 'a |> f', 'x => x', '42', 'a + b']) {
            expect(compile(source).assignable, source).toBe(false);
        }
    });

    it('assign mutates the resolved target through the path', () => {
        const user = {contact: {email: 'old'}};
        compile('user.contact.email').assign(resolver({user}), 'new@x');
        expect(user.contact.email).toBe('new@x');

        const flat: Record<string, unknown> = {name: 'a'};
        compile('name').assign(name => name === 'name' ? {found: true, value: flat} : {found: false}, 'b');
    });

    it('assign on a non-assignable expression throws; sandbox keys blocked in paths', () => {
        expect(() => compile('a + b').assign(resolver({}), 1)).toThrow(/not assignable/);
        expect(() => compile('a.constructor.x').assign(resolver({a: {}}), 1)).toThrow(/not reachable/);
    });

    it('compile caches by source', () => {
        expect(compile('a + b')).toBe(compile('a + b'));
    });
});
```

(Note on the root-level assign test: assigning a ROOT identifier writes to the object the resolver returned for the root — Task 3's data-only resolver returns the ghost itself for root writes; the module-level contract is: for a single-identifier path, `assign` resolves the ROOT'S CONTAINER by calling `resolve(root)` expecting the container object, and sets `container[root]`. For longer paths, `resolve(root)` returns the root VALUE and the walk proceeds from it. This asymmetry is deliberate and both shapes are tested above.)

- [ ] **Step 2: RED** — `npx vitest run tests/expression.test.ts --root packages/app.js` → all fail (module missing).

- [ ] **Step 3: implement `packages/app.js/src/expression.ts`** — complete module:

```ts
export interface Resolution {
    found: boolean;
    value?: unknown;
}

export type IdentifierResolver = (name: string) => Resolution;

export interface CompiledExpression {
    readonly source: string;
    readonly assignable: boolean;
    readonly rootIdentifier?: string;
    evaluate(resolve: IdentifierResolver): unknown;
    assign(resolve: IdentifierResolver, value: unknown): void;
}

export class ExpressionParseError extends Error {
    readonly source: string;
    readonly position: number;

    constructor(message: string, source: string, position: number) {
        super(message);
        this.source = source;
        this.position = position;
    }
}

export function renderCaret(error: ExpressionParseError): string {
    // Attribute sources are single-line; interpolation sources can be
    // multi-line, where this render is best-effort
    return `${error.source}\n${' '.repeat(Math.max(0, error.position))}^`;
}

// ---------------------------------------------------------------- tokenizer

type TokenType = 'num' | 'str' | 'ident' | 'punct' | 'eof';

interface Token {
    type: TokenType;
    value: string;
    num?: number;
    start: number;
}

const ESCAPES = new Map([['\\', '\\'], ["'", "'"], ['"', '"'], ['n', '\n'], ['t', '\t']]);
const PUNCTUATORS = ['===', '!==', '>>>', '...', '|>', '?.', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '**', '<<', '>>', '(', ')', '[', ']', ',', '.', '?', ':', '+', '-', '*', '/', '%', '!', '<', '>', '&', '|', '^', '='];
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;

    while (index < source.length) {
        const char = source[index];

        if (/\s/.test(char)) {
            index += 1;
            continue;
        }

        if (char === "'" || char === '"') {
            const start = index;
            let value = '';

            index += 1;

            while (index < source.length && source[index] !== char) {
                if (source[index] === '\\') {
                    const escaped = ESCAPES.get(source[index + 1]);

                    if (escaped === undefined) {
                        throw new ExpressionParseError(`Unsupported escape "\\${source[index + 1]}" (supported: \\\\ \\' \\" \\n \\t)`, source, index);
                    }

                    value += escaped;
                    index += 2;
                } else {
                    value += source[index];
                    index += 1;
                }
            }

            if (index >= source.length) {
                throw new ExpressionParseError('Unterminated string', source, start);
            }

            index += 1;
            tokens.push({type: 'str', value, start});
            continue;
        }

        const isDigit = /\d/.test(char);
        const isLeadingDot = char === '.' && /\d/.test(source[index + 1] ?? '');

        if (isDigit || isLeadingDot) {
            const start = index;

            while (/\d/.test(source[index] ?? '')) {
                index += 1;
            }

            if (source[index] === '.') {
                if (!/\d/.test(source[index + 1] ?? '')) {
                    throw new ExpressionParseError('A number cannot end with a dot — write 1 or 1.0', source, start);
                }

                index += 1;

                while (/\d/.test(source[index] ?? '')) {
                    index += 1;
                }
            }

            if (source[index] === 'e' || source[index] === 'E') {
                index += 1;

                if (source[index] === '+' || source[index] === '-') {
                    index += 1;
                }

                if (!/\d/.test(source[index] ?? '')) {
                    throw new ExpressionParseError('Malformed exponent', source, start);
                }

                while (/\d/.test(source[index] ?? '')) {
                    index += 1;
                }
            }

            const text = source.slice(start, index);

            tokens.push({type: 'num', value: text, num: Number(text), start});
            continue;
        }

        if (IDENT_START.test(char)) {
            const start = index;

            while (index < source.length && IDENT_PART.test(source[index])) {
                index += 1;
            }

            tokens.push({type: 'ident', value: source.slice(start, index), start});
            continue;
        }

        // The ?. token only forms when no digit follows the dot, so a
        // ternary like "ok ? .5 : 1" keeps its leading-dot number
        if (char === '?' && source[index + 1] === '.' && /\d/.test(source[index + 2] ?? '')) {
            tokens.push({type: 'punct', value: '?', start: index});
            index += 1;
            continue;
        }

        const punct = PUNCTUATORS.find(p => source.startsWith(p, index));

        if (punct) {
            tokens.push({type: 'punct', value: punct, start: index});
            index += punct.length;
            continue;
        }

        throw new ExpressionParseError(`Unexpected character "${char}"`, source, index);
    }

    tokens.push({type: 'eof', value: '', start: source.length});

    return tokens;
}

// -------------------------------------------------------------------- AST

type Node =
    | {kind: 'literal'; value: unknown}
    | {kind: 'ident'; name: string; start: number}
    | {kind: 'array'; items: {spread: boolean; expr: Node}[]}
    | {kind: 'unary'; op: string; operand: Node}
    | {kind: 'binary'; op: string; left: Node; right: Node; paren?: boolean}
    | {kind: 'logical'; op: string; left: Node; right: Node; paren?: boolean}
    | {kind: 'ternary'; cond: Node; yes: Node; no: Node; paren?: boolean}
    | {kind: 'pipe'; left: Node; right: Node; paren?: boolean}
    | {kind: 'member'; object: Node; key: string | Node; computed: boolean; optional: boolean; paren?: boolean}
    | {kind: 'call'; callee: Node; args: {spread: boolean; expr: Node}[]; paren?: boolean}
    | {kind: 'arrow'; params: string[]; body: Node; paren?: boolean};

const BLOCKED_KEYS = new Set(['constructor', '__proto__', 'prototype']);
const NOT_IN_LANGUAGE = new Map([
    ['in', 'the "in" operator is not part of this language'],
    ['instanceof', 'the "instanceof" operator is not part of this language'],
]);

// -------------------------------------------------------------------- parser

class Parser {
    readonly #source: string;
    readonly #tokens: Token[];
    #index = 0;

    constructor(source: string, tokens: Token[]) {
        this.#source = source;
        this.#tokens = tokens;
    }

    #peek(offset = 0): Token {
        return this.#tokens[Math.min(this.#index + offset, this.#tokens.length - 1)];
    }

    #next(): Token {
        const token = this.#tokens[this.#index];

        this.#index += 1;

        return token;
    }

    #error(message: string, at: Token = this.#peek()): never {
        throw new ExpressionParseError(message, this.#source, at.start);
    }

    #expect(value: string): void {
        const token = this.#next();

        if (token.type !== 'punct' || token.value !== value) {
            this.#error(`Expected "${value}"`, token);
        }
    }

    #is(value: string): boolean {
        const token = this.#peek();

        return token.type === 'punct' && token.value === value;
    }

    parse(): Node {
        if (this.#peek().type === 'eof') {
            this.#error('Empty expression');
        }

        const node = this.#parsePipe();
        const trailing = this.#peek();

        if (trailing.type !== 'eof') {
            if (trailing.type === 'ident' && NOT_IN_LANGUAGE.has(trailing.value)) {
                this.#error(NOT_IN_LANGUAGE.get(trailing.value)!, trailing);
            }

            if (trailing.type === 'punct') {
                const hints: Record<string, string> = {
                    '&': 'The & operator is not part of this language — did you mean &&?',
                    '|': 'The | operator is not part of this language — did you mean |> or ||?',
                    '^': 'The ^ operator is not part of this language',
                    '<<': 'Bitwise shifts are not part of this language',
                    '>>': 'Bitwise shifts are not part of this language',
                    '>>>': 'Bitwise shifts are not part of this language',
                };

                if (hints[trailing.value]) {
                    this.#error(hints[trailing.value], trailing);
                }
            }

            this.#error(`Unexpected "${trailing.value}"`, trailing);
        }

        return node;
    }

    #parsePipe(): Node {
        let left = this.#parseTernary();

        if (this.#is('|>') && left.kind === 'ternary' && !left.paren) {
            this.#error('Mixing ?: with |> needs parentheses — parenthesize the ternary or the pipe');
        }

        while (this.#is('|>')) {
            this.#next();

            const right = this.#parseTernary();

            if (right.kind === 'ternary' && !right.paren) {
                this.#error('Mixing ?: with |> needs parentheses — parenthesize the ternary or the pipe');
            }

            if (right.kind === 'arrow' && !right.paren) {
                this.#error('Parenthesize the arrow on the right of |>');
            }

            left = {kind: 'pipe', left, right};
        }

        return left;
    }

    #parseTernary(): Node {
        const cond = this.#parseNullish();

        if (!this.#is('?')) {
            return cond;
        }

        this.#next();

        const yes = this.#parseTernary();

        this.#expect(':');

        const no = this.#parseTernary();

        return {kind: 'ternary', cond, yes, no};
    }

    #parseNullish(): Node {
        let left = this.#parseOr();

        while (this.#is('??')) {
            if ((left.kind === 'logical') && (left.op === '&&' || left.op === '||') && !left.paren) {
                this.#error('Mixing ?? with && or || needs parentheses');
            }

            this.#next();

            const right = this.#parseOr();

            if ((right.kind === 'logical') && (right.op === '&&' || right.op === '||') && !right.paren) {
                this.#error('Mixing ?? with && or || needs parentheses');
            }

            left = {kind: 'logical', op: '??', left, right};
        }

        return left;
    }

    #parseOr(): Node {
        let left = this.#parseAnd();

        while (this.#is('||')) {
            this.#next();
            left = {kind: 'logical', op: '||', left, right: this.#parseAnd()};
        }

        return left;
    }

    #parseAnd(): Node {
        let left = this.#parseEquality();

        while (this.#is('&&')) {
            this.#next();
            left = {kind: 'logical', op: '&&', left, right: this.#parseEquality()};
        }

        return left;
    }

    #parseEquality(): Node {
        let left = this.#parseRelational();

        for (;;) {
            if (this.#is('==') || this.#is('!=')) {
                const op = this.#peek().value;

                this.#error(`Use ${op}= (loose equality is not part of this language)`);
            }

            if (this.#is('===') || this.#is('!==')) {
                const op = this.#next().value;

                left = {kind: 'binary', op, left, right: this.#parseRelational()};
                continue;
            }

            return left;
        }
    }

    #parseRelational(): Node {
        let left = this.#parseAdditive();

        while (this.#is('<') || this.#is('<=') || this.#is('>') || this.#is('>=')) {
            const op = this.#next().value;

            left = {kind: 'binary', op, left, right: this.#parseAdditive()};
        }

        return left;
    }

    #parseAdditive(): Node {
        let left = this.#parseMultiplicative();

        while (this.#is('+') || this.#is('-')) {
            const op = this.#next().value;

            left = {kind: 'binary', op, left, right: this.#parseMultiplicative()};
        }

        return left;
    }

    #parseMultiplicative(): Node {
        let left = this.#parseUnary();

        for (;;) {
            if (this.#is('**')) {
                this.#error('The ** operator is not part of this language — use Math.pow');
            }

            if (this.#is('*') || this.#is('/') || this.#is('%')) {
                const op = this.#next().value;

                left = {kind: 'binary', op, left, right: this.#parseUnary()};
                continue;
            }

            return left;
        }
    }

    #parseUnary(): Node {
        if (this.#is('!') || this.#is('-') || this.#is('+')) {
            const op = this.#next().value;

            return {kind: 'unary', op, operand: this.#parseUnary()};
        }

        const token = this.#peek();

        if (token.type === 'ident' && token.value === 'typeof') {
            this.#next();

            return {kind: 'unary', op: 'typeof', operand: this.#parseUnary()};
        }

        return this.#parsePostfix();
    }

    #parsePostfix(): Node {
        let node = this.#parsePrimary();

        for (;;) {
            if (this.#is('.')) {
                this.#next();

                const key = this.#next();

                if (key.type !== 'ident') {
                    this.#error('Expected a property name after "."', key);
                }

                node = {kind: 'member', object: node, key: key.value, computed: false, optional: false};
                continue;
            }

            if (this.#is('?.')) {
                this.#next();

                if (this.#is('(')) {
                    this.#error('Optional call ?.() is not part of this language');
                }

                if (this.#is('[')) {
                    this.#next();

                    const key = this.#parsePipe();

                    this.#expect(']');
                    node = {kind: 'member', object: node, key, computed: true, optional: true};
                    continue;
                }

                const key = this.#next();

                if (key.type !== 'ident') {
                    this.#error('Expected a property name after "?."', key);
                }

                node = {kind: 'member', object: node, key: key.value, computed: false, optional: true};
                continue;
            }

            if (this.#is('[')) {
                this.#next();

                const key = this.#parsePipe();

                this.#expect(']');
                node = {kind: 'member', object: node, key, computed: true, optional: false};
                continue;
            }

            if (this.#is('(')) {
                this.#next();

                const args: {spread: boolean; expr: Node}[] = [];

                while (!this.#is(')')) {
                    const spread = this.#is('...');

                    if (spread) {
                        this.#next();
                    }

                    args.push({spread, expr: this.#parsePipe()});

                    if (!this.#is(')')) {
                        this.#expect(',');
                    }
                }

                this.#expect(')');
                node = {kind: 'call', callee: node, args};
                continue;
            }

            return node;
        }
    }

    #parsePrimary(): Node {
        const token = this.#peek();

        if (token.type === 'num') {
            this.#next();

            return {kind: 'literal', value: token.num};
        }

        if (token.type === 'str') {
            this.#next();

            return {kind: 'literal', value: token.value};
        }

        if (token.type === 'ident') {
            if (token.value === 'true' || token.value === 'false') {
                this.#next();

                return {kind: 'literal', value: token.value === 'true'};
            }

            if (token.value === 'null') {
                this.#next();

                return {kind: 'literal', value: null};
            }

            if (token.value === 'undefined') {
                this.#next();

                return {kind: 'literal', value: undefined};
            }

            // A one-token peek past an identifier detects a bare arrow head
            if (this.#peek(1).type === 'punct' && this.#peek(1).value === '=>') {
                const param = this.#next().value;

                this.#next();

                return {kind: 'arrow', params: [param], body: this.#parseTernary()};
            }

            this.#next();

            return {kind: 'ident', name: token.value, start: token.start};
        }

        if (token.type === 'punct' && token.value === '(') {
            if (this.#isArrowHead()) {
                return this.#parseParenArrow();
            }

            this.#next();

            const inner = this.#parsePipe();

            this.#expect(')');
            inner.paren = true;

            return inner;
        }

        if (token.type === 'punct' && token.value === '[') {
            this.#next();

            const items: {spread: boolean; expr: Node}[] = [];

            while (!this.#is(']')) {
                const spread = this.#is('...');

                if (spread) {
                    this.#next();
                }

                items.push({spread, expr: this.#parsePipe()});

                if (!this.#is(']')) {
                    this.#expect(',');
                }
            }

            this.#expect(']');

            return {kind: 'array', items};
        }

        this.#error(`Unexpected "${token.value || 'end of expression'}"`, token);
    }

    // Scans tokens from the current "(" to its matching ")" and peeks one
    // token further: "=>" means this is an arrow head, not a grouping
    #isArrowHead(): boolean {
        let depth = 0;
        let offset = 0;

        for (;;) {
            const token = this.#peek(offset);

            if (token.type === 'eof') {
                return false;
            }

            if (token.type === 'punct' && token.value === '(') {
                depth += 1;
            }

            if (token.type === 'punct' && token.value === ')') {
                depth -= 1;

                if (depth === 0) {
                    const after = this.#peek(offset + 1);

                    return after.type === 'punct' && after.value === '=>';
                }
            }

            offset += 1;
        }
    }

    #parseParenArrow(): Node {
        this.#expect('(');

        const params: string[] = [];

        if (this.#is(')')) {
            this.#error('Arrow functions here take at least one parameter');
        }

        for (;;) {
            const token = this.#next();

            if (token.type !== 'ident') {
                this.#error('Arrow parameters must be plain identifiers', token);
            }

            params.push(token.value);

            if (this.#is(')')) {
                this.#next();
                break;
            }

            this.#expect(',');
        }

        this.#expect('=>');

        return {kind: 'arrow', params, body: this.#parseTernary()};
    }
}

// ------------------------------------------------------------------ evaluator

function checkKey(key: unknown): string | number {
    if (typeof key === 'string' && BLOCKED_KEYS.has(key)) {
        throw new Error(`"${key}" is not reachable from expressions`);
    }

    return key as string | number;
}

function evaluateNode(node: Node, resolve: IdentifierResolver): unknown {
    switch (node.kind) {
        case 'literal':
            return node.value;
        case 'ident': {
            const resolution = resolve(node.name);

            if (!resolution.found) {
                throw new Error(`"${node.name}" is not defined ($-scope, props, data, methods, globals)`);
            }

            return resolution.value;
        }
        case 'array': {
            const result: unknown[] = [];

            node.items.forEach(item => {
                const value = evaluateNode(item.expr, resolve);

                if (item.spread) {
                    result.push(...(value as unknown[]));
                } else {
                    result.push(value);
                }
            });

            return result;
        }
        case 'unary': {
            if (node.op === 'typeof') {
                return typeof evaluateNode(node.operand, resolve);
            }

            const value = evaluateNode(node.operand, resolve);

            if (node.op === '!') {
                return !value;
            }

            if (node.op === '-') {
                return -(value as number);
            }

            return +(value as number);
        }
        case 'binary': {
            const left = evaluateNode(node.left, resolve) as never;
            const right = evaluateNode(node.right, resolve) as never;

            switch (node.op) {
                case '===': return left === right;
                case '!==': return left !== right;
                case '<': return left < right;
                case '<=': return left <= right;
                case '>': return left > right;
                case '>=': return left >= right;
                case '+': return (left as number) + (right as number);
                case '-': return (left as number) - (right as number);
                case '*': return (left as number) * (right as number);
                case '/': return (left as number) / (right as number);
                default: return (left as number) % (right as number);
            }
        }
        case 'logical': {
            const left = evaluateNode(node.left, resolve);

            if (node.op === '&&') {
                return left ? evaluateNode(node.right, resolve) : left;
            }

            if (node.op === '||') {
                return left ? left : evaluateNode(node.right, resolve);
            }

            return left !== null && left !== undefined ? left : evaluateNode(node.right, resolve);
        }
        case 'ternary':
            return evaluateNode(node.cond, resolve) ? evaluateNode(node.yes, resolve) : evaluateNode(node.no, resolve);
        case 'pipe': {
            const value = evaluateNode(node.left, resolve);
            const fn = evaluateNode(node.right, resolve);

            if (typeof fn !== 'function') {
                throw new TypeError(`right side of |> is not a function: ${String(fn)}`);
            }

            return fn(value);
        }
        case 'member': {
            const object = evaluateNode(node.object, resolve);

            if (node.optional && (object === null || object === undefined)) {
                return undefined;
            }

            const key = checkKey(node.computed ? evaluateNode(node.key as Node, resolve) : node.key);

            return (object as Record<string | number, unknown>)[key];
        }
        case 'call': {
            const args: unknown[] = [];

            node.args.forEach(arg => {
                const value = evaluateNode(arg.expr, resolve);

                if (arg.spread) {
                    args.push(...(value as unknown[]));
                } else {
                    args.push(value);
                }
            });

            if (node.callee.kind === 'member') {
                const receiver = evaluateNode(node.callee.object, resolve);

                if (node.callee.optional && (receiver === null || receiver === undefined)) {
                    return undefined;
                }

                const key = checkKey(node.callee.computed ? evaluateNode(node.callee.key as Node, resolve) : node.callee.key);
                const fn = (receiver as Record<string | number, unknown>)[key];

                if (typeof fn !== 'function') {
                    throw new TypeError(`${String(key)} is not a function`);
                }

                return fn.apply(receiver, args);
            }

            const fn = evaluateNode(node.callee, resolve);

            if (typeof fn !== 'function') {
                throw new TypeError('Call target is not a function');
            }

            return fn(...args);
        }
        default: {
            const arrow = node as Extract<Node, {kind: 'arrow'}>;

            return (...args: unknown[]) => {
                const params = new Map(arrow.params.map((param, index) => [param, args[index]]));

                return evaluateNode(arrow.body, name => params.has(name) ? {found: true, value: params.get(name)} : resolve(name));
            };
        }
    }
}

// ------------------------------------------------------------------ assign

function collectPath(node: Node): string[] | null {
    if (node.kind === 'ident') {
        return [node.name];
    }

    if (node.kind === 'member' && !node.computed && !node.optional) {
        const head = collectPath(node.object);

        return head ? [...head, node.key as string] : null;
    }

    return null;
}

// ------------------------------------------------------------------ compile

const compileCache = new Map<string, CompiledExpression>();

export function compile(source: string): CompiledExpression {
    const cached = compileCache.get(source);

    if (cached) {
        return cached;
    }

    const ast = new Parser(source, tokenize(source)).parse();
    const path = collectPath(ast);
    const compiled: CompiledExpression = {
        source,
        assignable: path !== null,
        rootIdentifier: path?.[0],
        evaluate: resolve => evaluateNode(ast, resolve),
        assign: (resolve, value) => {
            if (!path) {
                throw new Error(`"${source}" is not assignable`);
            }

            const resolution = resolve(path[0]);

            if (!resolution.found) {
                throw new Error(`"${path[0]}" is not defined for write-back`);
            }

            if (path.length === 1) {
                // The resolver returns the CONTAINER for a bare-root write
                (resolution.value as Record<string, unknown>)[checkKey(path[0])] = value;

                return;
            }

            let target = resolution.value as Record<string, unknown>;

            for (let index = 1; index < path.length - 1; index += 1) {
                target = target[checkKey(path[index])] as Record<string, unknown>;
            }

            target[checkKey(path[path.length - 1])] = value;
        },
    };

    Object.freeze(compiled);
    compileCache.set(source, compiled);

    return compiled;
}
```

- [ ] **Step 4: GREEN + full regression** — expression suite all green; `npm run typecheck` clean; existing 131 + 3 untouched and green.

- [ ] **Step 5: commit** — `git add packages/app.js/src/expression.ts packages/app.js/tests/expression.test.ts && git commit -m 'feat: expression language - tokenizer, Pratt parser, evaluator, pipes, sandbox (#15)'`

---

### Task 3: Integration — the resolver chain replaces eval

**Files:**
- Modify: `packages/app.js/src/app.ts`, `packages/app.js/tests/props.test.ts` (flip 1 + additions), `packages/app.js/tests/ghost.test.ts` (flip 2), `packages/app.js/tests/directives.test.ts` (additions), `packages/app.js/tests/interpolation.test.ts` (additions)

**Interfaces:**
- Consumes: Task 2's exact exports.
- Produces: `#resolverFor(scope?)`, `#dataResolver` (getter), `EXPRESSION_GLOBALS`, `#writeBackSource` entry-consumption, `#compileAtWiring(expression, context)`. Task 4 relies on nothing new beyond working pipes.

- [ ] **Step 1: import + globals + resolvers.** Top of `app.ts`: `import { compile, renderCaret, ExpressionParseError } from './expression'; import type { IdentifierResolver } from './expression';`. Module level:

```ts
const EXPRESSION_GLOBALS = new Map<string, unknown>(Object.entries({Math, JSON, Number, String, Boolean, Array, isNaN, isFinite, parseInt, parseFloat}));
const UNREFERENCEABLE_PROP_NAMES = new Set(['typeof', 'true', 'false', 'null', 'undefined']);
```

Instance members:

```ts
    #writeBackSource: HTMLElement | undefined;

    #resolverFor(scope?: Record<string, unknown>): IdentifierResolver {
        return name => {
            if (scope && Object.hasOwn(scope, name)) {
                return {found: true, value: scope[name]};
            }

            if (Object.hasOwn(this.props, name)) {
                return {found: true, value: (this.props as Record<string, unknown>)[name]};
            }

            if (Object.hasOwn(this.data, name)) {
                return {found: true, value: (this.data as Record<string, unknown>)[name]};
            }

            if (Object.hasOwn(this.methods, name)) {
                return {found: true, value: this.methods[name]};
            }

            if (EXPRESSION_GLOBALS.has(name)) {
                return {found: true, value: EXPRESSION_GLOBALS.get(name)};
            }

            return {found: false};
        };
    }

    // Write-back resolves ONLY through data, returning the root VALUE for
    // path walks; bare-root writes never reach this resolver — the listener
    // writes those through the ghost directly so its setter fires
    get #dataResolver(): IdentifierResolver {
        return name => Object.hasOwn(this.data, name)
            ? {found: true, value: (this.data as Record<string, unknown>)[name]}
            : {found: false};
    }
```

(Contract note: the module's `assign` treats a single-identifier path as "resolver returns the CONTAINER" — that branch is unit-tested in Task 2 but app.ts never uses it: the write-back listener handles bare roots itself by assigning through the ghost, and calls `compiled.assign(this.#dataResolver, …)` only for multi-step paths, where the resolver's root-VALUE shape is exactly right.)

- [ ] **Step 2: `#evaluate` becomes the adapter.** Replace the entire eval body (prologue building, scope juggling, `eval` call) with:

```ts
    #evaluate({expression, scope}: {expression: string; scope?: Record<string, unknown>}): unknown {
        return compile(expression).evaluate(this.#resolverFor(scope));
    }
```

Delete: `#evaluationScope`, `#evaluationElement`, both save/restore blocks, the write-back `#evaluate({element})` variant, `RESERVED_IDENTIFIERS`, the reserved check inside `isValidPropName` (keep shape + emptiness; add `UNREFERENCEABLE_PROP_NAMES.has(name)` as the residual loud error). Keep every call-site's surrounding try/catch untouched.

- [ ] **Step 3: compile-at-wiring.** Add:

```ts
    #compileAtWiring(expression: string, context: Element | Comment): boolean {
        try {
            compile(expression);

            return true;
        } catch (error) {
            if (error instanceof ExpressionParseError) {
                console.error(`Can't parse the "${expression}" expression:\n${renderCaret(error)}\n${error.message}`, context);

                return false;
            }

            throw error;
        }
    }
```

Call it (skip registration on `false`) at every wiring site: the `[data-show-if]` sweep, `[data-display-if]` sweep (root and in-item), the `[data-value]` sweep (before the form-control checks), `#extractForBlock` (both the list and key expressions — a bad key expression skips the whole block with the caret error), the interpolation wiring (per placeholder part), and `#collectProps` (per prop expression — a parse failure logs the caret and skips that prop, seeding nothing).

- [ ] **Step 4: write-back.** In the `[data-value]` wiring, replace the old listener body:

```ts
            const compiled = compile(element.dataset['value']!);

            if (!compiled.assignable) {
                console.error('data-value needs a plain dot path (name, user.email) — computed steps and ?. can\'t guarantee a reactive write', element);

                return;
            }

            if (Object.hasOwn(this.props, compiled.rootIdentifier!)) {
                console.error(`data-value cannot bind the "${compiled.rootIdentifier}" prop — props are inputs; copy into data to edit`, element);

                return;
            }
```

(the prop-root check replaces the old source regex), and the listener:

```ts
            element.addEventListener(eventName, () => {
                this.#writeBackSource = element;

                try {
                    if (compiled.source.trim() === compiled.rootIdentifier) {
                        (this.data as Record<string, unknown>)[compiled.rootIdentifier!] = (element as HTMLInputElement).value;
                    } else {
                        compiled.assign(this.#dataResolver, (element as HTMLInputElement).value);
                    }
                } catch (error) {
                    console.error(`Can't write back the "${compiled.source}" expression`, element, error);
                } finally {
                    this.#writeBackSource = undefined;
                }
            }, {signal: this.#abortController.signal});
```

`#runUpdatePass` consumes the source once at entry (nested passes see nothing — they must re-write normally):

```ts
        const sourceElement = this.#writeBackSource;

        this.#writeBackSource = undefined;
```

and passes `sourceElement` to `#updateValues(sourceElement)`. The ghost setter's `#runUpdatePass(newValue)` argument and the `isNewValueFromInputElement` branch are DELETED (setters call `#runUpdatePass()` bare; the element-to-value magic is gone).

- [ ] **Step 5: the two flips + additions.**

Flip 1 — `props.test.ts`, replace the reserved-identifier test:

```ts
    it('malformed and unreferenceable prop names error; former reserved words are legal (issue #15)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><div data-component="greeter" data-component-prop-class="7" data-component-prop-typeof="1" data-component-prop-who="&quot;Ada&quot;"></div></template>',
            greeter: `<template><p>\${greeting}, \${who}! (\${class})</p></template>
<script>export default {data: () => ({greeting: 'Hello'})};</script>`,
        });
        const host = mountPoint();
        new Component({element: host});

        await vi.waitFor(() => {
            expect(host.querySelector('p')?.textContent).toBe('Hello, Ada! (7)');
        });
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('typeof');
    });
```

Flip 2 — `ghost.test.ts`, replace "stores an input element's value when one is assigned":

```ts
    it('stores an assigned element as-is — no value extraction magic (issue #15)', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint(), data: {title: 'x'}});
        await flush();

        const input = document.createElement('input');

        input.value = 'from input';
        app.data.title = input;

        expect(app.data.title).toBe(input);
    });
```

Additions — `interpolation.test.ts`:

```ts
    it('pipes through a method formatter (issue #15)', async () => {
        stubTemplates({root: '<template><p>${todos |> left} left</p></template>'});
        const host = mountPoint();
        const left = (todos: Array<{done: boolean}>) => todos.filter(todo => !todo.done).length;

        new Component({
            element: host,
            data: {todos: [{done: false}, {done: true}, {done: false}]},
            methods: {left: left as unknown as ComponentMethod},
        });

        await vi.waitFor(() => {
            expect(host.querySelector('p')?.textContent).toBe('2 left');
        });
    });
```

(`ComponentMethod` types handlers as `(event, item, index)`; a pipe formatter is just a unary function stored in the same bag — the single cast keeps the runtime shape honest. Import `ComponentMethod` as a type from `../src/app` at the top of the test file if not already imported.)

```ts
    it('an unknown identifier error names the whole chain (issue #15)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><p>${ghost}</p></template>'});
        const host = mountPoint();
        new Component({element: host, data: {}});

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat().join(' ')).toContain('$-scope, props, data, methods, globals');
        });
    });
```

Addition — `directives.test.ts`:

```ts
    it('a parse error at wiring logs a caret once and skips only that binding (issue #15)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template><p data-show-if="count >">broken</p><i>${count}</i></template>'});
        const host = mountPoint();
        const app = new Component({element: host, data: {count: 1}});
        await app.ready;

        expect(host.querySelector('i')?.textContent).toBe('1');
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('^');

        const callsAfterMount = errorSpy.mock.calls.length;

        app.data.count = 2;

        expect(host.querySelector('i')?.textContent).toBe('2');
        expect(errorSpy.mock.calls.length).toBe(callsAfterMount);
    });
```

- [ ] **Step 6: full gate** — `npm run typecheck && npm test`: everything green (the two flips rewritten, four additions). Expected ~135 unit + 3 smoke plus the Task 2 expression suite.

- [ ] **Step 7: commit** — `git add packages/app.js && git commit -m 'feat: resolver chain replaces eval - wiring-time parse errors, path write-back (#15)'`

---

### Task 4: Stub smoke, pipe showcase, docs

**Files:**
- Create: `packages/examples/todo/noeval.html`, `packages/examples/tests/todo-noeval.smoke.test.ts`
- Modify: `packages/examples/todo/index.html`, `packages/examples/todo/templates/root.html`, `packages/examples/tests/todo.smoke.test.ts` (only if selectors need the new footer), `README.md`, `CLAUDE.md`

- [ ] **Step 1: showcase.** `todo/index.html` methods gain a formatter (plain unary function — document with a one-line comment that formatters are methods used in pipes):

```js
            left(todos) {
                return todos.filter(todo => !todo.done).length;
            },
```

`templates/root.html` gains, after the list: `<p>${todos |> left} left</p>`.

- [ ] **Step 2: the stub page.** `packages/examples/todo/noeval.html` — copy `index.html` byte-for-byte, then insert as the FIRST child of `<head>` (before any other script):

```html
    <script>
        // Explicit window assignments: happy-dom runs classic scripts in a
        // function scope, so bare declarations would not become globals and
        // the stub would silently protect nothing
        window.eval = function () { throw new Error('eval is disabled on this page'); };
        globalThis.eval = window.eval;
        window.Function = function () { throw new Error('Function is disabled on this page'); };
    </script>
```

- [ ] **Step 3: the stub smoke test.** `packages/examples/tests/todo-noeval.smoke.test.ts` — mirror `todo.smoke.test.ts`'s server/Browser setup (port 8234, same helpers) but navigate to `/noeval.html` and run the full flow: initial render (two todos + the `left` footer), add one via the form, toggle one, remove one, asserting DOM after each step exactly as the main todo smoke does, PLUS `expect(pageErrors).toHaveLength(0)`-style console assertion if the main smoke has one. RED expectation before Task 3 landed would be total failure — at this point in the plan it must be GREEN; its meaningfulness was proven by design (the stub kills the old engine).

- [ ] **Step 4: docs.** All new text forge-agnostic, prose-only (no issue numbers, no spec references):
  - `README.md`: replace/extend the interpolation bullet area with an "Expressions" section: the language in six lines (literals/members/calls/arrows/spread/ternary/logical/pipes; no assignment or statements), the resolution chain in one line, `${todos |> left} left` as the pipe example, parse errors shown with a caret at load time, and the CSP sentence updated: "Expressions are parsed and evaluated by the framework itself — no `eval`, no `unsafe-eval` CSP requirement; loading component `<script>`s still uses `data:` module imports."
  - `CLAUDE.md`: rewrite the "Expression evaluation — `evaluate()`" section: tokenizer → Pratt parser → evaluator in `src/expression.ts` (pure, parse-once cache); resolution chain `$-scope → props → data → methods → globals whitelist` with a miss being a loud error; F# pipes with the paren rules; static-dot-path write-back with the entry-consumed source-element skip; sandbox rule; parse-at-wiring error class. Update "What this is": the framework source is now `src/app.ts` + `src/expression.ts`. Update the `data-value` bullet: expression must be a plain dot path. Drop the `#evaluationScope`/`#evaluationElement` sentence.

- [ ] **Step 5: full gate + commit**

```bash
npm run typecheck && npm test
pgrep -f serve.mjs || echo "no stray servers"
git add packages/examples README.md CLAUDE.md
git commit -m 'feat: no-eval smoke proof, todo pipe showcase, docs (fixes #15)'
```

Expected: unit suites green; smoke now 3 + 1 files (4 tests).

---

### Task 5: Final gate (verification only, no commit)

```bash
cd /Users/mellonis/Developer/mellonis-workspace/app.js
rm -rf node_modules packages/app.js/dist
npm ci && npm run typecheck && npm test
grep -rc 'eval(' packages/app.js/src | grep -v ':0' && echo "FAIL: eval survives" || echo "OK: no eval"
git ls-files | grep -E '(^|/)dist/' && echo FAIL || echo "OK: no build output tracked"
(npm run ex:todo >/dev/null 2>&1 &) ; sleep 2 ; curl -s http://localhost:8123/noeval.html | grep -q 'eval is disabled' && echo "stub page served OK" ; pkill -f 'serve.mjs todo' ; pgrep -f serve.mjs || echo "no stray servers"
```

Expected: clean rebuild green; `OK: no eval`; no tracked dist; stub page served; no leaks. Branch ready for whole-branch review and the maintainer's landing decision.
