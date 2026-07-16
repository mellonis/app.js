type ComponentMethod = (this: Component, event: Event, item?: unknown, index?: number) => void;
type BoundComponentMethod = (event: Event, item?: unknown, index?: number) => void;

interface ComponentOptions {
    element?: HTMLElement;
    componentName?: string | null;
    data?: Record<string, unknown>;
    methods?: Record<string, ComponentMethod>;
}

interface ShowIfEntry {
    anchor: Comment;
    expression: string;
    isHidden: boolean;
    scopeRef?: ForBlockScopeRef;
}

interface ValueEntry {
    expression: string;
    scopeRef?: ForBlockScopeRef;
}

interface DisplayIfEntry {
    expression: string;
    originalDisplay: string;
    scopeRef?: ForBlockScopeRef;
}

interface ForBlockScopeRef {
    block: ForBlock;
    key: string;
}

interface TextNodeEntry {
    expression: string;
    scopeRef?: ForBlockScopeRef;
}

interface TextPart {
    isExpression: boolean;
    value: string;
}

interface ForBlockEntry {
    element: HTMLElement;
    item: unknown;
    index: number;
    key: string;
    boundElements: (HTMLElement | Text)[];
    child?: Component;
}

interface ForBlock {
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
}

interface LoadComponentOptions {
    componentWrapper?: HTMLElement;
    componentName?: string;
    parentComponentNameList?: string[];
}

interface PropBinding {
    propName: string;
    expression: string;
    lastSeeded: unknown;
}

interface PropBindingRecord {
    bindings: PropBinding[];
    scopeRef?: ForBlockScopeRef;
    reportedErrorKinds: Set<string>;
}

const RESERVED_IDENTIFIERS = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await', 'eval', 'arguments']);

function isValidPropName(name: string): boolean {
    return /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED_IDENTIFIERS.has(name);
}

interface ComponentEvents {
    emit(name: string, payload?: unknown): void;
    on(name: string, handler: (event: CustomEvent) => void): void;
    onParent(name: string, handler: (event: CustomEvent) => void): void;
}

const RESERVED_EVENT_NAME = 'props';

const COMPONENT_DESTROYED_MESSAGE = 'The component was destroyed';

interface ComponentDefinition {
    data?: () => Record<string, unknown>;
    methods?: Record<string, ComponentMethod>;
    mounted?: (this: Component) => void | (() => void);
}

interface InternalConstruction {
    definition: ComponentDefinition;
    parentEventTarget: EventTarget;
    ancestorChain: string[];
    propSeeds: Record<string, unknown>;
    propNames: string[];
}

const DEFINITION_KEYS = new Set(['data', 'methods', 'mounted']);

// Brace-counting scanner (not a regex): splits template text into static
// parts and ${expression} parts; `\${` escapes a literal `${`. Throws on an
// unmatched `${` so wiring can reject the node loudly.
function splitInterpolations(text: string): TextPart[] {
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

function collectTextNodes(node: Node, into: Text[] = []): Text[] {
    node.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
            into.push(child as Text);
        } else {
            collectTextNodes(child, into);
        }
    });

    return into;
}

const eventNameList = ['click', 'submit'];
const formControlTagNames = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const DATA_VALUE_FORM_ONLY_MESSAGE = 'data-value only works on form controls (input, textarea, select) — use ${expression} interpolation to display text';
const elementsWithDataOnAttributeSelector = eventNameList.map(eventName => `[data-on-${eventName}]`).join(',');
const dataOnAttributeNameRegExp = new RegExp(`^data-on-(${eventNameList.join('|')})$`);

export default class Component {
    declare readonly componentName: string;
    declare readonly data: Record<string, unknown>;
    declare readonly element: HTMLElement;
    declare readonly methods: Readonly<Record<string, BoundComponentMethod>>;
    declare readonly ready: Promise<void>;
    declare readonly events: ComponentEvents;
    declare readonly props: Readonly<Record<string, unknown>>;
    declare readonly refs: Record<string, HTMLElement>;

    #propsBacking: Record<string, unknown> = {};
    readonly #propBindings = new Map<Component, PropBindingRecord>();

    readonly #showIfElementToDataMap = new Map<HTMLElement, ShowIfEntry>();
    readonly #displayIfElementToDataMap = new Map<HTMLElement, DisplayIfEntry>();
    readonly #valueElementToDataMap = new Map<HTMLElement, ValueEntry>();
    readonly #textNodeToDataMap = new Map<Text, TextNodeEntry>();
    readonly #forBlocks = new Set<ForBlock>();

    #cleanup: (() => void) | undefined;
    readonly #refsBacking: Record<string, HTMLElement> = {};

    #evaluationScope: Record<string, unknown> | undefined;
    #evaluationElement: HTMLElement | undefined;

    readonly #abortController = new AbortController();
    #destroyed = false;

    readonly #eventTarget = new EventTarget();
    #parentEventTarget: EventTarget | undefined;

    static readonly #definitionPromiseMap = new Map<string, Promise<ComponentDefinition | null>>();
    static #constructionContext: InternalConstruction | undefined;

    readonly #childComponents = new Set<Component>();
    #definition: ComponentDefinition | undefined;
    #initialAncestorChain: string[] = [];

    static readonly #templateNameToTemplatePromiseMap = new Map<string, Promise<string>>();

