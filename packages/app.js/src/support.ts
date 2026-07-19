// Types, constants, and pure helpers shared by the engine and the definition
// loader. Everything here is free of instance state: a type, a frozen lookup
// table, a message string, or a function whose only inputs are its arguments.
//
// The Component import below is TYPE-ONLY and stays that way. Several binding
// records name the class in a field's type (a props binding holds the child
// instance it re-seeds), which is a declaration-level cycle TypeScript
// resolves natively and erases at emit — the compiled module graph runs one
// way, from here outward. A runtime import of the engine would make that a
// real cycle, so nothing in this file may call a static, construct an
// instance, or otherwise touch Component outside type position.
import type Component from './app.js';

export type ComponentMethod = (this: Component, event: Event, item?: unknown, index?: number) => void;
export type BoundComponentMethod = (event: Event, item?: unknown, index?: number) => void;

export interface ComponentOptions {
    element?: HTMLElement;
    componentName?: string | null;
    data?: Record<string, unknown>;
    methods?: Record<string, ComponentMethod>;
}

export type TrackedBinding =
    | {kind: 'show'; element: HTMLElement; dependencies: Set<string>}
    | {kind: 'display'; element: HTMLElement; dependencies: Set<string>}
    | {kind: 'disabled'; element: HTMLElement; dependencies: Set<string>}
    | {kind: 'value'; element: HTMLElement; dependencies: Set<string>}
    | {kind: 'text'; node: Text; dependencies: Set<string>}
    | {kind: 'block'; block: ForBlock; dependencies: Set<string>}
    | {kind: 'props'; child: Component; dependencies: Set<string>};

export interface ShowIfEntry {
    anchor: Comment;
    expression: string;
    isHidden: boolean;
    scopeRef?: ForBlockScopeRef;
    binding: TrackedBinding;
}

export interface ValueEntry {
    expression: string;
    scopeRef?: ForBlockScopeRef;
    binding: TrackedBinding;
}

export interface DisplayIfEntry {
    expression: string;
    originalDisplay: string;
    scopeRef?: ForBlockScopeRef;
    binding: TrackedBinding;
}

export interface DisabledIfEntry {
    expression: string;
    scopeRef?: ForBlockScopeRef;
    binding: TrackedBinding;
}

export interface ForBlockScopeRef {
    block: ForBlock;
    key: string;
}

export interface TextNodeEntry {
    expression: string;
    scopeRef?: ForBlockScopeRef;
    binding: TrackedBinding;
}

export interface TextPart {
    isExpression: boolean;
    value: string;
}

export interface ForBlockEntry {
    element: HTMLElement;
    item: unknown;
    index: number;
    key: string;
    boundElements: (HTMLElement | Text)[];
    // Per-entry lifetime for the clone's data-on-* listeners, chained to the
    // parent's signal — the eviction sweep aborts it directly, so a listener
    // dies with its entry instead of lingering until the whole component is
    // destroyed
    listenerController: AbortController;
    child?: Component;
}

export interface ForBlock {
    anchorStart: Comment;
    anchorEnd: Comment;
    templateElement: HTMLElement;
    listExpression: string;
    keyExpression: string;
    array: unknown[];
    entries: Map<string, ForBlockEntry>;
    reportedErrorKinds: Set<string>;
    ancestorChain: string[];
    generation: number;
    binding: TrackedBinding;
}

export interface LoadComponentOptions {
    componentWrapper?: HTMLElement;
    componentName?: string;
    parentComponentNameList?: string[];
}

// Recorded at the receiving component's own wiring time, before any
// distribution — the anchor is the live position marker the projected (or
// fallback) content eventually replaces, wherever it currently lives; the
// fallback fragment is held unwired until distribution decides whether it is
// ever needed.
export interface SlotRecordEntry {
    anchor: Comment;
    fallbackFragment: DocumentFragment;
}

export interface PropBinding {
    propName: string;
    expression: string;
    lastSeeded: unknown;
}

export interface PropBindingRecord {
    bindings: PropBinding[];
    scopeRef?: ForBlockScopeRef;
    reportedErrorKinds: Set<string>;
    binding: TrackedBinding;
}

export const EXPRESSION_GLOBALS = new Map<string, unknown>(Object.entries({Math, JSON, Number, String, Boolean, Array, isNaN, isFinite, parseInt, parseFloat}));
export const UNREFERENCEABLE_PROP_NAMES = new Set(['typeof', 'true', 'false', 'null', 'undefined']);

export function isValidPropName(name: string): boolean {
    return /^[A-Za-z_$][\w$]*$/.test(name) && !UNREFERENCEABLE_PROP_NAMES.has(name);
}

export interface ComponentEvents {
    emit(name: string, payload?: unknown): void;
    on(name: string, handler: (event: CustomEvent) => void): void;
    onParent(name: string, handler: (event: CustomEvent) => void): void;
}

export const RESERVED_EVENT_NAME = 'props';

export const COMPONENT_DESTROYED_MESSAGE = 'The component was destroyed';

export interface ComponentDefinition {
    data?: () => Record<string, unknown>;
    methods?: Record<string, ComponentMethod>;
    mounted?: (this: Component) => void | (() => void);
    css?: string;
}

