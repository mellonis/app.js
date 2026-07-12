# Fix #1 + TypeScript 7 Migration + Test Suite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make components reusable (fix issue #1), port the framework to TypeScript 7 with `#private` internals, and introduce a vitest + happy-dom test suite.

**Architecture:** The framework stays a single class. Source of truth moves to `src/app.ts`; `tsc` emits committed artifacts `app.js` + `app.d.ts` at the repo root so students keep importing `/app.js` with no build step. Tests import `src/app.ts` directly; a CI diff gate keeps the artifacts in sync.

**Tech Stack:** TypeScript 7.0.2 (native compiler), vitest 4.1.10, happy-dom 20.10.6, Node 24, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-12-issue-1-ts-migration-design.md`

## Global Constraints

- **NEVER run `git commit` without explicit maintainer approval.** Every "Checkpoint" step means: stop, show `git status` + a suggested commit message, and wait for the maintainer's go-ahead. This overrides any commit habit from other skills.
- **No Claude/AI attribution** in commits, PR text, code comments, or docs.
- Dev dependencies, exact versions (latest as of 2026-07-12): `typescript@7.0.2`, `vitest@4.1.10`, `happy-dom@20.10.6`.
- `app.js` and `app.d.ts` at the repo root are **build artifacts, committed**. Never hand-edit them after Task 4; regenerate with `npm run build`.
- The port is behavior-identical to the fixed `app.js` except for deviations explicitly listed in Task 4.
- Tests import `../src/app` (the TS source), never the root artifact.
- All issue references: [#1](https://github.com/mellonis/app.js/issues/1), [#2](https://github.com/mellonis/app.js/issues/2), [#3](https://github.com/mellonis/app.js/issues/3), [#4](https://github.com/mellonis/app.js/issues/4), [#8](https://github.com/mellonis/app.js/issues/8).

---

### Task 1: Branch setup

**Files:** none (git only)

**Interfaces:**
- Consumes: clean `master` at `d44c59d` or later
- Produces: branch `issue-1-ts-migration` on an up-to-date master tip; all later tasks run on this branch

- [ ] **Step 1: Sync master and branch**

```bash
cd /Users/mellonis/Developer/mellonis-workspace/app.js
git checkout master
git pull origin master
git checkout -b issue-1-ts-migration
```

- [ ] **Step 2: Verify**

Run: `git status && git branch --show-current`
Expected: `nothing to commit, working tree clean`, branch `issue-1-ts-migration`.

---

### Task 2: Fix issue #1 in app.js

**Files:**
- Modify: `app.js:115-120` (the `loadComponent` head)

**Interfaces:**
- Consumes: current `loadComponent` behavior
- Produces: per-branch ancestor chains; sibling/cousin component reuse loads; true cycles still rejected. Task 4 ports exactly this fixed version.

- [ ] **Step 1: Apply the fix**

In `app.js`, `loadComponent`, replace the shared-array mutation:

```js
// before
loadComponent({componentWrapper = this.element, componentName = this.componentName, parentComponentNameList = []} = {}) {
    if (parentComponentNameList.indexOf(componentName) >= 0) {
        return Promise.reject('A component cycle was detected during loading');
    }

    parentComponentNameList.unshift(componentName);
```

```js
// after
loadComponent({componentWrapper = this.element, componentName = this.componentName, parentComponentNameList = []} = {}) {
    if (parentComponentNameList.indexOf(componentName) >= 0) {
        return Promise.reject('A component cycle was detected during loading');
    }

    parentComponentNameList = [componentName, ...parentComponentNameList];
```

Each recursion branch now carries its own copy; siblings no longer see each other's names. Regression tests land in Task 7 (they will pass immediately — sequencing per spec).

- [ ] **Step 2: Checkpoint — request commit approval**

Show `git diff`. Suggested message: `fix: give each component branch its own ancestor chain (#1)`. **Do not commit without approval.**

---

### Task 3: Toolchain bootstrap

**Files:**
- Create: `.gitignore`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Modify: `package.json`
- Create (generated): `package-lock.json`

**Interfaces:**
- Consumes: nothing
- Produces: `npm run build` (tsc → root artifacts), `npm run typecheck` (whole repo, noEmit), `npm test` (vitest). Task 4 relies on `build`/`typecheck`; Tasks 5–7 rely on `test`.

- [ ] **Step 1: Create `.gitignore`**

```gitignore
node_modules/
.superpowers/
```

- [ ] **Step 2: Install dev dependencies (exact versions)**

```bash
npm install --save-dev --save-exact typescript@7.0.2 vitest@4.1.10 happy-dom@20.10.6
```

- [ ] **Step 3: Update `package.json`**

Full new content (repository/keywords/author/license unchanged):

```json
{
  "name": "app.js",
  "version": "0.0.1",
  "private": true,
  "description": "A tiny reactive framework",
  "type": "module",
  "main": "app.js",
  "types": "app.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "repository": {
    "type": "git",
    "url": "(git://github.com:mellonis/app.js.git)"
  },
  "keywords": [
    "framework",
    "reactive"
  ],
  "author": "mellonis@mellonis.ru",
  "license": "MIT",
  "devDependencies": {
    "happy-dom": "20.10.6",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

(`devDependencies` will already be present from Step 2 — keep whatever npm wrote.)

- [ ] **Step 4: Create `tsconfig.json`** (typecheck config — whole repo, no emit)

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

- [ ] **Step 5: Create `tsconfig.build.json`** (emit config — src only)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "rootDir": "src",
    "outDir": "."
  },
  "include": ["src"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 6: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'happy-dom',
    },
});
```

- [ ] **Step 7: Verify the toolchain**

```bash
npx tsc --version
npx vitest run --passWithNoTests
```

Expected: tsc reports `7.0.2` (the native compiler); vitest exits 0 with "no test files found" note. **Contingency:** if the native tsc binary fails on darwin, replace typescript with `typescript@6.0.0-beta` (same language, JS compiler) and note the substitution at the checkpoint.

- [ ] **Step 8: Checkpoint — request commit approval**

Suggested message: `chore: add TypeScript 7 + vitest toolchain`. **Do not commit without approval.**

---

### Task 4: Port to `src/app.ts` and regenerate artifacts

**Files:**
- Create: `src/app.ts`
- Regenerate: `app.js`, `app.d.ts` (via `npm run build` — never by hand)

**Interfaces:**
- Consumes: fixed `app.js` from Task 2 as the reference implementation
- Produces: `export default class App` with public `constructor(options?: AppOptions)`, readonly `element`/`data`/`methods`/`componentName`, `static loadTemplate(templateName: string): Promise<string>`, `static readonly templateNameToTemplatePromiseMap: Map<string, Promise<string>>`. Everything else `#private`. Tasks 5–7 test exactly this surface.

**Sanctioned deviations from the JS original (all others are port bugs):**
1. Internals become `#private` fields/methods (maintainer amendment).
2. Explicit `instanceof HTMLTemplateElement` guard where the original assumed `firstChild.content` (spec §C) — rejects with a clear message instead of a `TypeError`.
3. Template cache is an eagerly initialized `static readonly` Map (original: lazy getter over `App.__templateNameToTemplatePromiseMap`) — observably identical.
4. `element.dataset['component']` is stamped with the *resolved* `this.componentName`, and the resolution chain gains a final `|| 'root'` — differs only in the degenerate `componentName: null` corner.
5. Known bugs #2, #3, #4, #8 are **preserved deliberately** (each has an open issue).

- [ ] **Step 1: Write `src/app.ts`**

```ts
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
            // typeof null === 'object': a null value recurses and throws — known bug, issue #3
            if (typeof data[key] === 'object') {
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
                // A throwing expression aborts the rest of this pass — issue #4
                const newValue = this.#evaluate({expression: entry.expression});

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
            const shouldBeVisible = !!this.#evaluate({expression: entry.expression});

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
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors. (Tests dir doesn't exist yet — that's fine, `include` tolerates it.)

- [ ] **Step 3: Build and inspect**

Run: `npm run build && git status --short`
Expected: `app.js` modified (now generated), `app.d.ts` new. Skim the emitted `app.js`: it must contain `#loadComponent` (native private methods, ES2022 passthrough) and the spread-copy cycle fix.

- [ ] **Step 4: Smoke-check the artifact is importable**

Run: `node -e "import('./app.js').then(m => console.log(typeof m.default))"`
Expected: `function` (module top level touches no DOM, so plain Node can import it).

- [ ] **Step 5: Checkpoint — request commit approval**

Suggested message: `refactor: port framework to TypeScript (src/app.ts), emit committed artifacts`. **Do not commit without approval.**

---

### Task 5: Test helpers + ghost/reactivity tests

**Files:**
- Create: `tests/helpers.ts`
- Create: `tests/ghost.test.ts`

**Interfaces:**
- Consumes: `App` from `../src/app` (Task 4 surface)
- Produces: `stubTemplates(templates: Record<string, string>): Mock` (installs a fetch stub serving `/templates/<name>.html` from the map, rejecting unknown names; returns the mock), `resetTemplateCache(): void`, `mountPoint(): HTMLElement`, `flush(): Promise<void>`. Tasks 6–7 import these exact names.

- [ ] **Step 1: Write `tests/helpers.ts`**

```ts
import { vi } from 'vitest';
import App from '../src/app';

export function stubTemplates(templates: Record<string, string>) {
    const fetchMock = vi.fn((url: string) => {
        const match = /^\/templates\/(.+)\.html$/.exec(url);
        const name = match?.[1];

        if (name && name in templates) {
            return Promise.resolve({text: () => Promise.resolve(templates[name])});
        }

        return Promise.reject(new Error(`404: ${url}`));
    });

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
}

export function resetTemplateCache(): void {
    App.templateNameToTemplatePromiseMap.clear();
}

export function mountPoint(): HTMLElement {
    const element = document.createElement('div');

    document.body.appendChild(element);

    return element;
}

export function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}
```

- [ ] **Step 2: Write `tests/ghost.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/app';
import { flush, mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('ghost reactivity', () => {
    it('exposes initial data', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new App({
            element: mountPoint(),
            data: {title: 'hello', user: {name: 'Ada'}},
        });
        await flush();

        expect(app.data.title).toBe('hello');
        expect((app.data.user as Record<string, unknown>).name).toBe('Ada');
    });

    it('updates a bound element when a top-level key is set', async () => {
        stubTemplates({root: '<template><span data-value="title"></span></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {title: 'hello'}});

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('hello');
        });

        app.data.title = 'changed';

        expect(host.querySelector('span')?.textContent).toBe('changed');
    });

    it('updates a bound element when a nested key is set', async () => {
        stubTemplates({root: '<template><span data-value="user.name"></span></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {user: {name: 'Ada'}}});

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('Ada');
        });

        (app.data.user as Record<string, unknown>).name = 'Grace';

        expect(host.querySelector('span')?.textContent).toBe('Grace');
    });

    it('evaluates full JS expressions over top-level keys', async () => {
        stubTemplates({root: '<template><span data-value="firstName + \' \' + lastName"></span></template>'});
        const host = mountPoint();
        new App({element: host, data: {firstName: 'Ada', lastName: 'Lovelace'}});

        await vi.waitFor(() => {
            expect(host.querySelector('span')?.textContent).toBe('Ada Lovelace');
        });
    });

    it('has a fixed shape: adding keys throws', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new App({element: mountPoint(), data: {title: 'x'}});
        await flush();

        expect(() => {
            (app.data as Record<string, unknown>).extra = 1;
        }).toThrow(TypeError);
    });

    it('does not allow replacing a nested object wholesale', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new App({element: mountPoint(), data: {user: {name: 'Ada'}}});
        await flush();

        expect(() => {
            (app.data as Record<string, unknown>).user = {name: 'Grace'};
        }).toThrow(TypeError);
    });

    it('stores an input element\'s value when one is assigned', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new App({element: mountPoint(), data: {title: 'x'}});
        await flush();

        const input = document.createElement('input');
        input.value = 'from input';
        app.data.title = input;

        expect(app.data.title).toBe('from input');
    });

    it.fails('does not crash when initial data contains null (issue #3)', () => {
        stubTemplates({root: '<template></template>'});

        expect(() => new App({element: mountPoint(), data: {user: null}})).not.toThrow();
    });
});
```

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: all `ghost.test.ts` tests pass; the `it.fails` case reports as passing (its body throws today — that's the contract; it flips when #3 is fixed).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Checkpoint — request commit approval**

Suggested message: `test: cover ghost reactivity; document issue #3 as test.fails`. **Do not commit without approval.**

---

### Task 6: Template-cache + directive tests

**Files:**
- Create: `tests/templates.test.ts`
- Create: `tests/directives.test.ts`

**Interfaces:**
- Consumes: helpers from Task 5, `App` from `../src/app`
- Produces: nothing downstream — leaf test files

- [ ] **Step 1: Write `tests/templates.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/app';
import { resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
});

describe('App.loadTemplate', () => {
    it('fetches each template once and caches the promise', async () => {
        const fetchMock = stubTemplates({widget: '<template><i></i></template>'});

        await App.loadTemplate('widget');
        await App.loadTemplate('widget');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('/templates/widget.html');
    });

    it('evicts a failed fetch from the cache so it can be retried', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        stubTemplates({});

        await expect(App.loadTemplate('late')).rejects.toBeUndefined();
        expect(App.templateNameToTemplatePromiseMap.has('late')).toBe(false);

        const fetchMock = stubTemplates({late: '<template></template>'});

        await expect(App.loadTemplate('late')).resolves.toBe('<template></template>');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Write `tests/directives.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/app';
import { flush, mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('data-show-if', () => {
    it('toggles a nested element via an anchor comment', async () => {
        stubTemplates({root: '<template><div><p data-show-if="visible">secret</p></div></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {visible: true}});

        await vi.waitFor(() => {
            expect(host.querySelector('p')).not.toBeNull();
        });

        app.data.visible = false;
        expect(host.querySelector('p')).toBeNull();

        app.data.visible = true;
        expect(host.querySelector('p')).not.toBeNull();
    });

    it.fails('shows an initially hidden top-level element when its expression becomes truthy (issue #8)', async () => {
        stubTemplates({root: '<template><p data-show-if="visible">secret</p></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {visible: false}});
        await flush();
        await flush();

        app.data.visible = true;

        await vi.waitFor(() => {
            expect(host.querySelector('p')).not.toBeNull();
        }, {timeout: 250});
    });
});

describe('data-value', () => {
    it('binds an input two-way for a nested key', async () => {
        stubTemplates({root: '<template><input data-value="user.name"></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {user: {name: 'before'}}});

        const input = await vi.waitFor(() => {
            const el = host.querySelector('input');
            expect(el).not.toBeNull();
            return el!;
        });
        expect(input.value).toBe('before');

        input.value = 'after';
        input.dispatchEvent(new Event('input'));

        expect((app.data.user as Record<string, unknown>).name).toBe('after');
    });

    it.fails('binds an input two-way for a top-level key (issue #2)', async () => {
        stubTemplates({root: '<template><input data-value="name"></template>'});
        const host = mountPoint();
        const app = new App({element: host, data: {name: 'before'}});

        const input = await vi.waitFor(() => {
            const el = host.querySelector('input');
            expect(el).not.toBeNull();
            return el!;
        });

        input.value = 'after';
        input.dispatchEvent(new Event('input'));

        expect(app.data.name).toBe('after');
    });
});

describe('data-on-*', () => {
    it('dispatches click to the named method, bound to the app, with the event', async () => {
        stubTemplates({root: '<template><button data-on-click="hit">go</button></template>'});
        const host = mountPoint();
        const calls: Array<{self: unknown; event: Event}> = [];
        const app = new App({
            element: host,
            methods: {
                hit(this: unknown, event: Event) {
                    calls.push({self: this, event});
                },
            },
        });

        const button = await vi.waitFor(() => {
            const el = host.querySelector('button');
            expect(el).not.toBeNull();
            return el!;
        });

        button.click();

        expect(calls).toHaveLength(1);
        expect(calls[0].self).toBe(app);
        expect(calls[0].event).toBeInstanceOf(Event);
    });

    it('dispatches submit to the named method', async () => {
        stubTemplates({root: '<template><form data-on-submit="onSubmit"></form></template>'});
        const host = mountPoint();
        const onSubmit = vi.fn();
        new App({element: host, methods: {onSubmit}});

        const form = await vi.waitFor(() => {
            const el = host.querySelector('form');
            expect(el).not.toBeNull();
            return el!;
        });

        form.dispatchEvent(new Event('submit'));

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('ignores unknown method names without throwing', async () => {
        stubTemplates({root: '<template><button data-on-click="missing">go</button></template>'});
        const host = mountPoint();
        new App({element: host});

        const button = await vi.waitFor(() => {
            const el = host.querySelector('button');
            expect(el).not.toBeNull();
            return el!;
        });

        expect(() => button.click()).not.toThrow();
    });
});
```

- [ ] **Step 3: Run + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass (two `it.fails` cases report as passing), typecheck clean.

- [ ] **Step 4: Checkpoint — request commit approval**

Suggested message: `test: cover template cache and directives; document issues #2, #8 as test.fails`. **Do not commit without approval.**

---

### Task 7: Component-loading tests (the #1 regression pair)

**Files:**
- Create: `tests/components.test.ts`

**Interfaces:**
- Consumes: helpers from Task 5, `App` from `../src/app`
- Produces: nothing downstream — leaf test file

- [ ] **Step 1: Write `tests/components.test.ts`**

Cycle assertions observe `console.error` (the constructor swallows rejections — issue #5, out of scope), since `#loadComponent` is private.

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('component loading', () => {
    it('loads nested components', async () => {
        stubTemplates({
            root: '<template><div data-component="child"></div></template>',
            child: '<template><span class="c">child</span></template>',
        });
        const host = mountPoint();
        new App({element: host});

        await vi.waitFor(() => {
            expect(host.querySelector('[data-component="child"] .c')).not.toBeNull();
        });
    });

    it('allows the same component twice as siblings (issue #1)', async () => {
        stubTemplates({
            root: '<template><div data-component="widget"></div><div data-component="widget"></div></template>',
            widget: '<template><span class="w">w</span></template>',
        });
        const host = mountPoint();
        new App({element: host});

        await vi.waitFor(() => {
            expect(host.querySelectorAll('.w')).toHaveLength(2);
        });
    });

    it('allows the same component in two different branches (issue #1)', async () => {
        stubTemplates({
            root: '<template><div data-component="left"></div><div data-component="right"></div></template>',
            left: '<template><div data-component="widget"></div></template>',
            right: '<template><div data-component="widget"></div></template>',
            widget: '<template><span class="w">w</span></template>',
        });
        const host = mountPoint();
        new App({element: host});

        await vi.waitFor(() => {
            expect(host.querySelectorAll('.w')).toHaveLength(2);
        });
    });

    it('still rejects a self-including component', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({selfy: '<template><div data-component="selfy"></div></template>'});
        new App({element: mountPoint(), componentName: 'selfy'});

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat()).toContain('A component cycle was detected during loading');
        });
    });

    it('still rejects a mutual cycle (a → b → a)', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            a: '<template><div data-component="b"></div></template>',
            b: '<template><div data-component="a"></div></template>',
        });
        new App({element: mountPoint(), componentName: 'a'});

        await vi.waitFor(() => {
            expect(errorSpy.mock.calls.flat()).toContain('A component cycle was detected during loading');
        });
    });

    it.fails('renders remaining bindings when one expression throws (issue #4)', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({
            root: '<template><span data-value="oops()"></span><span id="ok" data-value="title"></span></template>',
        });
        const host = mountPoint();
        new App({element: host, data: {title: 't'}});

        await vi.waitFor(() => {
            expect(host.querySelector('#ok')?.textContent).toBe('t');
        }, {timeout: 300});
    });
});
```

- [ ] **Step 2: Run + typecheck**

Run: `npm test && npm run typecheck`
Expected: full suite passes (four `it.fails` across the suite), typecheck clean.

- [ ] **Step 3: Optional red-check of the regression pair**

To watch the #1 tests actually catch the bug, temporarily revert the fix **in `src/app.ts` only** (restore `parentComponentNameList.unshift(componentName);` in `#loadComponent`), run `npx vitest run tests/components.test.ts` — expect the two issue-#1 tests to fail — then restore the spread version and re-run to green. Do not rebuild artifacts while reverted.

- [ ] **Step 4: Checkpoint — request commit approval**

Suggested message: `test: cover component loading; regression tests for #1, document #4 as test.fails`. **Do not commit without approval.**

---

### Task 8: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `typecheck`/`build`/`test` scripts (Task 3), committed artifacts (Task 4)
- Produces: PR gate enforcing artifact sync + green tests

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: git diff --exit-code app.js app.d.ts
      - run: npm test
```

- [ ] **Step 2: Verify the same sequence locally**

Run: `npm ci && npm run typecheck && npm run build && git diff --exit-code app.js app.d.ts && npm test`
Expected: every step exits 0. If the diff step fails, the artifacts drifted — rebuild and investigate before proceeding.

- [ ] **Step 3: Checkpoint — request commit approval**

Suggested message: `ci: typecheck, build, artifact-sync gate, tests`. **Do not commit without approval.**

---

### Task 9: Docs + final verification

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above
- Produces: docs matching the new reality; branch ready for PR

- [ ] **Step 1: Replace `README.md` content**

````markdown
# app.js
A tiny reactive framework

# Overview

- Templates should be placed in /templates directory
- Meaningful attributes in templates are: data-component, data-show-if, data-value, data-on-*
- App needs to be constructed with parameters: element, data, methods and componentName, which is optional

# Development

The source of truth is `src/app.ts` (TypeScript). The root `app.js` and `app.d.ts` are build artifacts kept committed so a page can `import App from '/app.js'` with no build step — regenerate them with the build script, never edit them by hand.

```sh
npm ci            # install dev dependencies
npm run build     # compile src/app.ts → app.js + app.d.ts
npm test          # run the vitest suite
npm run typecheck
```

# Styling component wrappers

A `data-component` element is a real box in layout, which gets in the way inside flex or grid containers. Make a wrapper transparent to layout with:

```css
[data-component="widget"] {
    display: contents;
}
```

Two caveats: the wrapper's own background/border/padding stop rendering, and the rule should target specific components — the app stamps `data-component` on its root element (often `<body>`), which must keep its box.
````

- [ ] **Step 2: Update `CLAUDE.md`**

Replace the "What this is" paragraph and the "Commands" section with:

````markdown
## What this is

A tiny reactive framework written as a teaching project for students learning JavaScript and the DOM. The source of truth is `src/app.ts` (TypeScript 7, strict, native `#private` internals); `tsc` emits `app.js` + `app.d.ts` at the repo root, and both artifacts stay **committed** so a page can `import App from '/app.js'` with no build step. Never hand-edit the root artifacts — change `src/app.ts` and run the build; CI fails if they drift. Runtime dependencies: none — keep it that way.

## Commands

```sh
npm ci            # install dev deps (typescript, vitest, happy-dom)
npm run build     # tsc -p tsconfig.build.json → app.js + app.d.ts at root
npm run typecheck # tsc -p tsconfig.json (src + tests, no emit)
npm test          # vitest run (happy-dom environment)
npx vitest run tests/components.test.ts   # single file
```

Tests import `../src/app` directly. Known open bugs (#2, #3, #4, #8) are encoded as `it.fails` cases asserting the *desired* behavior — when you fix one, its `it.fails` starts failing; remove the `.fails` modifier as part of the fix.

To exercise the framework manually, serve the directory over HTTP (templates load via `fetch`, so `file://` won't work) with a host page and a `/templates` directory — see README.
````

In the **Architecture** section, make exactly two replacements (the reactivity/directives/eval descriptions still hold):

Replace:
> Everything is the `App` class in `app.js`. One instance = one component tree rooted at `element` (default `document.body`).

with:
> Everything is the `App` class in `src/app.ts`. One instance = one component tree rooted at `element` (default `document.body`). Internals are native `#private`; the public surface is the constructor, `element`, `data`, `methods`, `componentName`, `static loadTemplate`, and the static template cache map.

Replace:
> Elements with `data-component="name"` inside a template recursively load that template as a sub-component; cycles are detected via `parentComponentNameList` and rejected.

with:
> Elements with `data-component="name"` inside a template recursively load that template as a sub-component; each recursion branch carries its own copy of the ancestor chain, so reuse across branches is fine while true cycles are rejected (issue #1).

- [ ] **Step 3: Manual smoke check (spec success criterion 3)**

Build a throwaway demo in the scratchpad — never inside the repo:

```bash
D=$(mktemp -d)
mkdir "$D/templates"
cp app.js "$D/app.js"
cat > "$D/index.html" <<'EOF'
<!doctype html>
<div id="app"></div>
<script type="module">
    import App from '/app.js';
    new App({element: document.querySelector('#app')});
</script>
EOF
cat > "$D/templates/root.html" <<'EOF'
<template><div data-component="widget"></div><div data-component="widget"></div></template>
EOF
cat > "$D/templates/widget.html" <<'EOF'
<template><p>widget instance</p></template>
EOF
(cd "$D" && python3 -m http.server 8123 &)
```

Open `http://localhost:8123` (or `curl` + a headless check): the page must show **two** "widget instance" paragraphs and the console must be free of cycle errors. Kill the server and remove `$D` afterwards.

- [ ] **Step 4: Final verification (full gate)**

Run: `npm run typecheck && npm run build && git diff --exit-code app.js app.d.ts && npm test`
Expected: all green.

- [ ] **Step 5: Checkpoint — request commit approval + PR decision**

Suggested message: `docs: development workflow, styling tip, CLAUDE.md toolchain update`. Then ask the maintainer whether to push and open a PR. PR title: `Fix component reuse (#1); migrate to TypeScript 7; add test suite`. PR body must say `Fixes #1`, reference the spec, and carry **no AI attribution footer**. Rebase on `origin/master` first if it moved.