    constructor({element = document.body, componentName = 'root', data = {}, methods = {}}: ComponentOptions = {}) {
        const internal = Component.#constructionContext;

        Component.#constructionContext = undefined;

        if (internal) {
            const factory = internal.definition.data;

            data = factory ? factory() : {};
            methods = internal.definition.methods ?? {};

            internal.propNames.forEach(name => {
                if (Object.hasOwn(data, name)) {
                    throw new Error(`The "${name}" prop collides with a data key of this component`);
                }
            });

            this.#propsBacking = {...internal.propSeeds};

            this.#definition = internal.definition;
            this.#parentEventTarget = internal.parentEventTarget;
            this.#initialAncestorChain = internal.ancestorChain;
        }

        const boundMethods: Record<string, ComponentMethod> = Object.assign({}, methods);
        Object.keys(boundMethods).forEach(key => {
            boundMethods[key] = boundMethods[key].bind(this);
        });
        Object.freeze(boundMethods);

        Object.defineProperties(this, {
            componentName: {
                enumerable: true,
                value: componentName || element.dataset['component'] || 'root',
            },
            data: {
                enumerable: true,
                value: this.#createGhost(data),
            },
            element: {
                enumerable: true,
                value: element,
            },
            methods: {
                enumerable: true,
                value: boundMethods,
            },
        });

        const events: ComponentEvents = {
            emit: (name, payload) => {
                if (name === RESERVED_EVENT_NAME) {
                    console.error(`The "${RESERVED_EVENT_NAME}" event name is reserved for the framework`, this.element);

                    return;
                }

                this.#eventTarget.dispatchEvent(new CustomEvent(name, {detail: payload}));
            },
            on: (name, handler) => {
                this.#eventTarget.addEventListener(name, handler as EventListener, {signal: this.#abortController.signal});
            },
            onParent: (name, handler) => {
                if (!this.#parentEventTarget) {
                    console.error('events.onParent: this component has no parent', this.element);

                    return;
                }

                this.#parentEventTarget.addEventListener(name, handler as EventListener, {signal: this.#abortController.signal});
            },
        };

        Object.freeze(events);
        Object.defineProperty(this, 'events', {enumerable: true, value: events});

        const propsView: Record<string, unknown> = {};

        (internal ? internal.propNames : []).forEach(name => {
            Object.defineProperty(propsView, name, {
                enumerable: true,
                get: () => this.#propsBacking[name],
            });
        });
        Object.preventExtensions(propsView);
        Object.defineProperty(this, 'props', {enumerable: true, value: propsView});

        Object.defineProperty(this, 'refs', {enumerable: true, value: this.#refsBacking});

        element.dataset['component'] = this.componentName;
        Object.defineProperty(this, 'ready', {
            enumerable: true,
            value: this.#loadComponent({parentComponentNameList: this.#initialAncestorChain})
                .then(() => {
                    this.#runMounted();
                }),
        });
        // Default handler: keeps mount failures visible for users who never
        // touch `ready`, and prevents unhandled-rejection noise; deliberate
        // destruction is not an error worth logging
        this.ready.catch((error: unknown) => {
            if (!(error instanceof Error && error.message === COMPONENT_DESTROYED_MESSAGE)) {
                console.error(error);
            }
        });
    }

    destroy(): void {
        if (this.#destroyed) {
            return;
        }

        this.#destroyed = true;
        this.#childComponents.forEach(child => child.destroy());
        this.#childComponents.clear();

        if (this.#cleanup) {
            try {
                this.#cleanup();
            } catch (error) {
                console.error(`The "${this.componentName}" component's cleanup threw`, error);
            }

            this.#cleanup = undefined;
        }

        this.#abortController.abort();
        this.#showIfElementToDataMap.clear();
        this.#displayIfElementToDataMap.clear();
        this.#valueElementToDataMap.clear();
        this.#textNodeToDataMap.clear();
        this.#forBlocks.clear();
        this.#propBindings.clear();
        Object.keys(this.#refsBacking).forEach(key => delete this.#refsBacking[key]);
    }

    #runMounted(): void {
        if (this.#destroyed || !this.#definition?.mounted) {
            return;
        }

        try {
            const result = this.#definition.mounted.call(this);

            if (typeof result === 'function') {
                this.#cleanup = result;
            }
        } catch (error) {
            console.error(`The "${this.componentName}" component's mounted() hook threw`, error);
        }
    }

    #wireTextInterpolations(root: Node, scopeRef?: ForBlockScopeRef): Text[] {
        const boundTextNodes: Text[] = [];

        collectTextNodes(root).forEach(textNode => {
            const text = textNode.textContent ?? '';

            if (!text.includes('${')) {
                return;
            }

            if (textNode.parentElement?.closest('[data-value]')) {
                console.error('Interpolation inside a data-value element is not supported (data-value overwrites its content)', textNode.parentElement);

                return;
            }

            let parts: TextPart[];

            try {
                parts = splitInterpolations(text);
            } catch (error) {
                console.error('Unmatched ${ in template text', textNode, error);

                return;
            }

            if (!parts.some(part => part.isExpression)) {
                // Escapes only: rewrite the literal text once, no binding
                textNode.textContent = parts.map(part => part.value).join('');

                return;
            }

            const replacements = parts.map(part => {
                const node = document.createTextNode(part.isExpression ? '' : part.value);

                if (part.isExpression) {
                    this.#textNodeToDataMap.set(node, {expression: part.value, scopeRef});
                    boundTextNodes.push(node);
                }

                return node;
            });

            textNode.replaceWith(...replacements);
        });

        return boundTextNodes;
    }

    #createGhost(data: Record<string, unknown>): Record<string, unknown> {
        const ghost: Record<string, unknown> = {};
        const app = this;

        Object.keys(data).forEach(key => {
            if (data[key] !== null && typeof data[key] === 'object' && !Array.isArray(data[key])) {
                const nestedGhost = this.#createGhost(data[key] as Record<string, unknown>);

                Object.defineProperty(ghost, key, {
                    enumerable: true,
                    get() {
                        return nestedGhost;
                    },
                    // Objects stay replace-only, but the array idiom's escape
                    // hatch works here too: self-assignment (data.user =
                    // data.user) triggers a pass after in-place mutation
                    set(newValue: unknown) {
                        if (newValue !== nestedGhost) {
                            throw new TypeError(`The "${key}" object cannot be replaced wholesale — mutate its keys, then assign it to itself to update`);
                        }

                        app.#runUpdatePass();
                    },
                });
            } else {
                Object.defineProperty(ghost, key, {
                    enumerable: true,
                    get() {
                        return data[key];
                    },
                    set(newValue: unknown) {
                        const isNewValueFromInputElement = newValue instanceof HTMLInputElement
                            || newValue instanceof HTMLTextAreaElement
                            || newValue instanceof HTMLSelectElement;

                        if (isNewValueFromInputElement) {
                            data[key] = newValue.value;
                        } else {
                            data[key] = newValue;
                        }

                        if (isNewValueFromInputElement) {
                            app.#runUpdatePass(newValue);
                        } else {
                            app.#runUpdatePass();
                        }
                    },
                });
            }
        });

        Object.preventExtensions(ghost);

        return ghost;
    }

