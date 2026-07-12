type AppMethod = (event: Event) => void;

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
}

interface ValueEntry {
    expression: string;
}

interface LoadComponentOptions {
    componentWrapper?: HTMLElement;
    componentName?: string;
    parentComponentNameList?: string[];
}

export default class App {
    declare readonly componentName: string;
    declare readonly data: Record<string, unknown>;
    declare readonly element: HTMLElement;
    declare readonly methods: Readonly<Record<string, AppMethod>>;

    readonly #showIfElementToDataMap = new Map<HTMLElement, ShowIfEntry>();
    readonly #valueElementToDataMap = new Map<HTMLElement, ValueEntry>();

    static readonly templateNameToTemplatePromiseMap = new Map<string, Promise<string>>();

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
        this.#loadComponent()
            .catch(console.error);
    }

    #createGhost(data: Record<string, unknown>): Record<string, unknown> {
        const ghost: Record<string, unknown> = {};
        const app = this;

        Object.keys(data).forEach(key => {
            if (data[key] !== null && typeof data[key] === 'object') {
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

                        app.#updateVisibility();

                        if (isNewValueFromInputElement) {
                            app.#updateValues(newValue);
                        } else {
                            app.#updateValues();
                        }
                    },
                });
            }
        });

        Object.preventExtensions(ghost);

        return ghost;
    }

    #evaluate({expression = null, element = null}: {expression?: string | null; element?: HTMLElement | null}): unknown {
        let evaluatingCode = '';

        Object.keys(this.data).forEach(key => {
            evaluatingCode += `var ${key} = this.data['${key}'];`;
        });

        if (expression) {
            evaluatingCode += expression;
        } else if (element) {
            const entry = this.#valueElementToDataMap.get(element)!;

            // Known bug: for a bare top-level key this assigns the eval-local
            // var, not the ghost — issue #2
            evaluatingCode += `${entry.expression} = element;`;
        }

        return eval(evaluatingCode);
    }

    #handleEvent({methodName, event}: {methodName: string; event: Event}): void {
        if (this.methods.hasOwnProperty(methodName)) {
            this.methods[methodName].apply(null, [event]);
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
                // Appends element children only: an anchor comment for an
                // initially hidden top-level element stays behind — issue #8
                while (documentFragment.children.length) {
                    componentWrapper.appendChild(documentFragment.children[0]);
                }
            })
            .catch(error => {
                console.error(error);

                return Promise.reject('Can\'t get a component');
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

        const eventNameList = ['click', 'submit'];
        const elementsWithDataOnAttributeSelector = eventNameList.map(eventName => `[data-on-${eventName}]`).join(',');
        const dataOnAttributeNameRegExp = new RegExp(`^data-on-(${eventNameList.join('|')})$`);

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
                this.#updateVisibility();
                this.#updateValues();
            })
            .then(() => documentFragment)
            .catch(error => {
                console.error(error);

                return Promise.reject('Sub component error');
            });
    }

    #showElement(element: HTMLElement): void {
        const entry = this.#showIfElementToDataMap.get(element)!;

        if (entry.isHidden) {
            entry.anchor.replaceWith(element);
            entry.isHidden = false;
        }
    }

    #updateValues(element: HTMLElement | null = null): void {
        this.#valueElementToDataMap.forEach((entry, valueElement) => {
            if (valueElement !== element) {
                let newValue: unknown;

                try {
                    newValue = this.#evaluate({expression: entry.expression});
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
                shouldBeVisible = !!this.#evaluate({expression: entry.expression});
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

    static loadTemplate(templateName: string): Promise<string> {
        let loadTemplatePromise: Promise<string>;

        if (App.templateNameToTemplatePromiseMap.has(templateName)) {
            loadTemplatePromise = App.templateNameToTemplatePromiseMap.get(templateName)!;
        } else {
            loadTemplatePromise = fetch(`/templates/${templateName}.html`)
                .then(response => response.text())
                .catch(error => {
                    App.templateNameToTemplatePromiseMap.delete(templateName);
                    console.log(error);

                    return Promise.reject();
                });

            App.templateNameToTemplatePromiseMap.set(templateName, loadTemplatePromise);
        }

        return loadTemplatePromise;
    }
}
