export interface Resolution {
    found: boolean;
    value?: unknown;
}

export type IdentifierResolver = (name: string) => Resolution;

export interface CompiledExpression {
    readonly source: string;
    readonly assignable: boolean;
    readonly rootIdentifier?: string;
    readonly assignmentDepth?: number;
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
    | {kind: 'literal'; value: unknown; paren?: boolean}
    | {kind: 'ident'; name: string; start: number; paren?: boolean}
    | {kind: 'array'; items: {spread: boolean; expr: Node}[]; paren?: boolean}
    | {kind: 'unary'; op: string; operand: Node; paren?: boolean}
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

        if (this.#is('|>') && left.kind === 'arrow' && !left.paren) {
            this.#error('A pipe inside an arrow body needs parentheses — parenthesize the pipe: x => (a |> f)');
        }

        while (this.#is('|>')) {
            this.#next();

            const right = this.#parseTernary();

            if (right.kind === 'ternary' && !right.paren) {
                this.#error('Mixing ?: with |> needs parentheses — parenthesize the ternary or the pipe');
            }

            if (right.kind === 'arrow' && !right.paren) {
                this.#error('An arrow on the right of |> needs parentheses');
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
            // Receiver first, then arguments — the order the language the
            // students already know uses; an optional receiver that turns out
            // nullish short-circuits before any argument evaluates
            const collectArgs = (): unknown[] => {
                const args: unknown[] = [];

                node.args.forEach(arg => {
                    const value = evaluateNode(arg.expr, resolve);

                    if (arg.spread) {
                        args.push(...(value as unknown[]));
                    } else {
                        args.push(value);
                    }
                });

                return args;
            };

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

                return fn.apply(receiver, collectArgs());
            }

            const args = collectArgs();
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
        assignmentDepth: path?.length,
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