    #evaluate({expression = null, element = null, scope}: {expression?: string | null; element?: HTMLElement | null; scope?: Record<string, unknown>}): unknown {
        let evaluatingCode = '';

        Object.keys(this.data).forEach(key => {
            evaluatingCode += `var ${key} = this.data['${key}'];`;
        });

        Object.keys(this.props).forEach(key => {
            evaluatingCode += `var ${key} = this.props['${key}'];`;
        });

        if (scope) {
            // Declared after the data keys so scope names shadow them; reached
            // through this.#evaluationScope because `this` is a keyword and
            // private names are visible in direct eval — no data key can
            // shadow or name this channel
            Object.keys(scope).forEach(key => {
                evaluatingCode += `var ${key} = this.#evaluationScope['${key}'];`;
            });
        }

        if (expression) {
            evaluatingCode += expression;
        } else if (element) {
            const entry = this.#valueElementToDataMap.get(element)!;

            // Rooted at this.data so the assignment hits the ghost setter, and
            // the input delivered via this.#evaluationElement — a data key named
            // `element` would shadow the parameter inside the eval scope
            evaluatingCode += `this.data.${entry.expression} = this.#evaluationElement;`;
        }

        // Save/restore rather than clear: stack discipline so nested
        // per-component scopes can evaluate within an outer pass
        const previousScope = this.#evaluationScope;
        const previousElement = this.#evaluationElement;

        this.#evaluationScope = scope;
        this.#evaluationElement = element ?? undefined;

