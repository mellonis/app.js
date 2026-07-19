import { compile, renderCaret, ExpressionParseError } from './expression.js';
import type { IdentifierResolver } from './expression.js';
import {
    collectTextNodes,
    COMPONENT_DESTROYED_MESSAGE,
    DATA_DISABLED_IF_MESSAGE,
    DATA_ON_ATTRIBUTE_NAME_PATTERN,
    DATA_VALUE_FORM_ONLY_MESSAGE,
    DEFAULT_SLOT_NAME,
    DEFINITION_KEYS,
    directiveAnchorComments,
    disableableTagNames,
    EXPRESSION_GLOBALS,
    formControlTagNames,
    isContentNode,
    isMeaningfulNode,
    isValidPropName,
    RESERVED_EVENT_NAME,
    slotHasForbiddenDirective,
    splitInterpolations,
    trackDirectiveAnchor,
    trackedInterpolationTextNodes,
} from './support.js';
import type {
    BoundComponentMethod,
    ComponentDefinition,
    ComponentEvents,
    ComponentMethod,
    ComponentOptions,
    DisabledIfEntry,
    DisplayIfEntry,
    ForBlock,
    ForBlockEntry,
    ForBlockScopeRef,
    InternalConstruction,
    LoadComponentOptions,
    PropBinding,
    PropBindingRecord,
    ShowIfEntry,
    SlotRecordEntry,
    TextNodeEntry,
    TextPart,
    TrackedBinding,
    ValueEntry,
} from './support.js';
import { clearCaches, injectComponentStyle, loadDefinition, loadTemplate as loadTemplateText } from './definition.js';

