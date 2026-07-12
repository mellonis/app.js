type AppMethod = (event: Event, item?: unknown, index?: number) => void;

interface AppOptions {
    element?: HTMLElement;
    componentName?: string | null;
    data?: Record<string, unknown>;
    methods?: Record<string, AppMethod>;
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

interface ForBlockScopeRef {
    block: ForBlock;
    key: string;
}

interface ForBlockEntry {
    element: HTMLElement;
    item: unknown;
    index: number;
    boundElements: HTMLElement[];
}

interface ForBlock {
    anchorStart: Comment;
    anchorEnd: Comment;
    templateElement: HTMLElement;
    listExpression: string;
    keyExpression: string;
    array: unknown[];
    entries: Map<string, ForBlockEntry>;
    reportedDuplicateKeys: Set<string>;
}

interface LoadComponentOptions {
    componentWrapper?: HTMLElement;
    componentName?: string;
    parentComponentNameList?: string[];
}

const eventNameList = ['click', 'submit'];
const elementsWithDataOnAttributeSelector = eventNameList.map(eventName => `[data-on-${eventName}]`).join(',');
const dataOnAttributeNameRegExp = new RegExp(`^data-on-(${eventNameList.join('|')})$`);

export default class App {
    declare readonly componentName: string;
    declare readonly data: Record<string, unknown>;
    declare readonly element: HTMLElement;
    declare readonly methods: Readonly<Record<string, AppMethod>>;
    declare readonly ready: Promise<void>;

    readonly #showIfElementToDataMap = new Map<HTMLElement, ShowIfEntry>();
    readonly #valueElementToDataMap = new Map<HTMLElement, ValueEntry>();
    readonly #forBlocks = new Set<ForBlock>();

    #evaluationScope: Record<string, unknown> | undefined;

    static readonly #templateNameToTemplatePromiseMap = new Map<string, Promise<string>>();

    constructor({element = document.body, componentName = 'root', data = {}, methods = {}}: AppOptions = {}) {
        const boundMethods: Record<string, AppMethod> = Object.assign({}, methods);
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
        // touch `ready`, and prevents unhandled-rejection noise
        this.ready.catch(console.error);
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
                        const isNewValueFromInputElement = newValue instanceof HTMLInputElement;

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

            // Rooted at this.data so the assignment hits the ghost setter;
            // a bare `expression = element` would assign the eval-local var
            evaluatingCode += `this.data.${entry.expression} = element;`;
        }

        this.#evaluationScope = scope;

