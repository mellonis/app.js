class App {
    constructor({element, componentName = null, data = {}, methods = {}}) {
        Object.defineProperty(this, 'showIfElementsToDataMap', {
            enumerable: true,
            value: new Map(),
        });
        Object.defineProperty(this, 'valueElementsToDataMap', {
            enumerable: true,
            value: new Map(),
        });
        Object.defineProperty(this, 'componentName', {
            enumerable: true,
            value: componentName || element.dataset['component'],
        });
        Object.defineProperty(this, 'element', {
            enumerable: true,
            value: element,
        });

        if (!this.componentName) {
            throw new Error();
        }

        Object.defineProperty(this, 'data', {
            enumerable: true,
            value: this.createGhost(data),
        });

        methods = Object.assign({}, methods);
        Object.keys(methods).forEach(methodName => {
            methods[methodName] = methods[methodName].bind(this);
        });
        Object.freeze(methods);

        Object.defineProperty(this, 'methods', {
            enumerable: true,
            value: methods,
        });

        this.loadComponent()
            .catch(console.error);
    }

    checkValues(element = null) {
        Array.from(this.valueElementsToDataMap).forEach(([valueElement, data]) => {
             if (valueElement !== element) {
                 const newValue = this.evaluate({expression: data.expression});

                 if (valueElement.tagName === 'INPUT') {
                     valueElement.value = newValue;
                 } else {
                     valueElement.textContent = newValue;
                 }
             }
        });
    }

    checkVisibility() {
        Array.from(this.showIfElementsToDataMap).forEach(([element, data]) => {
            const shouldBeVisible = !!this.evaluate({expression: data.expression});

            if (shouldBeVisible) {
                this.showElement(element);
            } else {
                this.hideElement(element);
            }
        });
    }

    createGhost(data) {
        const ghost = {};
        const app = this;

        Object.keys(data).forEach(key => {
            if (typeof data[key] === 'object') {
                Object.defineProperty(ghost, key, {
                    enumerable: true,
                    value: this.createGhost(data[key], true),
                });
            } else {
                Object.defineProperty(ghost, key, {
                    enumerable: true,
                    get() {
                        return data[key];
                    },
                    set(newValue) {
                        const isNewValueFromInputElement = newValue instanceof HTMLInputElement;

                        if (isNewValueFromInputElement) {
                            data[key] = newValue.value;
                        } else {
                            data[key] = newValue;
                        }

                        app.checkVisibility();

                        if (isNewValueFromInputElement) {
                            app.checkValues(newValue)
                        } else {
                            app.checkValues();
                        }
                    }
                });
            }
        });

        Object.preventExtensions(ghost);

        return ghost;
    }

    evaluate({expression = null, element = null}) {
        let evaluatingCode = '';

        Object.keys(this.data).forEach(key => {
            evaluatingCode += `var ${key} = this.data['${key}'];`;
        });

        if (expression) {
            evaluatingCode += expression;
        } else if (element) {
            const data = this.valueElementsToDataMap.get(element);

            evaluatingCode += `${data.expression} = element;`;
        }

        return eval(evaluatingCode);
    }

    handleEvent({methodName, event}) {
        if (this.methods.hasOwnProperty(methodName)) {
            this.methods[methodName].apply(this, [event, this.data]);
        }
    }

    hideElement(element) {
        const data = this.showIfElementsToDataMap.get(element);

        if (!data.isHidden) {
            element.replaceWith(data.anchor);
            data.isHidden = true;
        }
    }

    loadComponent({componentWrapper = this.element, componentName = this.componentName} = {}) {
        return App.loadTemplate(componentName)
            .then(template => this.renderTemplate({template}))
            .then(documentFragment => {
                while (documentFragment.children.length) {
                    componentWrapper.appendChild(documentFragment.children[0])
                }
            })
            .catch((error) => {
                console.error(error);

                return Promise.reject('Can\'t get a component');
            });
    }

    renderTemplate({template}) {
        const divElement = document.createElement('div');

        divElement.innerHTML = template;

        const documentFragment = divElement.firstChild.content;

        Array.from(documentFragment.querySelectorAll('[data-show-if]')).forEach(element => {
            this.showIfElementsToDataMap.set(element, {
                anchor: document.createComment(' an anchor comment '),
                expression: element.dataset['showIf'],
                isHidden: false,
            });
        });

        Array.from(documentFragment.querySelectorAll('[data-value]')).forEach(element => {
            this.valueElementsToDataMap.set(element, {
                expression: element.dataset['value'],
            });

            if (element.tagName === 'INPUT') {
                element.addEventListener('input', () => {
                    this.evaluate({element});
                })
            }
        });

        const eventNameList = ['submit', 'click'];
        const elementsWithDataOnAttributesSelector = eventNameList.map(eventName => `[data-on-${eventName}]`).join(',');
        const dataOnAttributeNameRegExp = new RegExp(`^data-on-(${eventNameList.join('|')})`);

        Array.from(documentFragment.querySelectorAll(elementsWithDataOnAttributesSelector)).forEach(element => {
            Array.from(element.attributes)
                .filter(attribute => dataOnAttributeNameRegExp.exec(attribute.name))
                .forEach(attribute => {
                    const eventName = dataOnAttributeNameRegExp.exec(attribute.name)[1];
                    const methodName = attribute.value;

                    element.addEventListener(eventName, (event) => {
                        this.handleEvent({methodName, event});
                    });
                });
        });

        const subComponentsPromiseList = Array.from(documentFragment.querySelectorAll('[data-component]')).map(element => {
            return this.loadComponent({
                componentWrapper: element,
                componentName: element.dataset['component'],
            });
        });

        return Promise.all(subComponentsPromiseList)
            .then(() => {
                this.checkVisibility();
                this.checkValues();
            })
            .then(() => documentFragment)
            .catch(error => {
                console.error(error);

                return Promise.reject('Sub component error');
            });
    }

    showElement(element) {
        const data = this.showIfElementsToDataMap.get(element);

        if (data.isHidden) {
            data.anchor.replaceWith(element);
            data.isHidden = false;
        }
    }

    static loadTemplate(templateName) {
        let loadTemplatePromise;

        if (App.templateNameToTemplatePromiseMap.has(templateName)) {
            loadTemplatePromise = App.templateNameToTemplatePromiseMap.get(templateName);
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

    static get templateNameToTemplatePromiseMap() {
        App.__templateNameToTemplatePromiseMap = App.__templateNameToTemplatePromiseMap || new Map();

        return App.__templateNameToTemplatePromiseMap;
    }
}
