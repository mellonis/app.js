import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleName = process.argv[2];
const port = Number(process.argv[3] ?? 8123);

if (!exampleName) {
    console.error('Usage: node serve.mjs <example> [port]');
    process.exit(1);
}

const examplesRoot = fileURLToPath(new URL('.', import.meta.url));
const webRoot = resolve(examplesRoot, exampleName);
const frameworkDistDir = resolve(examplesRoot, '../app.js/dist');

// zod ships its exports map with an explicit "./package.json" entry, so
// resolving that (rather than guessing a node_modules layout) survives
// npm workspace hoisting either way. Only the registration example needs
// it — a missing/uninstalled zod just means /zod.js 404s below, the other
// examples never request it.
let zodEntryPath = null;

try {
    zodEntryPath = resolve(dirname(createRequire(import.meta.url).resolve('zod/package.json')), 'lib/index.mjs');
} catch {
    // left null
}

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    let filePath;

    // /zod.js is a fixed, literal alias to the installed package's single-file
    // ESM bundle — checked ahead of the dist-candidate regex below, which
    // would otherwise also match "zod.js" and misdirect it at frameworkDistDir
    const isZodRequest = url.pathname === '/zod.js';

    // The framework build is more than one file now that app.js imports a
    // sibling module — any other root-level *.js request is checked against
    // dist/ first (ahead of the example's own web root, which never ships one)
    const distCandidate = !isZodRequest && /^\/[\w-]+\.js$/.test(url.pathname) ? resolve(frameworkDistDir, url.pathname.slice(1)) : null;

    if (isZodRequest) {
        filePath = zodEntryPath;
    } else if (distCandidate) {
        filePath = distCandidate;
    } else {
        const requested = url.pathname === '/' ? '/index.html' : url.pathname;
        filePath = resolve(join(webRoot, requested));

        if (!filePath.startsWith(webRoot + sep)) {
            response.writeHead(403, {'Content-Type': 'text/plain; charset=utf-8'});
            response.end('Forbidden');
            return;
        }
    }

    try {
        if (!filePath) {
            throw new Error('no candidate path');
        }

        const body = await readFile(filePath);
        response.writeHead(200, {'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream'});
        response.end(body);
    } catch {
        const hint = isZodRequest
            ? 'zod is missing - run `npm install` at the repo root first (packages/examples depends on it).'
            : distCandidate
                ? 'Framework build missing - run `npm install` (or `npm run build`) at the repo root first.'
                : `Not found: ${url.pathname}`;
        response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        response.end(hint);
    }
});

server.listen(port, () => {
    console.log(`Serving ${exampleName} at http://localhost:${port}/`);
});