        try {
            return eval(evaluatingCode);
        } finally {
            this.#evaluationScope = undefined;
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
            reportedDuplicateKeys: new Set(),
        });
    }

    #wireItemElement(root: HTMLElement, block: ForBlock, key: string): HTMLElement[] {
        const boundElements: HTMLElement[] = [];
        const scopeRef: ForBlockScopeRef = {block, key};

        [root, ...root.querySelectorAll<HTMLElement>('[data-value]')].forEach(element => {
            if (element.dataset['value'] === undefined) {
                return;
            }

            if (element.tagName === 'INPUT') {
                console.error('An <input data-value> inside a data-for block is not supported', element);

                return;
            }

            this.#valueElementToDataMap.set(element, {expression: element.dataset['value']!, scopeRef});
            boundElements.push(element);
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

        [root, ...root.querySelectorAll<HTMLElement>(elementsWithDataOnAttributeSelector)].forEach(element => {
            Array.from(element.attributes)
                .filter(attribute => dataOnAttributeNameRegExp.exec(attribute.name))
                .forEach(attribute => {
                    const eventName = dataOnAttributeNameRegExp.exec(attribute.name)![1];
                    const methodName = attribute.value;

                    element.addEventListener(eventName, (event) => {
                        const entry = block.entries.get(key);

                        this.#handleEvent({methodName, event, item: entry?.item, index: entry?.index});
                    });
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

    #updateLists(): void {
        this.#forBlocks.forEach(block => {
            let items: unknown;

            try {
                items = this.#evaluate({expression: block.listExpression});
            } catch (error) {
                console.error(`Can't evaluate the "${block.listExpression}" expression`, block.anchorStart, error);

                return;
            }

            if (!Array.isArray(items)) {
                console.error(`The "${block.listExpression}" expression did not produce an array`, block.anchorStart, items);
                items = [];
            }

            this.#reconcileBlock(block, items as unknown[]);
        });
    }

    #reconcileBlock(block: ForBlock, items: unknown[]): void {
        block.array = items;

        const desired: ForBlockEntry[] = [];
        const seenKeys = new Set<string>();
        const duplicateKeysThisPass = new Set<string>();

        items.forEach((item, index) => {
            let key: string;

            try {
                key = String(this.#evaluate({
                    expression: block.keyExpression,
                    scope: {$item: item, $index: index, $array: items},
                }));
            } catch (error) {
                console.error(`Can't evaluate the "${block.keyExpression}" key expression`, block.anchorStart, error);

                return;
            }

            if (seenKeys.has(key)) {
                duplicateKeysThisPass.add(key);

                if (!block.reportedDuplicateKeys.has(key)) {
                    console.error(`Duplicate data-key "${key}" in list`, block.anchorStart);
                    block.reportedDuplicateKeys.add(key);
                }

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

        block.reportedDuplicateKeys.forEach(key => {
            if (!duplicateKeysThisPass.has(key)) {
                block.reportedDuplicateKeys.delete(key);
            }
        });

        block.entries.forEach((entry, key) => {
            if (!seenKeys.has(key)) {
                entry.boundElements.forEach(boundElement => {
                    this.#valueElementToDataMap.delete(boundElement);
                    this.#showIfElementToDataMap.delete(boundElement);
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
            this.methods[methodName].apply(null, [event, item, index]);
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

        return App.loadTemplate(componentName)
            .then(template => this.#renderTemplate({template, parentComponentNameList}))
            .then(documentFragment => {
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

        documentFragment.querySelectorAll<HTMLElement>('[data-show-if]').forEach(element => {
            this.#showIfElementToDataMap.set(element, {
                anchor: document.createComment(' an anchor comment '),
                expression: element.dataset['showIf']!,
                isHidden: false,
            });
        });

        documentFragment.querySelectorAll<HTMLElement>('[data-value]').forEach(element => {
            this.#valueElementToDataMap.set(element, {
                expression: element.dataset['value']!,
            });

            if (element.tagName === 'INPUT') {
                element.addEventListener('input', () => {
                    this.#evaluate({element});
                });
            }
        });

        documentFragment.querySelectorAll<HTMLElement>(elementsWithDataOnAttributeSelector).forEach(element => {
            Array.from(element.attributes)
                .filter(attribute => dataOnAttributeNameRegExp.exec(attribute.name))
                .forEach(attribute => {
                    const eventName = dataOnAttributeNameRegExp.exec(attribute.name)![1];
                    const methodName = attribute.value;

                    element.addEventListener(eventName, (event) => {
                        this.#handleEvent({methodName, event});
                    });
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

                if (valueElement.tagName === 'INPUT') {
                    (valueElement as HTMLInputElement).value = newValue as string;
                } else {
                    valueElement.textContent = newValue as string;
                }
            }
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
    }

    static clearTemplateCache(): void {
        App.#templateNameToTemplatePromiseMap.clear();
    }

    static loadTemplate(templateName: string): Promise<string> {
        let loadTemplatePromise: Promise<string>;

        if (App.#templateNameToTemplatePromiseMap.has(templateName)) {
            loadTemplatePromise = App.#templateNameToTemplatePromiseMap.get(templateName)!;
        } else {
            loadTemplatePromise = fetch(`/templates/${templateName}.html`)
                .then(response => {
                    if (!response.ok) {
                        return Promise.reject(new Error(`HTTP ${response.status} for ${templateName}`));
                    }

                    return response.text();
                })
                .catch(error => {
                    App.#templateNameToTemplatePromiseMap.delete(templateName);

                    return Promise.reject(error);
                });

            App.#templateNameToTemplatePromiseMap.set(templateName, loadTemplatePromise);
        }

        return loadTemplatePromise;
    }
}
