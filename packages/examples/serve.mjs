import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
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

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    let filePath;

    // The framework build is more than one file now that app.js imports a
    // sibling module — any root-level *.js request is checked against dist/
    // first (ahead of the example's own web root, which never ships one)
    const distCandidate = /^\/[\w-]+\.js$/.test(url.pathname) ? resolve(frameworkDistDir, url.pathname.slice(1)) : null;

    if (distCandidate) {
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
        const body = await readFile(filePath);
        response.writeHead(200, {'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream'});
        response.end(body);
    } catch {
        const hint = distCandidate
            ? 'Framework build missing - run `npm install` (or `npm run build`) at the repo root first.'
            : `Not found: ${url.pathname}`;
        response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        response.end(hint);
    }
});

server.listen(port, () => {
    console.log(`Serving ${exampleName} at http://localhost:${port}/`);
});
