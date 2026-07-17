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

describe('evaluation order (issue #24)', () => {
    it('an optional member call short-circuits before evaluating arguments', () => {
        const boom = () => { throw new Error('args must not evaluate'); };

        expect(evalWith('u?.f(boom())', {u: null, boom})).toBe(undefined);
        expect(evalWith('u?.f(boom())', {u: undefined, boom})).toBe(undefined);
    });

    it('method calls evaluate the receiver before the arguments', () => {
        const order: string[] = [];
        const target = {get obj() { order.push('receiver'); return {m: (x: unknown) => x}; }};
        const arg = () => { order.push('arg'); return 1; };

        expect(evalWith('t.obj.m(arg())', {t: target, arg})).toBe(1);
        expect(order).toEqual(['receiver', 'arg']);
    });

    it('the no-space optional-chain/number ambiguity resolves as a ternary', () => {
        expect(evalWith('ok?.5:1', {ok: true})).toBe(0.5);
        expect(evalWith('ok?.5:1', {ok: false})).toBe(1);
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

    it('exposes the assignment depth for assignable paths (issue #24)', () => {
        expect(compile('name').assignmentDepth).toBe(1);
        expect(compile('(name)').assignmentDepth).toBe(1);
        expect(compile('user.contact.email').assignmentDepth).toBe(3);
        expect(compile('a + b').assignmentDepth).toBe(undefined);
    });

    it('compile caches by source', () => {
        expect(compile('a + b')).toBe(compile('a + b'));
    });
});
