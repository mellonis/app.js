class App {
    constructor({element = document.body, componentName = 'root', data = {}, methods = {}} = {}) {
        methods = Object.assign({}, methods);
        Object.keys(methods).forEach(key => {
            methods[key] = methods[key].bind(this);
        });
        Object.freeze(methods);

        Object.defineProperties(this, {
            componentName: {
                enumerable: true,
                value: componentName || element.dataset['component'],
            },
            data: {
                enumerable: true,
                value: this.createGhost(data),
            },
            element: {
                enumerable: true,
                value: element,
            },
            methods: {
                enumerable: true,
                value: methods,
            },
            showIfElementToDataMap: {
                enumerable: true,
                value: new Map(),
            },
            valueElementToDataMap: {
                enumerable: true,
                value: new Map(),
            },
        });
        element.dataset['component'] = this.componentName;
        this.loadComponent()
            .catch(console.error);
    }

    createGhost(data) {
        const ghost = {};
        const app = this;

        Object.keys(data).forEach(key => {
            if (typeof data[key] === 'object') {
                Object.defineProperty(ghost, key, {
                    enumerable: true,
                    value: this.createGhost(data[key]),
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

                        app.updateVisibility();

                        if (isNewValueFromInputElement) {
                            app.updateValues(newValue);
                        } else {
                            app.updateValues();
                        }
                    },
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
            const data = this.valueElementToDataMap.get(element);

            evaluatingCode += `${data.expression} = element;`;
        }

        return eval(evaluatingCode);
    }

    handleEvent({methodName, event}) {
        if (this.methods.hasOwnProperty(methodName)) {
            this.methods[methodName].apply(null, [event]);
        }
    }

    hideElement(element) {
        const data = this.showIfElementToDataMap.get(element);

        if (!data.isHidden) {
            element.replaceWith(data.anchor);
            data.isHidden = true;
        }
    }

    loadComponent({componentWrapper = this.element, componentName = this.componentName, parentComponentNameList = []} = {}) {
        if (parentComponentNameList.indexOf(componentName) >= 0) {
            return Promise.reject('A component cycle was detected during loading');
        }

        parentComponentNameList.unshift(componentName);

        return App.loadTemplate(componentName)
            .then(template => this.renderTemplate({template, parentComponentNameList}))
            .then(documentFragment => {
                while (documentFragment.children.length) {
                    componentWrapper.appendChild(documentFragment.children[0]);
                }
            })
            .catch(error => {
                console.error(error);

                return Promise.reject('Can\'t get a component');
            })
    }

    renderTemplate({template, parentComponentNameList}) {
        const divElement = document.createElement('div');

        divElement.innerHTML = template;

        const documentFragment = divElement.firstChild.content;

        documentFragment.querySelectorAll('[data-show-if]').forEach(element => {
            this.showIfElementToDataMap.set(element, {
                anchor: document.createComment(' an anchor comment '),
                expression: element.dataset['showIf'],
                isHidden: false,
            });
        });

        documentFragment.querySelectorAll('[data-value]').forEach(element => {
            this.valueElementToDataMap.set(element, {
                expression: element.dataset['value'],
            });

            if (element.tagName === 'INPUT') {
                element.addEventListener('input', () => {
                    this.evaluate({element});
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
                        this.handleEvent({methodName, event});
                    });
                });
        });

        const subComponentPromiseList = Array.from(documentFragment.querySelectorAll('[data-component]')).map(element => {
            return this.loadComponent({
                componentWrapper: element,
                componentName: element.dataset['component'],
                parentComponentNameList,
            });
        });

        return Promise.all(subComponentPromiseList)
            .then(() => {
                this.updateVisibility();
                this.updateValues();
            })
            .then(() => documentFragment)
            .catch(error => {
                console.error(error);

                return Promise.reject('Sub component error');
            });
    }

    showElement(element) {
        const data = this.showIfElementToDataMap.get(element);

        if (data.isHidden) {
            data.anchor.replaceWith(element);
            data.isHidden = false;
        }
    }

    updateValues(element = null) {
        this.valueElementToDataMap.forEach((data, valueElement) => {
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

    updateVisibility() {
        this.showIfElementToDataMap.forEach((data, element) => {
            const shouldBeVisible = !!this.evaluate({expression: data.expression});

            if (shouldBeVisible) {
                this.showElement(element);
            } else {
                this.hideElement(element);
            }
        });
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