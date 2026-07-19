import { afterEach, describe, expect, it, vi } from 'vitest';
import Component from '../src/app';
import { mountPoint, resetTemplateCache, stubTemplates } from './helpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTemplateCache();
    document.body.innerHTML = '';
});

describe('events core', () => {
    it('emit/on round-trips a CustomEvent with detail on the own emitter', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint()});
        await app.ready;

        const seen: unknown[] = [];

        app.events.on('ping', event => seen.push(event.detail));
        app.events.emit('ping', {n: 1});

        expect(seen).toEqual([{n: 1}]);
    });

    it('events never reach the DOM (no bubbling, wrapper listeners silent)', async () => {
        stubTemplates({root: '<template></template>'});
        const host = mountPoint();
        const app = new Component({element: host});
        await app.ready;

        const domSpy = vi.fn();

        host.addEventListener('ping', domSpy);
        document.body.addEventListener('ping', domSpy);
        app.events.emit('ping');

        expect(domSpy).not.toHaveBeenCalled();
    });

    it("emitting the reserved 'props' name is a loud error and dispatches nothing", async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint()});
        await app.ready;

        const handler = vi.fn();

        app.events.on('props', handler);
        app.events.emit('props', {x: 1});

        expect(handler).not.toHaveBeenCalled();
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('reserved');
    });

    it('onParent on the root is a loud no-op', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint()});
        await app.ready;

        app.events.onParent('anything', vi.fn());

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('parent');
    });

    it('subscriptions die with destroy()', async () => {
        stubTemplates({root: '<template></template>'});
        const app = new Component({element: mountPoint()});
        await app.ready;

        const handler = vi.fn();

        app.events.on('ping', handler);
        app.destroy();
        app.events.emit('ping');

        expect(handler).not.toHaveBeenCalled();
    });
});

describe('method lookup', () => {
    // A method whose name collides with an Object.prototype member must still
    // dispatch. Asking `methods.hasOwnProperty(name)` would reach the lookup
    // THROUGH the object being searched: it invokes the user's own function
    // with the method NAME as its first argument, then reads the return value
    // as the answer. So the handler runs with the wrong argument and the real
    // dispatch never happens — which is why this asserts what the handler
    // RECEIVED, not merely that it ran. A call count alone passes either way.
    it('dispatches a method named after an Object.prototype member', async () => {
        stubTemplates({root: '<template><button data-on-click="hasOwnProperty"></button></template>'});

        const received: unknown[] = [];
        const host = mountPoint();
        const app = new Component({
            element: host,
            methods: {hasOwnProperty(event: Event) { received.push(event); }},
        });

        await app.ready;
        host.querySelector('button')!.dispatchEvent(new Event('click'));

        expect(received).toHaveLength(1);
        expect(received[0]).toBeInstanceOf(Event);
    });
});
