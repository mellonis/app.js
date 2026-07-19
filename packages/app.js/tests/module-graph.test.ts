import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The file split rests on one invariant: the leaf modules never reach the
// engine at RUNTIME. support.ts is the delicate one — several binding records
// name Component in a field's type, so it imports the class, and only the
// `type` keyword keeps that import out of the emitted JavaScript.
//
// Calling a Component static from support.ts is caught by the compiler ('...
// cannot be used as a value because it was imported using import type'). The
// tempting fix for THAT error — deleting the keyword — is what these tests
// exist to catch: it typechecks, it builds, every other test still passes,
// and dist/support.js quietly gains a real circular import.
//
// Source is read as text on purpose. Importing the modules would prove
// nothing (a cycle usually resolves fine at import time and only misbehaves
// when a binding is needed during module evaluation), and reading dist/ would
// make the suite depend on a fresh build.

// Resolved from the working directory (the package root, where vitest.config
// lives) rather than import.meta.url — under the happy-dom environment that
// is an http: URL, not a file path.
function readSource(fileName: string): string {
    return readFileSync(resolve(process.cwd(), 'src', fileName), 'utf8');
}

describe('module graph', () => {
    it('support.ts imports the engine only as a type', () => {
        const engineImports = readSource('support.ts').match(/^import\s+(?:type\s+)?.*from '\.\/app\.js';$/gm) ?? [];

        // Guards the guard: without this, deleting the import outright — or
        // renaming the file — would make the assertion below vacuously true
        expect(engineImports).not.toHaveLength(0);

        engineImports.forEach(importLine => {
            expect(importLine).toMatch(/^import type\s/);
        });
    });

    it('definition.ts does not import the engine at all', () => {
        expect(readSource('definition.ts')).not.toMatch(/from '\.\/app\.js'/);
    });

    it('ghost.ts imports nothing — it is reached through the hooks it is handed', () => {
        expect(readSource('ghost.ts')).not.toMatch(/^import\s/m);
    });
});