        try {
            return eval(evaluatingCode);
        } finally {
            this.#evaluationScope = previousScope;
            this.#evaluationElement = previousElement;
        }
    }

    #extractForBlock(element: HTMLElement, parentComponentNameList: string[]): void {
        if (element.dataset['showIf'] !== undefined || element.dataset['component'] !== undefined) {
            console.error('data-for cannot be combined with data-show-if or data-component on the same element', element);
            element.remove();

            return;
        }

        const keyExpression = element.dataset['key'];

        if (keyExpression === undefined) {
            console.error('data-for requires a data-key attribute', element);
            element.remove();

            return;
        }

        if (element.querySelector('[data-for]') !== null) {
            console.error('data-for blocks cannot contain nested data-for elements', element);
            element.remove();

            return;
        }

        const anchorStart = document.createComment(' data-for start ');
        const anchorEnd = document.createComment(' data-for end ');
        const listExpression = element.dataset['for']!;

        element.replaceWith(anchorStart, anchorEnd);
        element.removeAttribute('data-for');
        element.removeAttribute('data-key');

        this.#forBlocks.add({
            anchorStart,
            anchorEnd,
            templateElement: element,
            listExpression,
            keyExpression,
            array: [],
            entries: new Map(),
            reportedErrorKinds: new Set(),
            ancestorChain: parentComponentNameList,
            generation: 0,
        });
    }

    #wireItemElement(root: HTMLElement, block: ForBlock, key: string): (HTMLElement | Text)[] {
        const boundElements: (HTMLElement | Text)[] = [];
        const scopeRef: ForBlockScopeRef = {block, key};

        this.#wireTextInterpolations(root, scopeRef).forEach(textNode => {
            boundElements.push(textNode);
        });

        [root, ...root.querySelectorAll<HTMLElement>('[data-value]')].forEach(element => {
            if (element.dataset['value'] === undefined) {
                return;
            }

            if (!formControlTagNames.has(element.tagName)) {
                console.error(DATA_VALUE_FORM_ONLY_MESSAGE, element);

                return;
            }

            console.error('A form-control data-value (input/textarea/select) inside a data-for block is not supported', element);
        });

        [root, ...root.querySelectorAll<HTMLElement>('[data-ref]')].forEach(element => {
            if (element.dataset['ref'] !== undefined) {
                console.error('data-ref inside a data-for block is not supported in v1', element);
            }
        });

        root.querySelectorAll<HTMLElement>('[data-show-if]').forEach(element => {
            this.#showIfElementToDataMap.set(element, {
                anchor: document.createComment(' an anchor comment '),
                expression: element.dataset['showIf']!,
                isHidden: false,
                scopeRef,
            });
            boundElements.push(element);
        });

        // Unlike data-show-if, data-display-if is allowed on the clone root:
        // it toggles style.display, so there is no anchor conflict
        [root, ...root.querySelectorAll<HTMLElement>('[data-display-if]')].forEach(element => {
            if (element.dataset['displayIf'] === undefined) {
                return;
            }

            this.#displayIfElementToDataMap.set(element, {
                expression: element.dataset['displayIf']!,
                originalDisplay: element.style.display,
                scopeRef,
            });
            boundElements.push(element);
        });

        [root, ...root.querySelectorAll<HTMLElement>(elementsWithDataOnAttributeSelector)].forEach(element => {
            Array.from(element.attributes)
                .filter(attribute => dataOnAttributeNameRegExp.exec(attribute.name))
                .forEach(attribute => {
                    const eventName = dataOnAttributeNameRegExp.exec(attribute.name)![1];
                    const methodName = attribute.value;

                    element.addEventListener(eventName, (event) => {
                        const entry = block.entries.get(key);

                        this.#handleEvent({methodName, event, item: entry?.item, index: entry?.index});
                    }, {signal: this.#abortController.signal});
                });
        });

        [root, ...root.querySelectorAll<HTMLElement>('[data-component]')].forEach(element => {
            if (element.dataset['component'] === undefined) {
                return;
            }

            if (formControlTagNames.has(element.tagName)) {
                console.error('data-component cannot be placed on a form control', element);

                return;
            }

            const componentName = element.dataset['component']!;
            const entryAtWiring = block.entries.get(key);

            Component.#loadDefinition(componentName).then(definition => {
                // Liveness gate: same entry object still present, parent alive
                if (this.#destroyed || block.entries.get(key) !== entryAtWiring) {
                    return;
                }

                if (definition === null) {
                    console.error(`A template-only include ("${componentName}") inside a data-for block is not supported — give it a <script> to make it a component`, element);

                    return;
                }

                const itemScope = this.#scopeForBinding(scopeRef);
                const {seeds, names, bindings, failedSeedKinds} = this.#collectProps(element, itemScope);
                const child = Component.#instantiate({
                    element,
                    componentName,
                    definition,
                    parent: this,
                    ancestorChain: [...block.ancestorChain],
                    propSeeds: seeds,
                    propNames: names,
                    entryRef: scopeRef,
                });

                entryAtWiring!.child = child;

                if (bindings.length) {
                    // failedSeedKinds carries the seed errors already logged in
                    // #collectProps — a fresh Set here would double-log a
                    // persisting seed error on the first update pass
                    this.#propBindings.set(child, {bindings, scopeRef, reportedErrorKinds: failedSeedKinds});
                }
            }).catch(error => {
                console.error(`Can't load the "${componentName}" component`, element, error);
            });
        });

        return boundElements;
    }

    #scopeForBinding(scopeRef: ForBlockScopeRef | undefined): Record<string, unknown> | undefined {
        if (!scopeRef) {
            return undefined;
        }

        const entry = scopeRef.block.entries.get(scopeRef.key);

        if (!entry) {
            return undefined;
        }

        return {$item: entry.item, $index: entry.index, $array: scopeRef.block.array};
    }

    // Runtime list errors log once while they persist and re-arm after a
    // clean pass — reconciliation runs per keystroke, so a persistent error
    // must not drown the console
    #reportBlockError(block: ForBlock, errorKindsThisPass: Set<string>, kind: string, ...details: unknown[]): void {
        errorKindsThisPass.add(kind);

        if (block.reportedErrorKinds.has(kind)) {
            return;
        }

        block.reportedErrorKinds.add(kind);
        console.error(...details);
    }

    #updateLists(): void {
        this.#forBlocks.forEach(block => {
            const errorKindsThisPass = new Set<string>();
            let items: unknown;
            let listFailed = false;

            try {
                items = this.#evaluate({expression: block.listExpression});
            } catch (error) {
                this.#reportBlockError(block, errorKindsThisPass, 'list-expression', `Can't evaluate the "${block.listExpression}" expression`, block.anchorStart, error);
                listFailed = true;
            }

            if (!listFailed) {
                if (!Array.isArray(items)) {
                    this.#reportBlockError(block, errorKindsThisPass, 'non-array', `The "${block.listExpression}" expression did not produce an array`, block.anchorStart, items);
                    items = [];
                }

                this.#reconcileBlock(block, items as unknown[], errorKindsThisPass);
            }

            block.reportedErrorKinds.forEach(kind => {
                if (!errorKindsThisPass.has(kind)) {
                    block.reportedErrorKinds.delete(kind);
                }
            });
        });
    }

    #reconcileBlock(block: ForBlock, items: unknown[], errorKindsThisPass: Set<string>): void {
        // A newer (re-entrant) pass bumps the generation; a pass that detects
        // it was superseded abandons the block
        const generation = ++block.generation;

        block.array = items;

        const desired: ForBlockEntry[] = [];
        const seenKeys = new Set<string>();

        items.forEach((item, index) => {
            let key: string;

            try {
                key = String(this.#evaluate({
                    expression: block.keyExpression,
                    scope: {$item: item, $index: index, $array: items},
                }));
            } catch (error) {
                this.#reportBlockError(block, errorKindsThisPass, 'key-expression', `Can't evaluate the "${block.keyExpression}" key expression`, block.anchorStart, error);

                return;
            }

            if (seenKeys.has(key)) {
                this.#reportBlockError(block, errorKindsThisPass, `duplicate-key:${key}`, `Duplicate data-key "${key}" in list`, block.anchorStart);

                return;
            }

            seenKeys.add(key);

            let entry = block.entries.get(key);

            if (entry) {
                entry.item = item;
                entry.index = index;
            } else {
                const element = block.templateElement.cloneNode(true) as HTMLElement;

                entry = {element, item, index, key, boundElements: []};
                block.entries.set(key, entry);
                entry.boundElements = this.#wireItemElement(element, block, key);
            }

            desired.push(entry);
        });

        // Sweep a SNAPSHOT: entries a re-entrant pass adds mid-sweep belong
        // to newer data, not to this pass's stale seenKeys — they must be
        // invisible here
        for (const [key, entry] of [...block.entries]) {
            if (seenKeys.has(key)) {
                continue;
            }

            if (block.entries.get(key) !== entry) {
                // Already evicted by a re-entrant pass
                continue;
            }

            entry.boundElements.forEach(boundElement => {
                if (boundElement instanceof Text) {
                    this.#textNodeToDataMap.delete(boundElement);

                    return;
                }

                this.#valueElementToDataMap.delete(boundElement);
                this.#showIfElementToDataMap.delete(boundElement);
                this.#displayIfElementToDataMap.delete(boundElement);
            });

            if (entry.child) {
                this.#propBindings.delete(entry.child);
                this.#childComponents.delete(entry.child);
                // destroy() before entries.delete: a cleanup's final emit still
                // resolves (event, item, index) through the live entry
                entry.child.destroy();
            }

            if (block.entries.get(key) === entry) {
                // Still ours — a re-entrant pass may have evicted it already,
                // or even re-added a FRESH entry under this key (never clobber that)
                entry.element.remove();
                block.entries.delete(key);
            }

            if (block.generation !== generation) {
                // destroy() ran a cleanup whose emit triggered a re-entrant
                // pass over this block — it reconciled NEWER data; anything
                // this pass would still do is stale by definition. Abandon.
                return;
            }
        }

        if (block.generation !== generation) {
            return;
        }

        const parent = block.anchorEnd.parentNode!;
        let cursor: ChildNode = block.anchorStart.nextSibling!;

        desired.forEach(entry => {
            if (block.entries.get(entry.key) !== entry) {
                // Evicted by a re-entrant pass mid-sweep (e.g. a cleanup's
                // final emit mutated the list) — do not resurrect
                return;
            }

            if (entry.element === cursor) {
                cursor = cursor.nextSibling!;
            } else {
                parent.insertBefore(entry.element, cursor);
            }
        });
    }

    #handleEvent({methodName, event, item, index}: {methodName: string; event: Event; item?: unknown; index?: number}): void {
        if (this.methods.hasOwnProperty(methodName)) {
            this.methods[methodName](event, item, index);
        }
    }

    #hideElement(element: HTMLElement): void {
        const entry = this.#showIfElementToDataMap.get(element)!;

        if (!entry.isHidden) {
            element.replaceWith(entry.anchor);
            entry.isHidden = true;
        }
    }

    static #instantiate({element, componentName, definition, parent, ancestorChain, propSeeds, propNames, entryRef}: {
        element: HTMLElement;
        componentName: string;
        definition: ComponentDefinition;
        parent: Component;
        ancestorChain: string[];
        propSeeds: Record<string, unknown>;
        propNames: string[];
        entryRef?: ForBlockScopeRef;
    }): Component {
        Component.#constructionContext = {definition, parentEventTarget: parent.#eventTarget, ancestorChain, propSeeds, propNames};

        try {
            const child = new Component({element, componentName});

            parent.#childComponents.add(child);
            parent.#wireComponentEvents(element, child, entryRef);

            return child;
        } finally {
            Component.#constructionContext = undefined;
        }
    }

    #wireComponentEvents(element: HTMLElement, child: Component, entryRef?: ForBlockScopeRef): void {
        Array.from(element.attributes).forEach(attribute => {
            const match = /^data-component-on-(.+)$/.exec(attribute.name);

            if (!match) {
                return;
            }

            const eventName = match[1];
            const methodName = attribute.value;

            if (eventName === RESERVED_EVENT_NAME) {
                console.error('data-component-on-props is not supported — the parent caused those re-seeds', element);

                return;
            }

            // Chained to BOTH lifetimes; the child's own signal fires inside
            // destroy() AFTER the cleanup phase — final-emit guarantee
            const wiring = new AbortController();
            const chain = (signal: AbortSignal) => {
                if (signal.aborted) {
                    wiring.abort();
                } else {
                    signal.addEventListener('abort', () => wiring.abort(), {once: true});
                }
            };

            chain(this.#abortController.signal);
            chain(child.#abortController.signal);

            child.#eventTarget.addEventListener(eventName, event => {
                const entry = entryRef ? entryRef.block.entries.get(entryRef.key) : undefined;

                this.#handleEvent({methodName, event, item: entry?.item, index: entry?.index});
            }, {signal: wiring.signal});
        });
    }

    #loadComponent({componentWrapper = this.element, componentName = this.componentName, parentComponentNameList = []}: LoadComponentOptions = {}): Promise<void> {
        if (parentComponentNameList.indexOf(componentName) >= 0) {
            return Promise.reject('A component cycle was detected during loading');
        }

        parentComponentNameList = [componentName, ...parentComponentNameList];

        return Component.loadTemplate(componentName)
            .then(template => this.#renderTemplate({template, parentComponentNameList}))
            .then(({documentFragment, childFailure}) => {
                if (this.#destroyed) {
                    throw new Error(COMPONENT_DESTROYED_MESSAGE);
                }

                // childNodes, not children: anchor comments for initially
                // hidden top-level elements must move into the live DOM too
                while (documentFragment.childNodes.length) {
                    componentWrapper.appendChild(documentFragment.childNodes[0]);
                }

                if (childFailure) {
                    // Mount what succeeded first, then surface the first child
                    // failure through ready — a broken child is loud, but its
                    // siblings still render (the framework's loud-but-non-fatal
                    // posture)
                    return Promise.reject(childFailure.reason);
                }

                return undefined;
            });
    }

    #renderTemplate({template, parentComponentNameList}: {template: string; parentComponentNameList: string[]}): Promise<{documentFragment: DocumentFragment; childFailure: PromiseRejectedResult | undefined}> {
        const divElement = document.createElement('div');

        divElement.innerHTML = template;

        const templateElement = divElement.firstChild;

        if (!(templateElement instanceof HTMLTemplateElement)) {
            return Promise.reject('A component template file must have a <template> element as its first child');
        }

        const documentFragment = templateElement.content;

        documentFragment.querySelectorAll<HTMLElement>('[data-for]').forEach(element => {
            if (!documentFragment.contains(element)) {
                // An ancestor data-for errored and was removed with its subtree
                return;
            }

            this.#extractForBlock(element, parentComponentNameList);
        });

        // After extraction, so block subtrees are wired per clone instead
        this.#wireTextInterpolations(documentFragment);

        documentFragment.querySelectorAll<HTMLElement>('[data-show-if]').forEach(element => {
            this.#showIfElementToDataMap.set(element, {
                anchor: document.createComment(' an anchor comment '),
                expression: element.dataset['showIf']!,
                isHidden: false,
            });
        });

        documentFragment.querySelectorAll<HTMLElement>('[data-display-if]').forEach(element => {
            this.#displayIfElementToDataMap.set(element, {
                expression: element.dataset['displayIf']!,
                originalDisplay: element.style.display,
            });
        });

        documentFragment.querySelectorAll<HTMLElement>('[data-ref]').forEach(element => {
            const name = element.dataset['ref']!;

            if (Object.hasOwn(this.#refsBacking, name)) {
                console.error(`Duplicate data-ref "${name}" — first wins`, element);

                return;
            }

            this.#refsBacking[name] = element;
        });

        documentFragment.querySelectorAll<HTMLElement>('[data-value]').forEach(element => {
            if (!formControlTagNames.has(element.tagName)) {
                console.error(DATA_VALUE_FORM_ONLY_MESSAGE, element);

                return;
            }

            if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
                console.error('data-value does not support checkbox/radio inputs — their state is `checked`, not `value`', element);

                return;
            }

            const rootIdentifier = /^([A-Za-z_$][\w$]*)/.exec(element.dataset['value']!)?.[1];

            if (rootIdentifier && Object.hasOwn(this.props, rootIdentifier)) {
                console.error(`data-value cannot bind the "${rootIdentifier}" prop — props are inputs; copy into data to edit`, element);

                return;
            }

            this.#valueElementToDataMap.set(element, {
                expression: element.dataset['value']!,
            });

            element.addEventListener(element.tagName === 'SELECT' ? 'change' : 'input', () => {
                this.#evaluate({element});
            }, {signal: this.#abortController.signal});
        });

        documentFragment.querySelectorAll<HTMLElement>(elementsWithDataOnAttributeSelector).forEach(element => {
            Array.from(element.attributes)
                .filter(attribute => dataOnAttributeNameRegExp.exec(attribute.name))
                .forEach(attribute => {
                    const eventName = dataOnAttributeNameRegExp.exec(attribute.name)![1];
                    const methodName = attribute.value;

                    element.addEventListener(eventName, (event) => {
                        this.#handleEvent({methodName, event});
                    }, {signal: this.#abortController.signal});
                });
        });

        const subComponentPromiseList = Array.from(documentFragment.querySelectorAll<HTMLElement>('[data-component]')).map(element => {
            if (formControlTagNames.has(element.tagName)) {
                console.error('data-component cannot be placed on a form control', element);

                return Promise.resolve();
            }

            return this.#mountChildOrInclude(element, parentComponentNameList);
        });

        // allSettled, not all: a broken child must not abort the mount of its
        // siblings — the first failure is carried out so #loadComponent can
        // append the fragment before rejecting ready with it
        return Promise.allSettled(subComponentPromiseList)
            .then(results => {
                this.#runUpdatePass();

                return {
                    documentFragment,
                    childFailure: results.find((result): result is PromiseRejectedResult => result.status === 'rejected'),
                };
            });
    }

    #collectProps(element: HTMLElement, scope?: Record<string, unknown>): {seeds: Record<string, unknown>; names: string[]; bindings: PropBinding[]; failedSeedKinds: Set<string>} {
        const seeds: Record<string, unknown> = {};
        const names: string[] = [];
        const bindings: PropBinding[] = [];
        const failedSeedKinds = new Set<string>();

        Object.keys(element.dataset).forEach(datasetKey => {
            if (!datasetKey.startsWith('componentProp')) {
                return;
            }

            const tail = datasetKey.slice('componentProp'.length);

            if (!tail || !/^[A-Z]/.test(tail)) {
                console.error(`Malformed component prop attribute (expected data-component-prop-<name>)`, element);

                return;
            }

            const propName = tail[0].toLowerCase() + tail.slice(1);

            if (!isValidPropName(propName)) {
                console.error(`"${propName}" is not a usable prop name (reserved or invalid identifier) — prop skipped`, element);

                return;
            }

            const expression = element.dataset[datasetKey]!;
            let value: unknown;

            try {
                value = this.#evaluate({expression, scope});
            } catch (error) {
                console.error(`Can't evaluate the "${expression}" prop expression`, element, error);
                value = undefined;
                // Pre-arms the once-while-broken cadence: the seed log IS the
                // "logged once" for this kind — the first update pass must not
                // repeat it while the same expression still throws
                failedSeedKinds.add(`prop:${propName}`);
            }

            seeds[propName] = value;
            names.push(propName);
            bindings.push({propName, expression, lastSeeded: value});
        });

        return {seeds, names, bindings, failedSeedKinds};
    }

    #mountChildOrInclude(element: HTMLElement, parentComponentNameList: string[]): Promise<void> {
        const componentName = element.dataset['component']!;

        return Component.#loadDefinition(componentName).then(definition => {
            if (this.#destroyed) {
                throw new Error(COMPONENT_DESTROYED_MESSAGE);
            }

            if (definition === null) {
                Array.from(element.attributes).forEach(attribute => {
                    if (/^data-component-(on|prop)-/.test(attribute.name)) {
                        console.error(`"${attribute.name}" has no effect on a template-only include`, element);
                    }
                });

                return this.#loadComponent({componentWrapper: element, componentName, parentComponentNameList});
            }

            const {seeds, names, bindings, failedSeedKinds} = this.#collectProps(element);
            const child = Component.#instantiate({
                element,
                componentName,
                definition,
                parent: this,
                ancestorChain: parentComponentNameList,
                propSeeds: seeds,
                propNames: names,
            });

            if (bindings.length) {
                this.#propBindings.set(child, {bindings, reportedErrorKinds: failedSeedKinds});
            }

            return child.ready;
        });
    }

    #showElement(element: HTMLElement): void {
        const entry = this.#showIfElementToDataMap.get(element)!;

        if (entry.isHidden) {
            entry.anchor.replaceWith(element);
            entry.isHidden = false;
        }
    }

    #runUpdatePass(sourceElement: HTMLElement | null = null): void {
        if (this.#destroyed) {
            return;
        }

        this.#updateLists();
        this.#updateVisibility();
        this.#updateValues(sourceElement);
        this.#updateProps();
    }

    #updateProps(): void {
        this.#propBindings.forEach((record, child) => {
            if (child.#destroyed) {
                return;
            }

            const errorKindsThisPass = new Set<string>();
            const scope = this.#scopeForBinding(record.scopeRef);
            const changes: Record<string, {value: unknown; previous: unknown}> = {};
            let changed = false;

            record.bindings.forEach(binding => {
                let value: unknown;

                try {
                    value = this.#evaluate({expression: binding.expression, scope});
                } catch (error) {
                    const kind = `prop:${binding.propName}`;

                    errorKindsThisPass.add(kind);

                    if (!record.reportedErrorKinds.has(kind)) {
                        record.reportedErrorKinds.add(kind);
                        console.error(`Can't evaluate the "${binding.expression}" prop expression`, child.element, error);
                    }

                    return;
                }

                if (!Object.is(value, binding.lastSeeded)) {
                    changes[binding.propName] = {value, previous: binding.lastSeeded};
                    binding.lastSeeded = value;
                    child.#propsBacking[binding.propName] = value;
                    changed = true;
                }
            });

            record.reportedErrorKinds.forEach(kind => {
                if (!errorKindsThisPass.has(kind)) {
                    record.reportedErrorKinds.delete(kind);
                }
            });

            if (changed) {
                // Browsers report a listener exception without breaking the
                // dispatch; non-browser EventTargets may propagate it — either
                // way the batch contract (ONE event, then ONE child pass, and
                // phase 4 continuing for the remaining children) must survive
                try {
                    child.#eventTarget.dispatchEvent(new CustomEvent(RESERVED_EVENT_NAME, {detail: changes}));
                } catch (error) {
                    console.error(`A "${RESERVED_EVENT_NAME}" event handler threw`, child.element, error);
                }

                child.#runUpdatePass();
            }
        });
    }

    #updateValues(element: HTMLElement | null = null): void {
        this.#valueElementToDataMap.forEach((entry, valueElement) => {
            if (valueElement !== element) {
                let newValue: unknown;

                try {
                    newValue = this.#evaluate({expression: entry.expression, scope: this.#scopeForBinding(entry.scopeRef)});
                } catch (error) {
                    console.error(`Can't evaluate the "${entry.expression}" expression`, valueElement, error);

                    return;
                }

                (valueElement as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value = newValue as string;
            }
        });

        this.#textNodeToDataMap.forEach((entry, textNode) => {
            let newValue: unknown;

            try {
                newValue = this.#evaluate({expression: entry.expression, scope: this.#scopeForBinding(entry.scopeRef)});
            } catch (error) {
                console.error(`Can't evaluate the "${entry.expression}" expression`, textNode, error);

                return;
            }

            textNode.textContent = newValue === null || newValue === undefined ? '' : String(newValue);
        });
    }

    #updateVisibility(): void {
        this.#showIfElementToDataMap.forEach((entry, element) => {
            let shouldBeVisible: boolean;

            try {
                shouldBeVisible = !!this.#evaluate({expression: entry.expression, scope: this.#scopeForBinding(entry.scopeRef)});
            } catch (error) {
                console.error(`Can't evaluate the "${entry.expression}" expression`, element, error);

                return;
            }

            if (shouldBeVisible) {
                this.#showElement(element);
            } else {
                this.#hideElement(element);
            }
        });

        this.#displayIfElementToDataMap.forEach((entry, element) => {
            let shouldBeVisible: boolean;

            try {
                shouldBeVisible = !!this.#evaluate({expression: entry.expression, scope: this.#scopeForBinding(entry.scopeRef)});
            } catch (error) {
                console.error(`Can't evaluate the "${entry.expression}" expression`, element, error);

                return;
            }

            element.style.display = shouldBeVisible ? entry.originalDisplay : 'none';
        });
    }

    static clearTemplateCache(): void {
        Component.#templateNameToTemplatePromiseMap.clear();
        Component.#definitionPromiseMap.clear();
    }

    static loadTemplate(templateName: string): Promise<string> {
        let loadTemplatePromise: Promise<string>;

        if (Component.#templateNameToTemplatePromiseMap.has(templateName)) {
            loadTemplatePromise = Component.#templateNameToTemplatePromiseMap.get(templateName)!;
        } else {
            loadTemplatePromise = fetch(`/templates/${templateName}.html`)
                .then(response => {
                    if (!response.ok) {
                        return Promise.reject(new Error(`HTTP ${response.status} for ${templateName}`));
                    }

                    return response.text();
                })
                .catch(error => {
                    Component.#templateNameToTemplatePromiseMap.delete(templateName);

                    return Promise.reject(error);
                });

            Component.#templateNameToTemplatePromiseMap.set(templateName, loadTemplatePromise);
        }

        return loadTemplatePromise;
    }

    static #loadDefinition(componentName: string): Promise<ComponentDefinition | null> {
        let promise = Component.#definitionPromiseMap.get(componentName);

        if (!promise) {
            promise = Component.loadTemplate(componentName)
                .then(text => Component.#parseDefinition(componentName, text))
                .catch(error => {
                    Component.#definitionPromiseMap.delete(componentName);

                    return Promise.reject(error);
                });

            Component.#definitionPromiseMap.set(componentName, promise);
        }

        return promise;
    }

    static async #parseDefinition(componentName: string, templateText: string): Promise<ComponentDefinition | null> {
        const divElement = document.createElement('div');

        divElement.innerHTML = templateText;

        const templateElement = divElement.firstChild;

        if (!(templateElement instanceof HTMLTemplateElement)) {
            throw new Error('A component template file must have a <template> element as its first child');
        }

        const meaningfulSiblings: ChildNode[] = [];

        for (let node = templateElement.nextSibling; node; node = node.nextSibling) {
            const ignorable = (node.nodeType === Node.TEXT_NODE && !(node.textContent ?? '').trim())
                || node.nodeType === Node.COMMENT_NODE;

            if (!ignorable) {
                meaningfulSiblings.push(node);
            }
        }

        const scriptElement = meaningfulSiblings.find(node => node instanceof HTMLScriptElement) as HTMLScriptElement | undefined;

        if (!scriptElement) {
            // Template-only: legacy include, stray content tolerated as today
            return null;
        }

        if (meaningfulSiblings.length > 1) {
            throw new Error(`The "${componentName}" component file must contain only <template> and <script>`);
        }

        const moduleUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(scriptElement.textContent ?? '');
        const module = await import(/* @vite-ignore */ moduleUrl);
        const definition = module.default as ComponentDefinition;

        if (definition === null || typeof definition !== 'object') {
            throw new Error(`The "${componentName}" component script must export default a definition object`);
        }

        if (definition.data !== undefined && typeof definition.data !== 'function') {
            throw new Error(`The "${componentName}" definition's data must be a factory — data: () => ({...}) — so instances never share state`);
        }

        if (definition.methods !== undefined && (definition.methods === null || typeof definition.methods !== 'object')) {
            throw new Error(`The "${componentName}" definition's methods must be an object`);
        }

        if (definition.mounted !== undefined && typeof definition.mounted !== 'function') {
            throw new Error(`The "${componentName}" definition's mounted must be a function`);
        }

        Object.keys(definition).forEach(key => {
            if (!DEFINITION_KEYS.has(key)) {
                console.warn(`Unknown key "${key}" in the "${componentName}" component definition`);
            }
        });

        if (definition.methods) {
            Object.freeze(definition.methods);
        }

        return Object.freeze(definition);
    }
}
