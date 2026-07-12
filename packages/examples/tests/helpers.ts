import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface RunningExample {
    process: ChildProcess;
    baseUrl: string;
}

export function startExample(name: string, port: number): Promise<RunningExample> {
    const serveScript = fileURLToPath(new URL('../serve.mjs', import.meta.url));
    const child = spawn(process.execPath, [serveScript, name, String(port)], {stdio: ['ignore', 'pipe', 'inherit']});

    return new Promise((resolvePromise, rejectPromise) => {
        child.stdout!.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('Serving')) {
                resolvePromise({process: child, baseUrl: `http://localhost:${port}`});
            }
        });
        child.on('error', rejectPromise);
        child.on('exit', code => {
            rejectPromise(new Error(`serve.mjs exited early with code ${code}`));
        });
    });
}

export function stopExample(example: RunningExample): void {
    example.process.kill();
}

export async function pollFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const startedAt = Date.now();

    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Condition not met within timeout');
        }

        await new Promise(resolveSleep => setTimeout(resolveSleep, 25));
    }
}