export interface InternalConstruction {
    definition: ComponentDefinition;
    parentEventTarget: EventTarget;
    ancestorChain: string[];
    propSeeds: Record<string, unknown>;
    propNames: string[];
}

export const DEFINITION_KEYS = new Set(['data', 'methods', 'mounted']);

// Brace-counting scanner (not a regex): splits template text into static
// parts and ${expression} parts; `\${` escapes a literal `${`. Throws on an
// unmatched `${` so wiring can reject the node loudly.
export function splitInterpolations(text: string): TextPart[] {
    const parts: TextPart[] = [];
    let staticBuffer = '';
    let position = 0;

    while (position < text.length) {
        if (text[position] === '\\' && text.startsWith('${', position + 1)) {
            staticBuffer += '${';
            position += 3;

            continue;
        }

        if (text.startsWith('${', position)) {
            let depth = 1;
            let end = position + 2;

            while (end < text.length && depth > 0) {
                if (text[end] === '{') {
                    depth += 1;
                } else if (text[end] === '}') {
                    depth -= 1;
                }

                end += 1;
            }

            if (depth > 0) {
                throw new Error('Unmatched ${ in template text');
            }

            if (staticBuffer) {
                parts.push({isExpression: false, value: staticBuffer});
                staticBuffer = '';
            }

            parts.push({isExpression: true, value: text.slice(position + 2, end - 1)});
            position = end;

            continue;
        }

        staticBuffer += text[position];
        position += 1;
    }

    if (staticBuffer) {
        parts.push({isExpression: false, value: staticBuffer});
    }

    return parts;
}

export function collectTextNodes(node: Node, into: Text[] = []): Text[] {
    node.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
            into.push(child as Text);
        } else {
            collectTextNodes(child, into);
        }
    });

    return into;
}

// Whitespace-only text and comments are ignorable everywhere content is
// judged present or absent — a formatted-but-empty wrapper is not content.
// Shared by the SFC-file sibling check and every slot-distribution decision
// (bucket emptiness, the missing-default-slot error, the slotless-template
// error) so the two notions of "meaningful" can never drift apart.
export function isMeaningfulNode(node: Node): boolean {
    if (node.nodeType === Node.COMMENT_NODE) {
        return false;
    }

    if (node.nodeType === Node.TEXT_NODE) {
        return !!(node.textContent ?? '').trim();
    }

    return true;
}

// Every ${} interpolation's bound Text node, across every component instance
// — a bound node starts life empty (its first drain hasn't run yet) and
// binding bookkeeping is otherwise private to whichever instance owns it, so
// a cross-instance "was content provided here" check (slot distribution
// reading a node the PARENT wired) has nothing else to consult
export const trackedInterpolationTextNodes = new WeakSet<Text>();

// Directive anchors are comments standing in for LIVE content — a hidden
// data-show-if element or a data-for block's insertion range. For "was
// content provided" questions they must count, or a projected block whose
// element was extracted before distribution would silently read as empty
export const directiveAnchorComments = new WeakSet<Comment>();

export function trackDirectiveAnchor(comment: Comment): Comment {
    directiveAnchorComments.add(comment);

    return comment;
}

// A bound ${} interpolation starts life as an EMPTY text node — its first
// drain hasn't run yet at distribution time — so a blank-content check would
// misread live projected text as absent. Presence of the binding is what
// "content was provided" means, not its value at this snapshot in time.
export function isContentNode(node: Node): boolean {
    if (node instanceof Text && trackedInterpolationTextNodes.has(node)) {
        return true;
    }

    if (node instanceof Comment && directiveAnchorComments.has(node)) {
        return true;
    }

    return isMeaningfulNode(node);
}

export const formControlTagNames = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
export const DATA_VALUE_FORM_ONLY_MESSAGE = 'data-value only works on form controls (input, textarea, select) — use ${expression} interpolation to display text';
export const disableableTagNames = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);
export const DATA_DISABLED_IF_MESSAGE = 'data-disabled-if only works on elements that honor disabled (input, textarea, select, button)';
// Kebab suffix IS the event type, verbatim — HTML lowercases attribute names,
// so case-sensitive event types are inexpressible here (irrelevant for
// element-level DOM events, which are all-lowercase)
export const DATA_ON_ATTRIBUTE_NAME_PATTERN = /^data-on-(.+)$/;

export const DEFAULT_SLOT_NAME = '';
export const SLOT_FORBIDDEN_DIRECTIVE_ATTRIBUTES = new Set(['data-show-if', 'data-display-if', 'data-disabled-if', 'data-value', 'data-ref', 'data-component', 'data-for', 'data-key']);

// A <slot> is a mount-time marker, never a live directive host — wrap the
// region in a container element instead of decorating the slot itself
export function slotHasForbiddenDirective(element: HTMLElement): boolean {
    return Array.from(element.attributes).some(attribute =>
        SLOT_FORBIDDEN_DIRECTIVE_ATTRIBUTES.has(attribute.name) || DATA_ON_ATTRIBUTE_NAME_PATTERN.test(attribute.name));
}
