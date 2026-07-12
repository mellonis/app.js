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
const frameworkDist = resolve(examplesRoot, '../app.js/dist/app.js');

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    let filePath;

    if (url.pathname === '/app.js') {
        filePath = frameworkDist;
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
        const hint = filePath === frameworkDist
            ? 'Framework build missing - run `npm install` (or `npm run build`) at the repo root first.'
            : `Not found: ${url.pathname}`;
        response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        response.end(hint);
    }
});

server.listen(port, () => {
    console.log(`Serving ${exampleName} at http://localhost:${port}/`);
});
