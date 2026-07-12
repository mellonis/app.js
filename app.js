var _a;
class App {
    #showIfElementToDataMap = new Map();
    #valueElementToDataMap = new Map();
    static templateNameToTemplatePromiseMap = new Map();
    constructor({ element = document.body, componentName = 'root', data = {}, methods = {} } = {}) {
        const boundMethods = Object.assign({}, methods);
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
    #createGhost(data) {
        const ghost = {};
        const app = this;
        Object.keys(data).forEach(key => {
            if (data[key] !== null && typeof data[key] === 'object') {
                Object.defineProperty(ghost, key, {
                    enumerable: true,
                    value: this.#createGhost(data[key]),
                });
            }
            else {
                Object.defineProperty(ghost, key, {
                    enumerable: true,
                    get() {
                        return data[key];
                    },
                    set(newValue) {
                        const isNewValueFromInputElement = newValue instanceof HTMLInputElement;
                        if (isNewValueFromInputElement) {
                            data[key] = newValue.value;
                        }
                        else {
                            data[key] = newValue;
                        }
                        app.#updateVisibility();
                        if (isNewValueFromInputElement) {
                            app.#updateValues(newValue);
                        }
                        else {
                            app.#updateValues();
                        }
                    },
                });
            }
        });
        Object.preventExtensions(ghost);
        return ghost;
    }
    #evaluate({ expression = null, element = null }) {
        let evaluatingCode = '';
        Object.keys(this.data).forEach(key => {
            evaluatingCode += `var ${key} = this.data['${key}'];`;
        });
        if (expression) {
            evaluatingCode += expression;
        }
        else if (element) {
            const entry = this.#valueElementToDataMap.get(element);
            // Known bug: for a bare top-level key this assigns the eval-local
            // var, not the ghost — issue #2
            evaluatingCode += `${entry.expression} = element;`;
        }
        return eval(evaluatingCode);
    }
    #handleEvent({ methodName, event }) {
        if (this.methods.hasOwnProperty(methodName)) {
            this.methods[methodName].apply(null, [event]);
        }
    }
    #hideElement(element) {
        const entry = this.#showIfElementToDataMap.get(element);
        if (!entry.isHidden) {
            element.replaceWith(entry.anchor);
            entry.isHidden = true;
        }
    }
    #loadComponent({ componentWrapper = this.element, componentName = this.componentName, parentComponentNameList = [] } = {}) {
        if (parentComponentNameList.indexOf(componentName) >= 0) {
            return Promise.reject('A component cycle was detected during loading');
        }
        parentComponentNameList = [componentName, ...parentComponentNameList];
        return _a.loadTemplate(componentName)
            .then(template => this.#renderTemplate({ template, parentComponentNameList }))
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
    #renderTemplate({ template, parentComponentNameList }) {
        const divElement = document.createElement('div');
        divElement.innerHTML = template;
        const templateElement = divElement.firstChild;
        if (!(templateElement instanceof HTMLTemplateElement)) {
            return Promise.reject('A component template file must have a <template> element as its first child');
        }
        const documentFragment = templateElement.content;
        documentFragment.querySelectorAll('[data-show-if]').forEach(element => {
            this.#showIfElementToDataMap.set(element, {
                anchor: document.createComment(' an anchor comment '),
                expression: element.dataset['showIf'],
                isHidden: false,
            });
        });
        documentFragment.querySelectorAll('[data-value]').forEach(element => {
            this.#valueElementToDataMap.set(element, {
                expression: element.dataset['value'],
            });
            if (element.tagName === 'INPUT') {
                element.addEventListener('input', () => {
                    this.#evaluate({ element });
                });
            }
        });
        const eventNameList = ['click', 'submit'];
        const elementsWithDataOnAttributeSelector = eventNameList.map(eventName => `[data-on-${eventName}]`).join(',');
        const dataOnAttributeNameRegExp = new RegExp(`^data-on-(${eventNameList.join('|')})$`);
        documentFragment.querySelectorAll(elementsWithDataOnAttributeSelector).forEach(element => {
            Array.from(element.attributes)
                .filter(attribute => dataOnAttributeNameRegExp.exec(attribute.name))
                .forEach(attribute => {
                const eventName = dataOnAttributeNameRegExp.exec(attribute.name)[1];
                const methodName = attribute.value;
                element.addEventListener(eventName, (event) => {
                    this.#handleEvent({ methodName, event });
                });
            });
        });
        const subComponentPromiseList = Array.from(documentFragment.querySelectorAll('[data-component]')).map(element => {
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
    #showElement(element) {
        const entry = this.#showIfElementToDataMap.get(element);
        if (entry.isHidden) {
            entry.anchor.replaceWith(element);
            entry.isHidden = false;
        }
    }
    #updateValues(element = null) {
        this.#valueElementToDataMap.forEach((entry, valueElement) => {
            if (valueElement !== element) {
                // A throwing expression aborts the rest of this pass — issue #4
                const newValue = this.#evaluate({ expression: entry.expression });
                if (valueElement.tagName === 'INPUT') {
                    valueElement.value = newValue;
                }
                else {
                    valueElement.textContent = newValue;
                }
            }
        });
    }
    #updateVisibility() {
        this.#showIfElementToDataMap.forEach((entry, element) => {
            const shouldBeVisible = !!this.#evaluate({ expression: entry.expression });
            if (shouldBeVisible) {
                this.#showElement(element);
            }
            else {
                this.#hideElement(element);
            }
        });
    }
    static loadTemplate(templateName) {
        let loadTemplatePromise;
        if (_a.templateNameToTemplatePromiseMap.has(templateName)) {
            loadTemplatePromise = _a.templateNameToTemplatePromiseMap.get(templateName);
        }
        else {
            loadTemplatePromise = fetch(`/templates/${templateName}.html`)
                .then(response => response.text())
                .catch(error => {
                _a.templateNameToTemplatePromiseMap.delete(templateName);
                console.log(error);
                return Promise.reject();
            });
            _a.templateNameToTemplatePromiseMap.set(templateName, loadTemplatePromise);
        }
        return loadTemplatePromise;
    }
}
_a = App;
export default App;
