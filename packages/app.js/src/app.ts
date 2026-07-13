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
    boundElements: (HTMLElement | Text)[];
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
}

interface LoadComponentOptions {
    componentWrapper?: HTMLElement;
    componentName?: string;
    parentComponentNameList?: string[];
}

const COMPONENT_DESTROYED_MESSAGE = 'The component was destroyed';

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

    readonly #showIfElementToDataMap = new Map<HTMLElement, ShowIfEntry>();
    readonly #displayIfElementToDataMap = new Map<HTMLElement, DisplayIfEntry>();
    readonly #valueElementToDataMap = new Map<HTMLElement, ValueEntry>();
    readonly #textNodeToDataMap = new Map<Text, TextNodeEntry>();
    readonly #forBlocks = new Set<ForBlock>();

    #evaluationScope: Record<string, unknown> | undefined;
    #evaluationElement: HTMLElement | undefined;

    readonly #abortController = new AbortController();
    #destroyed = false;

    static readonly #templateNameToTemplatePromiseMap = new Map<string, Promise<string>>();

    constructor({element = document.body, componentName = 'root', data = {}, methods = {}}: ComponentOptions = {}) {
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
        element.dataset['component'] = this.componentName;
        Object.defineProperty(this, 'ready', {
            enumerable: true,
            value: this.#loadComponent(),
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
        this.#abortController.abort();
        this.#showIfElementToDataMap.clear();
        this.#displayIfElementToDataMap.clear();
        this.#valueElementToDataMap.clear();
        this.#textNodeToDataMap.clear();
        this.#forBlocks.clear();
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
                Object.defineProperty(ghost, key, {
                    enumerable: true,
                    value: this.#createGhost(data[key] as Record<string, unknown>),
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

        // Save/restore rather than clear: stack discipline for the day
        // nested scopes (per-component, #7) evaluate within an outer pass
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

    #extractForBlock(element: HTMLElement): void {
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

        if (element.querySelector('[data-for], [data-component]') !== null) {
            console.error('data-for blocks cannot contain nested data-for or data-component elements', element);
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

                entry = {element, item, index, boundElements: []};
                block.entries.set(key, entry);
                entry.boundElements = this.#wireItemElement(element, block, key);
            }

            desired.push(entry);
        });

        block.entries.forEach((entry, key) => {
            if (!seenKeys.has(key)) {
                entry.boundElements.forEach(boundElement => {
                    if (boundElement instanceof Text) {
                        this.#textNodeToDataMap.delete(boundElement);

                        return;
                    }

                    this.#valueElementToDataMap.delete(boundElement);
                    this.#showIfElementToDataMap.delete(boundElement);
                    this.#displayIfElementToDataMap.delete(boundElement);
                });
                entry.element.remove();
                block.entries.delete(key);
            }
        });

        const parent = block.anchorEnd.parentNode!;
        let cursor: ChildNode = block.anchorStart.nextSibling!;

        desired.forEach(entry => {
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

    #loadComponent({componentWrapper = this.element, componentName = this.componentName, parentComponentNameList = []}: LoadComponentOptions = {}): Promise<void> {
        if (parentComponentNameList.indexOf(componentName) >= 0) {
            return Promise.reject('A component cycle was detected during loading');
        }

        parentComponentNameList = [componentName, ...parentComponentNameList];

        return Component.loadTemplate(componentName)
            .then(template => this.#renderTemplate({template, parentComponentNameList}))
            .then(documentFragment => {
                if (this.#destroyed) {
                    throw new Error(COMPONENT_DESTROYED_MESSAGE);
                }

                // childNodes, not children: anchor comments for initially
                // hidden top-level elements must move into the live DOM too
                while (documentFragment.childNodes.length) {
                    componentWrapper.appendChild(documentFragment.childNodes[0]);
                }
            });
    }

    #renderTemplate({template, parentComponentNameList}: {template: string; parentComponentNameList: string[]}): Promise<DocumentFragment> {
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

            this.#extractForBlock(element);
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

        documentFragment.querySelectorAll<HTMLElement>('[data-value]').forEach(element => {
            if (!formControlTagNames.has(element.tagName)) {
                console.error(DATA_VALUE_FORM_ONLY_MESSAGE, element);

                return;
            }

            if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
                console.error('data-value does not support checkbox/radio inputs — their state is `checked`, not `value`', element);

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
            return this.#loadComponent({
                componentWrapper: element,
                componentName: element.dataset['component'],
                parentComponentNameList,
            });
        });

        return Promise.all(subComponentPromiseList)
            .then(() => {
                this.#runUpdatePass();
            })
            .then(() => documentFragment);
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
}