export type { ComponentMethod } from './support.js';

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
    readonly #disabledIfElementToDataMap = new Map<HTMLElement, DisabledIfEntry>();
    readonly #valueElementToDataMap = new Map<HTMLElement, ValueEntry>();
    readonly #textNodeToDataMap = new Map<Text, TextNodeEntry>();
    readonly #forBlocks = new Set<ForBlock>();

    readonly #subscribersByPath = new Map<string, Set<TrackedBinding>>();
    #dirtyBindings = new Set<TrackedBinding>();
    #activeFrame: Set<string> | null = null;
    #drainDepth = 0;

    #cleanup: (() => void) | undefined;
    readonly #refsBacking: Record<string, HTMLElement> = {};

    #pendingFlush: {promise: Promise<void>; resolve: () => void} | null = null;

    readonly #abortController = new AbortController();
    #destroyed = false;

    readonly #eventTarget = new EventTarget();
    #parentEventTarget: EventTarget | undefined;

    static #constructionContext: InternalConstruction | undefined;

    readonly #childComponents = new Set<Component>();
    #definition: ComponentDefinition | undefined;
    #initialAncestorChain: string[] = [];

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
                get: () => {
                    this.#record(`props:${name}`);

                    return this.#propsBacking[name];
                },
            });
        });
        Object.preventExtensions(propsView);
        Object.defineProperty(this, 'props', {enumerable: true, value: propsView});

        Object.defineProperty(this, 'refs', {enumerable: true, value: this.#refsBacking});

        element.dataset['component'] = this.componentName;
        // Boundary marker for injected component styles: every constructed
        // instance is stamped, so a scoped rule stops at nested component
        // wrappers. Template-only includes never construct and are never
        // boundaries. The root's own stamp can never act as one either —
        // the limit selector matches strict descendants of a scoping root
        // only, and the mount element is an ancestor of every scope.
        element.dataset['componentRoot'] = '';
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
        this.#disabledIfElementToDataMap.clear();
        this.#valueElementToDataMap.clear();
        this.#textNodeToDataMap.clear();
        this.#forBlocks.clear();
        this.#propBindings.clear();
        this.#subscribersByPath.clear();
        this.#dirtyBindings.clear();
        Object.keys(this.#refsBacking).forEach(key => delete this.#refsBacking[key]);

        // No deadlocked awaiters: a caller holding the promise from an
        // `updated()` issued before destroy() still gets it resolved
        const pending = this.#pendingFlush;

        this.#pendingFlush = null;
        pending?.resolve();
    }

    // Resolves once the currently pending flush's final drain iteration
    // completes; resolves immediately when idle (nothing pending) or after
    // destroy(). Covers this component's own drain only — a child's flush is
    // its own later microtask (see the `settle` test helper for the chain).
    updated(): Promise<void> {
        return this.#pendingFlush?.promise ?? Promise.resolve();
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

    // Pushes a fresh dependency frame, runs the evaluation, and always
    // resubscribes from the frame collected so far — even on a throw. Keeping
    // the OLD set on a throw would orphan any binding whose guard expression
    // is what's failing (it would never re-arm once the guard flips back).
    #trackEvaluation<T>(binding: TrackedBinding, evaluateFn: () => T): T {
        const previousFrame = this.#activeFrame;
        const frame = new Set<string>();

        this.#activeFrame = frame;

        try {
            return evaluateFn();
        } finally {
            this.#activeFrame = previousFrame;
            this.#resubscribe(binding, frame);
        }
    }

    #resubscribe(binding: TrackedBinding, next: Set<string>): void {
        binding.dependencies.forEach(path => {
            if (!next.has(path)) {
                this.#subscribersByPath.get(path)?.delete(binding);
            }
        });
        next.forEach(path => {
            if (!binding.dependencies.has(path)) {
                let set = this.#subscribersByPath.get(path);

                if (!set) {
                    set = new Set();
                    this.#subscribersByPath.set(path, set);
                }

                set.add(binding);
            }
        });
        binding.dependencies = next;
    }

    #record(path: string): void {
        this.#activeFrame?.add(path);
    }

    // A write to path notifies subscribers of the path itself plus every
    // registered path prefixed "path." (descendants) — never ancestors, since
    // identity above the written path did not change
    #notify(path: string): void {
        const direct = this.#subscribersByPath.get(path);

        direct?.forEach(binding => this.#dirtyBindings.add(binding));

        const prefix = `${path}.`;

        this.#subscribersByPath.forEach((subscribers, registered) => {
            if (registered.startsWith(prefix)) {
                subscribers.forEach(binding => this.#dirtyBindings.add(binding));
            }
        });

        if (this.#dirtyBindings.size) {
            this.#scheduleFlush();
        }
    }

    // Coalesces every write landing in the same microtask tick into one
    // flush: a write arriving while a flush is already pending returns early
    // instead of scheduling a second microtask — the drain's own dirty-set
    // loop absorbs it. The promise is minted at schedule time (not at drain
    // time) so a same-tick updated() call always returns the pending one.
    #scheduleFlush(): void {
        if (this.#pendingFlush) {
            return;
        }

        let resolve!: () => void;
        const promise = new Promise<void>(promiseResolve => {
            resolve = promiseResolve;
        });

        this.#pendingFlush = {promise, resolve};
        queueMicrotask(() => {
            const pending = this.#pendingFlush;

            try {
                this.#drain();
            } finally {
                // Clear BEFORE resolving so a write inside updated().then
                // mints a new flush instead of being folded into this one,
                // which has already finished draining — and an engine-level
                // throw inside drain must never wedge the instance or
                // deadlock an updated() awaiter
                this.#pendingFlush = null;
                pending?.resolve();
            }
        });
    }

    // A write landing DURING a drain (e.g. a props handler writing this.data)
    // must not recurse into a nested drain — it lands in the fresh dirty set
    // instead, and the while loop below picks it up on its next iteration
    #drain(): void {
        if (this.#destroyed || this.#drainDepth > 0) {
            return;
        }

        this.#drainDepth = 1;

        try {
            let iterations = 0;

            while (!this.#destroyed && this.#dirtyBindings.size) {
                iterations += 1;

                if (iterations > 64) {
                    console.error('Update feedback loop: a binding keeps dirtying itself (a formatter or handler writes what it reads) — rendering stopped for this batch', this.element);
                    this.#dirtyBindings.clear();

                    break;
                }

                const batch = this.#dirtyBindings;

                this.#dirtyBindings = new Set();

                // Lists first (structure before content), then visibility,
                // values, text, then prop re-seeds — the existing pass order,
                // now scoped to whichever bindings are actually dirty
                batch.forEach(binding => {
                    if (binding.kind === 'block') {
                        this.#reconcileTrackedBlock(binding.block);
                    }
                });
                batch.forEach(binding => {
                    if (binding.kind === 'show') {
                        this.#updateOneShowIf(binding.element);
                    }
                });
                batch.forEach(binding => {
                    if (binding.kind === 'display') {
                        this.#updateOneDisplayIf(binding.element);
                    }
                });
                batch.forEach(binding => {
                    if (binding.kind === 'disabled') {
                        this.#updateOneDisabledIf(binding.element);
                    }
                });
                batch.forEach(binding => {
                    if (binding.kind === 'value') {
                        this.#updateOneValue(binding.element);
                    }
                });
                batch.forEach(binding => {
                    if (binding.kind === 'text') {
                        this.#updateOneText(binding.node);
                    }
                });
                batch.forEach(binding => {
                    if (binding.kind === 'props') {
                        this.#reseedChild(binding.child);
                    }
                });
            }
        } finally {
            this.#drainDepth = 0;
        }
    }

    // Every binding kind's own map still holds the live entry for its
    // element/node — this is the one place that reaches across all of them.
    // An element can carry more than one directive (show-if AND display-if
    // together, say) — every match is returned, not just the first, so a
    // caller that dirties or evicts never silently drops one of them
    #bindingsFor(boundElement: HTMLElement | Text): TrackedBinding[] {
        if (boundElement instanceof Text) {
            const binding = this.#textNodeToDataMap.get(boundElement)?.binding;

            return binding ? [binding] : [];
        }

        return [
            this.#showIfElementToDataMap.get(boundElement)?.binding,
            this.#displayIfElementToDataMap.get(boundElement)?.binding,
            this.#disabledIfElementToDataMap.get(boundElement)?.binding,
            this.#valueElementToDataMap.get(boundElement)?.binding,
        ].filter((binding): binding is TrackedBinding => binding !== undefined);
    }

    // Unsubscribes an evicted binding from every path it was reading and
    // drops it from the current dirty set, so a dead binding never lingers
    // in the graph or gets evaluated against an element that is gone
    #evictBinding(binding: TrackedBinding): void {
        this.#resubscribe(binding, new Set());
        this.#dirtyBindings.delete(binding);
    }

    // The initial mount renders synchronously: mark every wired binding
    // dirty, then drain once — that first drain IS the collection pass
    #markAllBindingsDirty(): void {
        this.#forBlocks.forEach(block => this.#dirtyBindings.add(block.binding));
        this.#showIfElementToDataMap.forEach(entry => this.#dirtyBindings.add(entry.binding));
        this.#displayIfElementToDataMap.forEach(entry => this.#dirtyBindings.add(entry.binding));
        this.#disabledIfElementToDataMap.forEach(entry => this.#dirtyBindings.add(entry.binding));
        this.#valueElementToDataMap.forEach(entry => this.#dirtyBindings.add(entry.binding));
        this.#textNodeToDataMap.forEach(entry => this.#dirtyBindings.add(entry.binding));
        this.#propBindings.forEach(record => this.#dirtyBindings.add(record.binding));
    }

    #wireTextInterpolations(root: Node, scopeRef?: ForBlockScopeRef): Text[] {
        const boundTextNodes: Text[] = [];

        // Some parsers split a text run into sibling Text nodes around a bare
        // ">" (e.g. inside the |> pipe token); normalize() re-merges them so
        // an interpolation never straddles two nodes
        root.normalize();

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

                if (part.isExpression && this.#compileAtWiring(part.value, textNode)) {
                    this.#textNodeToDataMap.set(node, {
                        expression: part.value,
                        scopeRef,
                        binding: {kind: 'text', node, dependencies: new Set()},
                    });
                    trackedInterpolationTextNodes.add(node);
                    boundTextNodes.push(node);
                }

                return node;
            });

            textNode.replaceWith(...replacements);
        });

        return boundTextNodes;
    }

    #createGhost(data: Record<string, unknown>, prefix = ''): Record<string, unknown> {
        const ghost: Record<string, unknown> = {};
        const app = this;

        Object.keys(data).forEach(key => {
            const path = prefix ? `${prefix}.${key}` : key;

            if (data[key] !== null && typeof data[key] === 'object' && !Array.isArray(data[key])) {
                const nestedGhost = this.#createGhost(data[key] as Record<string, unknown>, path);

                Object.defineProperty(ghost, key, {
                    enumerable: true,
                    get() {
                        app.#record(path);

                        return nestedGhost;
                    },
                    // Objects stay replace-only, but the array idiom's escape
                    // hatch works here too: self-assignment (data.user =
                    // data.user) triggers a pass after in-place mutation —
                    // and, being an equal object reference, always notifies
                    set(newValue: unknown) {
                        if (newValue !== nestedGhost) {
                            throw new TypeError(`The "${key}" object cannot be replaced wholesale — mutate its keys, then assign it to itself to update`);
                        }

                        app.#notify(path);
                    },
                });
            } else {
                Object.defineProperty(ghost, key, {
                    enumerable: true,
                    get() {
                        app.#record(path);

                        return data[key];
                    },
                    set(newValue: unknown) {
                        const currentValue = data[key];
                        // Equal primitives (and double-null) are a no-op;
                        // equal array/object/function references still go
                        // through — they are the mutate-then-self-assign hatch
                        const suppress = Object.is(currentValue, newValue)
                            && (newValue === null || (typeof newValue !== 'object' && typeof newValue !== 'function'));

                        if (suppress) {
                            return;
                        }

                        data[key] = newValue;
                        app.#notify(path);
                    },
                });
            }
        });

        Object.preventExtensions(ghost);

        return ghost;
    }

    #resolverFor(scope?: Record<string, unknown>): IdentifierResolver {
        return name => {
            if (scope && Object.hasOwn(scope, name)) {
                return {found: true, value: scope[name]};
            }

            if (Object.hasOwn(this.props, name)) {
                return {found: true, value: (this.props as Record<string, unknown>)[name]};
            }

            if (Object.hasOwn(this.data, name)) {
                return {found: true, value: (this.data as Record<string, unknown>)[name]};
            }

            if (Object.hasOwn(this.methods, name)) {
                return {found: true, value: this.methods[name]};
            }

            if (EXPRESSION_GLOBALS.has(name)) {
                return {found: true, value: EXPRESSION_GLOBALS.get(name)};
            }

            return {found: false};
        };
    }

    // Write-back resolves ONLY through data, returning the root VALUE for
    // path walks; bare-root writes never reach this resolver — the listener
    // writes those through the ghost directly so its setter fires
    get #dataResolver(): IdentifierResolver {
        return name => Object.hasOwn(this.data, name)
            ? {found: true, value: (this.data as Record<string, unknown>)[name]}
            : {found: false};
    }

    #evaluate({expression, scope}: {expression: string; scope?: Record<string, unknown>}): unknown {
        return compile(expression).evaluate(this.#resolverFor(scope));
    }

    #compileAtWiring(expression: string, context: Node): boolean {
        try {
            compile(expression);

            return true;
        } catch (error) {
            if (error instanceof ExpressionParseError) {
                console.error(`Can't parse the "${expression}" expression:\n${renderCaret(error)}\n${error.message}`, context);

                return false;
            }

            throw error;
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

        const listExpression = element.dataset['for']!;
        const listExpressionCompiles = this.#compileAtWiring(listExpression, element);
        const keyExpressionCompiles = this.#compileAtWiring(keyExpression, element);

        if (!listExpressionCompiles || !keyExpressionCompiles) {
            element.remove();

            return;
        }

        const anchorStart = document.createComment(' data-for start ');
        const anchorEnd = document.createComment(' data-for end ');

        directiveAnchorComments.add(anchorStart);
        directiveAnchorComments.add(anchorEnd);

        element.replaceWith(anchorStart, anchorEnd);
        element.removeAttribute('data-for');
        element.removeAttribute('data-key');

        const block = {
            anchorStart,
            anchorEnd,
            templateElement: element,
            listExpression,
            keyExpression,
            array: [] as unknown[],
            entries: new Map<string, ForBlockEntry>(),
            reportedErrorKinds: new Set<string>(),
            ancestorChain: parentComponentNameList,
            generation: 0,
        } as ForBlock;

        block.binding = {kind: 'block', block, dependencies: new Set()};
        this.#forBlocks.add(block);
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
            if (!this.#compileAtWiring(element.dataset['showIf']!, element)) {
                return;
            }

            this.#showIfElementToDataMap.set(element, {
                anchor: trackDirectiveAnchor(document.createComment(' an anchor comment ')),
                expression: element.dataset['showIf']!,
                isHidden: false,
                scopeRef,
                binding: {kind: 'show', element, dependencies: new Set()},
            });
            boundElements.push(element);
        });

        // Unlike data-show-if, data-display-if is allowed on the clone root:
        // it toggles style.display, so there is no anchor conflict
        [root, ...root.querySelectorAll<HTMLElement>('[data-display-if]')].forEach(element => {
            if (element.dataset['displayIf'] === undefined) {
                return;
            }

            if (!this.#compileAtWiring(element.dataset['displayIf']!, element)) {
                return;
            }

            this.#displayIfElementToDataMap.set(element, {
                expression: element.dataset['displayIf']!,
                originalDisplay: element.style.display,
                scopeRef,
                binding: {kind: 'display', element, dependencies: new Set()},
            });
            boundElements.push(element);
        });

        // Unlike data-show-if, data-disabled-if is allowed on the clone root:
        // it toggles the .disabled property, so there is no anchor conflict
        [root, ...root.querySelectorAll<HTMLElement>('[data-disabled-if]')].forEach(element => {
            if (element.dataset['disabledIf'] === undefined) {
                return;
            }

            if (!this.#compileAtWiring(element.dataset['disabledIf']!, element)) {
                return;
            }

            if (!disableableTagNames.has(element.tagName)) {
                console.error(DATA_DISABLED_IF_MESSAGE, element);

                return;
            }

            this.#disabledIfElementToDataMap.set(element, {
                expression: element.dataset['disabledIf']!,
                scopeRef,
                binding: {kind: 'disabled', element, dependencies: new Set()},
            });
            boundElements.push(element);
        });

        // The entry already exists (set by the caller before wiring) — its
        // controller is this clone's own lifetime, so an eviction severs
        // these listeners without waiting for the whole component to die
        const listenerSignal = block.entries.get(key)!.listenerController.signal;

        [root, ...root.querySelectorAll<HTMLElement>('*')].forEach(element => {
            Array.from(element.attributes)
                .filter(attribute => DATA_ON_ATTRIBUTE_NAME_PATTERN.exec(attribute.name))
                .forEach(attribute => {
                    const eventName = DATA_ON_ATTRIBUTE_NAME_PATTERN.exec(attribute.name)![1];
                    const methodName = attribute.value;

                    if (!this.#validateMethodName(methodName, element)) {
                        return;
                    }

                    element.addEventListener(eventName, (event) => {
                        const entry = block.entries.get(key);

                        this.#handleEvent({methodName, event, item: entry?.item, index: entry?.index});
                    }, {signal: listenerSignal});
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

            // Per-item content projection is not implemented — whether the
            // target even has a <slot> is async knowledge, so this fires
            // unconditionally rather than splitting on slot-bearingness
            if (Array.from(element.childNodes).some(isContentNode)) {
                console.error(`Wrapper content on the "${componentName}" data-component inside a data-for item is not supported (per-item content projection is not implemented) — remove the markup`, element);

                while (element.firstChild) {
                    element.removeChild(element.firstChild);
                }
            }

            const entryAtWiring = block.entries.get(key);

            loadDefinition(componentName).then(definition => {
                // Liveness gate: same entry object still present, parent alive
                if (this.#destroyed || block.entries.get(key) !== entryAtWiring) {
                    return;
                }

                if (definition === null) {
                    console.error(`A template-only include ("${componentName}") inside a data-for block is not supported — give it a <script> to make it a component`, element);

                    return;
                }

                const itemScope = this.#scopeForBinding(scopeRef);
                // The child doesn't exist yet — collection needs a binding
                // object to record into, so it's built with a placeholder and
                // patched with the real child right after instantiation
                const binding: Extract<TrackedBinding, {kind: 'props'}> = {kind: 'props', child: undefined as unknown as Component, dependencies: new Set()};
                const {seeds, names, bindings, failedSeedKinds} = this.#trackEvaluation(binding, () => this.#collectProps(element, itemScope));
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
                    binding.child = child;

                    // failedSeedKinds carries the seed errors already logged in
                    // #collectProps — a fresh Set here would double-log a
                    // persisting seed error on the first update pass
                    this.#propBindings.set(child, {bindings, scopeRef, reportedErrorKinds: failedSeedKinds, binding});
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

    // The single per-block entry point the drain calls for a dirty list
    // binding: evaluate the list expression inside its tracking frame (this
    // IS the block's own dependency collection), reconcile, then mark every
    // surviving entry's own bindings dirty — item bindings read $-scope
    // values that are never path-tracked, so a reconcile is their only
    // wake-up signal, and the array self-assign hatch means "same reference,
    // mutated contents", which only this unconditional marking can catch
    #reconcileTrackedBlock(block: ForBlock): void {
        const errorKindsThisPass = new Set<string>();
        let items: unknown;
        let listFailed = false;

        try {
            items = this.#trackEvaluation(block.binding, () => this.#evaluate({expression: block.listExpression}));
        } catch (error) {
            this.#reportBlockError(block, errorKindsThisPass, 'list-expression', `Can't evaluate the "${block.listExpression}" expression`, block.anchorStart, error);
            listFailed = true;
        }

        if (!listFailed) {
            if (!Array.isArray(items)) {
                this.#reportBlockError(block, errorKindsThisPass, 'non-array', `The "${block.listExpression}" expression did not produce an array`, block.anchorStart, items);
                items = [];
            }

            this.#reconcileBlockWith(block, items as unknown[], errorKindsThisPass);

            block.entries.forEach(entry => {
                entry.boundElements.forEach(boundElement => {
                    this.#bindingsFor(boundElement).forEach(binding => this.#dirtyBindings.add(binding));
                });

                if (entry.child) {
                    const record = this.#propBindings.get(entry.child);

                    if (record) {
                        this.#dirtyBindings.add(record.binding);
                    }
                }
            });
        }

        block.reportedErrorKinds.forEach(kind => {
            if (!errorKindsThisPass.has(kind)) {
                block.reportedErrorKinds.delete(kind);
            }
        });
    }

    #reconcileBlockWith(block: ForBlock, items: unknown[], errorKindsThisPass: Set<string>): void {
        // A block whose anchors never made it into the live tree (e.g. a
        // data-for combo-banned alongside data-slot, whose stripped-of-
        // routing content had nowhere to land during distribution) has
        // nothing to reconcile against — treat it as abandoned rather than
        // reach for a parent that does not exist
        if (!block.anchorEnd.parentNode) {
            return;
        }

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
                // Chained to the parent's lifetime, same pattern as
                // #wireComponentEvents' per-wiring controller — but there is
                // no child signal to chain here, only the parent's
                const listenerController = new AbortController();

                if (this.#abortController.signal.aborted) {
                    listenerController.abort();
                } else {
                    this.#abortController.signal.addEventListener('abort', () => listenerController.abort(), {once: true});
                }

                entry = {element, item, index, key, boundElements: [], listenerController};
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
                const bindings = this.#bindingsFor(boundElement);

                if (boundElement instanceof Text) {
                    this.#textNodeToDataMap.delete(boundElement);
                } else {
                    this.#valueElementToDataMap.delete(boundElement);
                    this.#showIfElementToDataMap.delete(boundElement);
                    this.#displayIfElementToDataMap.delete(boundElement);
                    this.#disabledIfElementToDataMap.delete(boundElement);
                }

                bindings.forEach(binding => this.#evictBinding(binding));
            });

            // Severs this clone's data-on-* listeners now — they must not
            // outlive their entry just because the parent is still alive
            entry.listenerController.abort();

            if (entry.child) {
                const propRecord = this.#propBindings.get(entry.child);

                this.#propBindings.delete(entry.child);
                this.#childComponents.delete(entry.child);

                if (propRecord) {
                    this.#evictBinding(propRecord.binding);
                }

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

    // methods is frozen at construction, so a name that isn't a key now never
    // becomes one — the check belongs here, at wiring time, not at the
    // event-time guard below (which stays as defense-in-depth)
    #validateMethodName(methodName: string, element: HTMLElement): boolean {
        if (Object.hasOwn(this.methods, methodName)) {
            return true;
        }

        console.error(`no such method "${methodName}" in methods — check the attribute for a typo`, element);

        return false;
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
        if (definition.css !== undefined) {
            injectComponentStyle(componentName, definition.css);
        }

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

            if (!this.#validateMethodName(methodName, element)) {
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

        // True for a component's own top-level mount (the true root, or an
        // SFC child's own instance) — false for a template-only include's
        // recursive call, which reuses this same instance to wire someone
        // else's borrowed markup and never receives projected content
        const isOwnMount = componentWrapper === this.element;

        parentComponentNameList = [componentName, ...parentComponentNameList];

        return Component.loadTemplate(componentName)
            .then(template => this.#renderTemplate({template, parentComponentNameList, isOwnMount}))
            .then(({documentFragment, childFailure, slotRecords}) => {
                if (this.#destroyed) {
                    throw new Error(COMPONENT_DESTROYED_MESSAGE);
                }

                return this.#distributeContent({componentWrapper, slotRecords, parentComponentNameList, isOwnMount})
                    .then(distributionFailure => {
                        if (this.#destroyed) {
                            throw new Error(COMPONENT_DESTROYED_MESSAGE);
                        }

                        // childNodes, not children: anchor comments for initially
                        // hidden top-level elements must move into the live DOM too
                        while (documentFragment.childNodes.length) {
                            componentWrapper.appendChild(documentFragment.childNodes[0]);
                        }

                        // The initial mount renders synchronously: mark every wired
                        // binding dirty, then drain once — that first drain IS the
                        // collection pass for every binding's dependency set
                        this.#markAllBindingsDirty();
                        this.#drain();

                        const firstFailure = childFailure ?? distributionFailure;

                        if (firstFailure) {
                            // Mount what succeeded first, then surface the first
                            // child failure through ready — a broken child is
                            // loud, but its siblings still render (the
                            // framework's loud-but-non-fatal posture)
                            return Promise.reject(firstFailure.reason);
                        }

                        return undefined;
                    });
            });
    }

    #renderTemplate({template, parentComponentNameList, isOwnMount}: {template: string; parentComponentNameList: string[]; isOwnMount: boolean}): Promise<{documentFragment: DocumentFragment; childFailure: PromiseRejectedResult | undefined; slotRecords: Map<string, SlotRecordEntry>}> {
        const divElement = document.createElement('div');

        divElement.innerHTML = template;

        const templateElement = divElement.firstChild;

        if (!(templateElement instanceof HTMLTemplateElement)) {
            return Promise.reject('A component template file must have a <template> element as its first child');
        }

        // The root component's file never passes through definition parsing,
        // so a <style> sibling there would be silently inert without this
        // scan. It must stay root-only: an SFC child re-reads its own raw
        // file (legally style-bearing) through this same path, and includes
        // are already gated at parsing — no other path can carry a style
        if (!this.#parentEventTarget) {
            for (let node = templateElement.nextSibling; node; node = node.nextSibling) {
                if (node instanceof HTMLStyleElement) {
                    return Promise.reject(`A <style> in the "${this.componentName}" root component's template file is not supported — root styles belong to the host page's stylesheet`);
                }
            }
        }

        const documentFragment = templateElement.content;
        // Template-only includes reuse the including component's own `this`
        // for a borrowed template — a <slot> there stays plain, inert markup
        // (out of scope), so the scan only ever runs for a genuine mount
        const slotRecords = isOwnMount ? this.#scanSlots(documentFragment) : new Map<string, SlotRecordEntry>();

        if (slotRecords.size && !this.#parentEventTarget) {
            slotRecords.forEach((entry, name) => {
                console.error(`<slot${name ? ` name="${name}"` : ''}> has no effect in the "${this.componentName}" root component's template — there is no parent to project content from`, entry.anchor);
            });
        }

        return this.#wireFragment(documentFragment, parentComponentNameList)
            .then(childFailure => ({documentFragment, childFailure, slotRecords}));
    }

    // The slot scan is the first sweep of a component's own template — before
    // its own data-for extraction, so a <slot> nested in a block is still
    // reachable via closest(). Each surviving <slot> becomes a position
    // anchor plus a held, unwired fallback fragment; nothing here decides
    // fill-or-fallback — that is distribution's job, later, once the
    // receiving wrapper's actual content is known.
    #scanSlots(fragment: DocumentFragment): Map<string, SlotRecordEntry> {
        const slotRecords = new Map<string, SlotRecordEntry>();

        fragment.querySelectorAll<HTMLElement>('slot').forEach(element => {
            if (!fragment.contains(element)) {
                // Already consumed as another slot's fallback content
                return;
            }

            if (element.closest('[data-for]')) {
                console.error(`A <slot> inside a data-for block is not supported in the "${this.componentName}" component's template`, element);
                element.remove();

                return;
            }

            if (slotHasForbiddenDirective(element)) {
                console.error(`Directives are not supported on a <slot> element itself — wrap the slot region instead, in the "${this.componentName}" component's template`, element);
                element.remove();

                return;
            }

            const name = element.getAttribute('name') ?? DEFAULT_SLOT_NAME;

            if (slotRecords.has(name)) {
                console.error(`Duplicate <slot${name ? ` name="${name}"` : ''}> in the "${this.componentName}" component's template`, element);
                element.remove();

                return;
            }

            const fallbackFragment = document.createDocumentFragment();

            while (element.firstChild) {
                fallbackFragment.appendChild(element.firstChild);
            }

            const nestedSlot = fallbackFragment.querySelector('slot');

            if (nestedSlot) {
                console.error(`A <slot> cannot nest inside another slot's fallback content, in the "${this.componentName}" component's template`, nestedSlot);
                nestedSlot.remove();
            }

            const anchor = document.createComment(` slot: ${name || '(default)'} `);

            element.replaceWith(anchor);
            slotRecords.set(name, {anchor, fallbackFragment});
        });

        return slotRecords;
    }

    // Wires a slot's held fallback fragment (child scope) then unwraps it in
    // place of the anchor — decide-then-wire's "empty" branch, called both
    // from real distribution and from the parentless-root fallback path.
    #fillSlotWithFallback(entry: SlotRecordEntry, parentComponentNameList: string[]): Promise<PromiseRejectedResult | undefined> {
        return this.#wireFragment(entry.fallbackFragment, parentComponentNameList).then(childFailure => {
            entry.anchor.replaceWith(...Array.from(entry.fallbackFragment.childNodes));

            return childFailure;
        });
    }

    #wireEverySlotFallback(slotRecords: Map<string, SlotRecordEntry>, parentComponentNameList: string[]): Promise<PromiseRejectedResult | undefined> {
        return Promise.all(Array.from(slotRecords.values()).map(entry => this.#fillSlotWithFallback(entry, parentComponentNameList)))
            .then(failures => failures.find((failure): failure is PromiseRejectedResult => failure !== undefined));
    }

    // Distribution: runs after the destroyed gate, before the child fragment
    // appends. A template-only include's borrowed wrapper, or a plain root
    // mount, never received parent-authored content — only a genuine SFC
    // child's own wrapper does, so only that case collects and routes
    // `componentWrapper`'s childNodes; everything else just wires any
    // recorded slot's fallback (a no-op when there are no slots at all).
    #distributeContent({componentWrapper, slotRecords, parentComponentNameList, isOwnMount}: {
        componentWrapper: HTMLElement;
        slotRecords: Map<string, SlotRecordEntry>;
        parentComponentNameList: string[];
        isOwnMount: boolean;
    }): Promise<PromiseRejectedResult | undefined> {
        const receivesProjection = isOwnMount && this.#parentEventTarget !== undefined;

        if (!receivesProjection) {
            return this.#wireEverySlotFallback(slotRecords, parentComponentNameList);
        }

        const projectedNodes = Array.from(componentWrapper.childNodes);

        projectedNodes.forEach(node => componentWrapper.removeChild(node));

        if (slotRecords.size === 0) {
            if (projectedNodes.some(isContentNode)) {
                console.error(`The "${this.componentName}" component's template has no <slot> — wrapper content is not supported and was removed`, componentWrapper);
            }

            return Promise.resolve(undefined);
        }

        const buckets = new Map<string, ChildNode[]>();

        projectedNodes.forEach(node => {
            let name = DEFAULT_SLOT_NAME;

            if (node instanceof HTMLElement && node.dataset['slot'] !== undefined) {
                name = node.dataset['slot']!;

                if (!slotRecords.has(name)) {
                    console.error(`data-slot="${name}" has no matching <slot name="${name}"> in the "${this.componentName}" component`, node);
                    name = DEFAULT_SLOT_NAME;
                }
            }

            let bucket = buckets.get(name);

            if (!bucket) {
                bucket = [];
                buckets.set(name, bucket);
            }

            bucket.push(node);
        });

        if (!slotRecords.has(DEFAULT_SLOT_NAME) && (buckets.get(DEFAULT_SLOT_NAME) ?? []).some(isContentNode)) {
            console.error(`The "${this.componentName}" component has no default <slot> for unrouted content`, componentWrapper);
        }

        const fillPromises = Array.from(slotRecords.entries()).map(([name, entry]) => {
            const bucket = buckets.get(name) ?? [];

            if (bucket.some(isContentNode)) {
                entry.anchor.replaceWith(...bucket);

                return Promise.resolve(undefined);
            }

            return this.#fillSlotWithFallback(entry, parentComponentNameList);
        });

        return Promise.all(fillPromises)
            .then(failures => failures.find((failure): failure is PromiseRejectedResult => failure !== undefined));
    }

    // Wires an arbitrary detached subtree exactly as the template root is
    // wired: every directive sweep, then child/include mounting. Callable on
    // any fragment — the template root's own content today, a lazily-wired
    // fallback fragment tomorrow. Resolves to the first child/include
    // rejection (or undefined) once every mount attempt has settled; never
    // marks bindings dirty or drains — that first collection pass is the
    // caller's job, run once ALL wiring for the mount is done.
    #wireFragment(fragment: DocumentFragment, parentComponentNameList: string[]): Promise<PromiseRejectedResult | undefined> {
        // The combo ban runs before data-for extraction destroys the evidence
        // (a data-for clone keeps data-slot, and an extracted anchor carries
        // no routing information of its own)
        fragment.querySelectorAll<HTMLElement>('[data-slot]').forEach(element => {
            if (element.dataset['slot'] === '') {
                console.error('An empty data-slot is not a usable slot name', element);
                element.removeAttribute('data-slot');

                return;
            }

            if (element.dataset['showIf'] !== undefined || element.dataset['for'] !== undefined) {
                console.error('data-slot cannot be combined with data-show-if or data-for on the same element — wrap the routed content in its own element', element);
                element.removeAttribute('data-slot');
            }
        });

        fragment.querySelectorAll<HTMLElement>('[data-for]').forEach(element => {
            if (!fragment.contains(element)) {
                // An ancestor data-for errored and was removed with its subtree
                return;
            }

            this.#extractForBlock(element, parentComponentNameList);
        });

        // After extraction, so block subtrees are wired per clone instead
        this.#wireTextInterpolations(fragment);

        fragment.querySelectorAll<HTMLElement>('[data-show-if]').forEach(element => {
            if (!this.#compileAtWiring(element.dataset['showIf']!, element)) {
                return;
            }

            this.#showIfElementToDataMap.set(element, {
                anchor: trackDirectiveAnchor(document.createComment(' an anchor comment ')),
                expression: element.dataset['showIf']!,
                isHidden: false,
                binding: {kind: 'show', element, dependencies: new Set()},
            });
        });

        fragment.querySelectorAll<HTMLElement>('[data-display-if]').forEach(element => {
            if (!this.#compileAtWiring(element.dataset['displayIf']!, element)) {
                return;
            }

            this.#displayIfElementToDataMap.set(element, {
                expression: element.dataset['displayIf']!,
                originalDisplay: element.style.display,
                binding: {kind: 'display', element, dependencies: new Set()},
            });
        });

        fragment.querySelectorAll<HTMLElement>('[data-disabled-if]').forEach(element => {
            if (!this.#compileAtWiring(element.dataset['disabledIf']!, element)) {
                return;
            }

            if (!disableableTagNames.has(element.tagName)) {
                console.error(DATA_DISABLED_IF_MESSAGE, element);

                return;
            }

            this.#disabledIfElementToDataMap.set(element, {
                expression: element.dataset['disabledIf']!,
                binding: {kind: 'disabled', element, dependencies: new Set()},
            });
        });

        fragment.querySelectorAll<HTMLElement>('[data-ref]').forEach(element => {
            const name = element.dataset['ref']!;

            if (Object.hasOwn(this.#refsBacking, name)) {
                console.error(`Duplicate data-ref "${name}" — first wins`, element);

                return;
            }

            this.#refsBacking[name] = element;
        });

        fragment.querySelectorAll<HTMLElement>('[data-value]').forEach(element => {
            if (!this.#compileAtWiring(element.dataset['value']!, element)) {
                return;
            }

            if (!formControlTagNames.has(element.tagName)) {
                console.error(DATA_VALUE_FORM_ONLY_MESSAGE, element);

                return;
            }

            if (element instanceof HTMLInputElement && element.type === 'file') {
                console.error('data-value does not support file inputs (a browser will not let script set .files) — handle their change event with data-on-change instead', element);

                return;
            }

            const compiled = compile(element.dataset['value']!);

            if (!compiled.assignable) {
                console.error('data-value needs a plain dot path (name, user.email) — computed steps and ?. can\'t guarantee a reactive write', element);

                return;
            }

            if (Object.hasOwn(this.props, compiled.rootIdentifier!)) {
                console.error(`data-value cannot bind the "${compiled.rootIdentifier}" prop — props are inputs; copy into data to edit`, element);

                return;
            }

            this.#valueElementToDataMap.set(element, {
                expression: element.dataset['value']!,
                binding: {kind: 'value', element, dependencies: new Set()},
            });

            const isCheckbox = element instanceof HTMLInputElement && element.type === 'checkbox';
            const isRadio = element instanceof HTMLInputElement && element.type === 'radio';
            const eventName = isCheckbox || isRadio || element.tagName === 'SELECT' ? 'change' : 'input';

            element.addEventListener(eventName, () => {
                const writeBackValue: unknown = isCheckbox ? (element as HTMLInputElement).checked : (element as HTMLInputElement).value;

                try {
                    if (compiled.assignmentDepth === 1) {
                        (this.data as Record<string, unknown>)[compiled.rootIdentifier!] = writeBackValue;
                    } else {
                        compiled.assign(this.#dataResolver, writeBackValue);
                    }
                } catch (error) {
                    console.error(`Can't write back the "${compiled.source}" expression`, element, error);
                }
            }, {signal: this.#abortController.signal});
        });

        fragment.querySelectorAll<HTMLElement>('*').forEach(element => {
            Array.from(element.attributes)
                .filter(attribute => DATA_ON_ATTRIBUTE_NAME_PATTERN.exec(attribute.name))
                .forEach(attribute => {
                    const eventName = DATA_ON_ATTRIBUTE_NAME_PATTERN.exec(attribute.name)![1];
                    const methodName = attribute.value;

                    if (!this.#validateMethodName(methodName, element)) {
                        return;
                    }

                    element.addEventListener(eventName, (event) => {
                        this.#handleEvent({methodName, event});
                    }, {signal: this.#abortController.signal});
                });
        });

        const subComponentPromiseList = Array.from(fragment.querySelectorAll<HTMLElement>('[data-component]')).map(element => {
            if (formControlTagNames.has(element.tagName)) {
                console.error('data-component cannot be placed on a form control', element);

                return Promise.resolve();
            }

            return this.#mountChildOrInclude(element, parentComponentNameList);
        });

        // allSettled, not all: a broken child must not abort the mount of its
        // siblings — the first failure is carried out so the caller can
        // append the fragment before rejecting ready with it
        return Promise.allSettled(subComponentPromiseList)
            .then(results => results.find((result): result is PromiseRejectedResult => result.status === 'rejected'));
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

            if (!this.#compileAtWiring(expression, element)) {
                return;
            }

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

        return loadDefinition(componentName).then(definition => {
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

            const binding: Extract<TrackedBinding, {kind: 'props'}> = {kind: 'props', child: undefined as unknown as Component, dependencies: new Set()};
            const {seeds, names, bindings, failedSeedKinds} = this.#trackEvaluation(binding, () => this.#collectProps(element));
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
                binding.child = child;
                this.#propBindings.set(child, {bindings, reportedErrorKinds: failedSeedKinds, binding});
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

    // The per-child body of what used to be one loop over every prop
    // binding — batching semantics are unchanged: Object.is gates decide
    // which props actually changed, ONE combined "props" event carries all
    // of them, and the child's own bindings wake through #notify afterward,
    // so a props-handler write lands before the child's own bindings drain
    #reseedChild(child: Component): void {
        if (child.#destroyed) {
            return;
        }

        const record = this.#propBindings.get(child);

        if (!record) {
            return;
        }

        const errorKindsThisPass = new Set<string>();
        const scope = this.#scopeForBinding(record.scopeRef);
        const changes: Record<string, {value: unknown; previous: unknown}> = {};
        let changed = false;

        this.#trackEvaluation(record.binding, () => {
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
        });

        record.reportedErrorKinds.forEach(kind => {
            if (!errorKindsThisPass.has(kind)) {
                record.reportedErrorKinds.delete(kind);
            }
        });

        if (changed) {
            // Browsers report a listener exception without breaking the
            // dispatch; non-browser EventTargets may propagate it — either
            // way the batch contract (ONE event, then the child's own render)
            // must survive
            try {
                child.#eventTarget.dispatchEvent(new CustomEvent(RESERVED_EVENT_NAME, {detail: changes}));
            } catch (error) {
                console.error(`A "${RESERVED_EVENT_NAME}" event handler threw`, child.element, error);
            }

            Object.keys(changes).forEach(propName => child.#notify(`props:${propName}`));
        }
    }

    #updateOneValue(element: HTMLElement): void {
        const entry = this.#valueElementToDataMap.get(element);

        if (!entry) {
            return;
        }

        let newValue: unknown;

        try {
            newValue = this.#trackEvaluation(entry.binding, () => this.#evaluate({expression: entry.expression, scope: this.#scopeForBinding(entry.scopeRef)}));
        } catch (error) {
            console.error(`Can't evaluate the "${entry.expression}" expression`, element, error);

            return;
        }

        if (element instanceof HTMLInputElement && element.type === 'checkbox') {
            const checked = !!newValue;

            if (element.checked !== checked) {
                element.checked = checked;
            }

            return;
        }

        if (element instanceof HTMLInputElement && element.type === 'radio') {
            const checked = newValue === element.value;

            if (element.checked !== checked) {
                element.checked = checked;
            }

            return;
        }

        const target = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const stringValue = newValue as string;

        // Value-equality skip: during typing, data equals the input's value
        // by definition — that IS caret safety. Comparing before writing
        // closes both write-back strands (a same-tick programmatic write, a
        // gate-suppressed write with an unrelated flush pending) without any
        // enrollment bookkeeping
        if (target.value === stringValue) {
            return;
        }

        target.value = stringValue;
    }

    #updateOneText(node: Text): void {
        const entry = this.#textNodeToDataMap.get(node);

        if (!entry) {
            return;
        }

        let newValue: unknown;

        try {
            newValue = this.#trackEvaluation(entry.binding, () => this.#evaluate({expression: entry.expression, scope: this.#scopeForBinding(entry.scopeRef)}));
        } catch (error) {
            console.error(`Can't evaluate the "${entry.expression}" expression`, node, error);

            return;
        }

        node.textContent = newValue === null || newValue === undefined ? '' : String(newValue);
    }

    #updateOneShowIf(element: HTMLElement): void {
        const entry = this.#showIfElementToDataMap.get(element);

        if (!entry) {
            return;
        }

        let shouldBeVisible: boolean;

        try {
            shouldBeVisible = !!this.#trackEvaluation(entry.binding, () => this.#evaluate({expression: entry.expression, scope: this.#scopeForBinding(entry.scopeRef)}));
        } catch (error) {
            console.error(`Can't evaluate the "${entry.expression}" expression`, element, error);

            return;
        }

        if (shouldBeVisible) {
            this.#showElement(element);
        } else {
            this.#hideElement(element);
        }
    }

    #updateOneDisplayIf(element: HTMLElement): void {
        const entry = this.#displayIfElementToDataMap.get(element);

        if (!entry) {
            return;
        }

        let shouldBeVisible: boolean;

        try {
            shouldBeVisible = !!this.#trackEvaluation(entry.binding, () => this.#evaluate({expression: entry.expression, scope: this.#scopeForBinding(entry.scopeRef)}));
        } catch (error) {
            console.error(`Can't evaluate the "${entry.expression}" expression`, element, error);

            return;
        }

        element.style.display = shouldBeVisible ? entry.originalDisplay : 'none';
    }

    #updateOneDisabledIf(element: HTMLElement): void {
        const entry = this.#disabledIfElementToDataMap.get(element);

        if (!entry) {
            return;
        }

        let shouldBeDisabled: boolean;

        try {
            shouldBeDisabled = !!this.#trackEvaluation(entry.binding, () => this.#evaluate({expression: entry.expression, scope: this.#scopeForBinding(entry.scopeRef)}));
        } catch (error) {
            console.error(`Can't evaluate the "${entry.expression}" expression`, element, error);

            return;
        }

        (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement).disabled = shouldBeDisabled;
    }

    // The template and definition caches, the parsed-definition pipeline, and
    // per-type style injection all live in the definition module; these two
    // statics are the public surface over it.
    static clearTemplateCache(): void {
        clearCaches();
    }

    static loadTemplate(templateName: string): Promise<string> {
        return loadTemplateText(templateName);
    }
}
