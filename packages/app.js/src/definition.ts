// How a component file becomes a definition, and the type-level state that
// caching it implies. Everything here is static in the original sense: keyed
// by component NAME, shared by every instance of that name, and outliving all
// of them. No instance state is reachable from this module, and it never
// imports the engine — not even as a type.
//
// Three caches live here, cleared together by clearCaches(): the raw template
// text per name, the parsed definition per name, and the one injected <style>
// element per name.
import { DEFINITION_KEYS, isMeaningfulNode } from './support.js';
import type { ComponentDefinition } from './support.js';

const templateNameToTemplatePromiseMap = new Map<string, Promise<string>>();

const definitionPromiseMap = new Map<string, Promise<ComponentDefinition | null>>();

// One injected <style> per component TYPE, keyed by name like the
// template and definition caches — and cleared with them
const componentNameToStyleElementMap = new Map<string, HTMLStyleElement>();

// Type-level style injection: the first instance of a component whose
// file carries a <style> puts ONE element into document.head; later
// instances find it in the registry and inject nothing. destroy() never
// removes it — it is type-level state, like the caches. The leading
// `:scope ` step in the limit selector is load-bearing: without it, a
// wrapper sitting as a DIRECT CHILD of another stamped element would
// match the scope-end and become its own limit (a scoping root counts
// among its own descendants for scope-end matching), leaving that scope
// empty. The `> *` bound keeps the nested wrapper element itself
// styleable by the parent that wrote it, while the wrapper's subtree
// falls out of scope.
export function injectComponentStyle(componentName: string, css: string): void {
    if (componentNameToStyleElementMap.has(componentName)) {
        return;
    }

    const escapedComponentName = componentName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const styleElement = document.createElement('style');

    styleElement.dataset['componentStyle'] = componentName;
    styleElement.textContent = `@scope ([data-component="${escapedComponentName}"]) to (:scope [data-component-root] > *) {${css}}`;
    document.head.appendChild(styleElement);
    componentNameToStyleElementMap.set(componentName, styleElement);
}

export function clearCaches(): void {
    templateNameToTemplatePromiseMap.clear();
    definitionPromiseMap.clear();
    componentNameToStyleElementMap.forEach(styleElement => styleElement.remove());
    componentNameToStyleElementMap.clear();
}

export function loadTemplate(templateName: string): Promise<string> {
    let loadTemplatePromise: Promise<string>;

    if (templateNameToTemplatePromiseMap.has(templateName)) {
        loadTemplatePromise = templateNameToTemplatePromiseMap.get(templateName)!;
    } else {
        loadTemplatePromise = fetch(`/templates/${templateName}.html`)
            .then(response => {
                if (!response.ok) {
                    return Promise.reject(new Error(`HTTP ${response.status} for ${templateName}`));
                }

                return response.text();
            })
            .catch(error => {
                templateNameToTemplatePromiseMap.delete(templateName);

                return Promise.reject(error);
            });

        templateNameToTemplatePromiseMap.set(templateName, loadTemplatePromise);
    }

    return loadTemplatePromise;
}

export function loadDefinition(componentName: string): Promise<ComponentDefinition | null> {
    let promise = definitionPromiseMap.get(componentName);

    if (!promise) {
        promise = loadTemplate(componentName)
            .then(text => parseDefinition(componentName, text))
            .catch(error => {
                definitionPromiseMap.delete(componentName);

                return Promise.reject(error);
            });

        definitionPromiseMap.set(componentName, promise);
    }

    return promise;
}

async function parseDefinition(componentName: string, templateText: string): Promise<ComponentDefinition | null> {
    const divElement = document.createElement('div');

    divElement.innerHTML = templateText;

    const templateElement = divElement.firstChild;

    if (!(templateElement instanceof HTMLTemplateElement)) {
        throw new Error('A component template file must have a <template> element as its first child');
    }

    const meaningfulSiblings: ChildNode[] = [];

    for (let node = templateElement.nextSibling; node; node = node.nextSibling) {
        if (isMeaningfulNode(node)) {
            meaningfulSiblings.push(node);
        }
    }

    const scriptElements = meaningfulSiblings.filter(node => node instanceof HTMLScriptElement);
    const styleElements = meaningfulSiblings.filter(node => node instanceof HTMLStyleElement);

    // Checked before the template-only return: a style in a scriptless
    // file must not degrade into a silently unstyled include
    if (styleElements.length && !scriptElements.length) {
        throw new Error(`The "${componentName}" template-only include cannot carry a <style> — an include has no scope of its own; give it a <script> to make it a component`);
    }

    const scriptElement = scriptElements[0];

    if (!scriptElement) {
        // Template-only: legacy include, stray content tolerated as today
        return null;
    }

    if (scriptElements.length > 1 || styleElements.length > 1 || meaningfulSiblings.length !== scriptElements.length + styleElements.length) {
        throw new Error(`The "${componentName}" component file must contain only <template>, <script>, and <style>`);
    }

    const styleText = styleElements[0]?.textContent ?? '';
    // Whitespace-only style text is absent CSS, not an empty injection
    const css = styleText.trim() ? styleText : undefined;

    const moduleUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(scriptElement.textContent ?? '');
    const module = await import(/* @vite-ignore */ moduleUrl);
    const exported = module.default as ComponentDefinition;

    if (exported === null || typeof exported !== 'object') {
        throw new Error(`The "${componentName}" component script must export default a definition object`);
    }

    // The module cache is keyed by URL and identical script text makes
    // an identical data: URL, so two component files can share ONE
    // exported object. The cached definition carries per-component
    // state (css) and gets frozen, so each component freezes its own
    // shallow copy, never the shared export
    const definition: ComponentDefinition = {...exported};

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

    // Styles come from the file's <style>, never the script — a
    // script-supplied css value was already flagged by the unknown-key
    // sweep above and must not survive into injection
    delete definition.css;

    if (css !== undefined) {
        definition.css = css;
    }

    if (definition.methods) {
        Object.freeze(definition.methods);
    }

    return Object.freeze(definition);
}
