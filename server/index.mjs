#!/usr/bin/env node
// Tiny zero-dependency server: serves the built app from dist/ and the local /api helpers.
// Usage: npm start            (builds, then serves on http://localhost:4173)
//        PORT=8080 npm run serve
//        NO_OPEN=1 npm run serve   (don't open a browser tab)

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNsys, handleApi } from './nsys.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.sqlite': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

if (!existsSync(path.join(root, 'index.html'))) {
  console.error('dist/ not found. Run `npm run build` first (or just `npm start`).');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  try {
    if (await handleApi(req, res)) return;
    const url = new URL(req.url || '/', 'http://localhost');
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Cache-Control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(port, host, () => {
  const url = `http://localhost:${port}`;
  const nsys = findNsys();
  console.log(`\n  Nsight Systems Web Viewer  →  ${url}\n`);
  console.log(
    nsys
      ? `  nsys found at ${nsys} — .nsys-rep files will be converted automatically.\n`
      : '  nsys not found — open .sqlite exports, or set NSYS_PATH to enable .nsys-rep uploads.\n',
  );
  if (!process.env.NO_OPEN && !process.env.CI) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
      spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
        .on('error', () => {})
        .unref();
    } catch {
      /* no browser available */
    }
  }
});
