// The reactive store. Each key of a plain object gets a getter/setter stamped
// with its dot path from the root (user.address.city); reading one announces
// the path, writing one announces that the path changed. Nested plain objects
// recurse into their own ghost carrying the longer path; arrays and
// primitives stay leaf values.
//
// The engine is reached through exactly two operations, passed in at
// construction rather than imported: record(path) while a tracking frame is
// open, and notify(path) when a write clears the equality gate. That is the
// whole contract — the store knows nothing else about the component that owns
// it, which is what lets it be read on its own.
export interface GhostHooks {
    // A path was read — the open tracking frame, if any, subscribes to it
    record(path: string): void;
    // A path's value changed — every binding subscribed to it, or to a path
    // below it, goes on the dirty list
    notify(path: string): void;
}

export function createGhost(data: Record<string, unknown>, hooks: GhostHooks, prefix = ''): Record<string, unknown> {
    const ghost: Record<string, unknown> = {};

    Object.keys(data).forEach(key => {
        const path = prefix ? `${prefix}.${key}` : key;

        if (data[key] !== null && typeof data[key] === 'object' && !Array.isArray(data[key])) {
            const nestedGhost = createGhost(data[key] as Record<string, unknown>, hooks, path);

            Object.defineProperty(ghost, key, {
                enumerable: true,
                get() {
                    hooks.record(path);

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

                    hooks.notify(path);
                },
            });
        } else {
            Object.defineProperty(ghost, key, {
                enumerable: true,
                get() {
                    hooks.record(path);

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
                    hooks.notify(path);
                },
            });
        }
    });

    Object.preventExtensions(ghost);

    return ghost;
}
