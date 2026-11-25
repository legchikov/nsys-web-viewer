// Local helper API used by both the dev server (Vite plugin) and `npm start`.
//
//   GET  /api/status            -> { nsys: "/path/to/nsys" | null, version }
//   POST /api/convert?name=x    -> body: raw .nsys-rep bytes, response: .sqlite bytes
//
// Conversion shells out to `nsys export --type sqlite`. Nothing leaves the machine.

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const exe = process.platform === 'win32' ? 'nsys.exe' : 'nsys';

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Search a directory tree (bounded depth) for an `nsys` executable. */
function searchTree(root, depth) {
  if (depth < 0 || !existsSync(root)) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === exe) return path.join(root, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      const hit = searchTree(path.join(root, e.name), depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

let cached;

export function findNsys() {
  if (cached !== undefined) return cached;
  const fromEnv = process.env.NSYS_PATH || process.env.NSYS;
  if (fromEnv && isFile(fromEnv)) return (cached = fromEnv);

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isFile(path.join(dir, exe))) return (cached = path.join(dir, exe));
  }

  const roots = [];
  if (process.platform === 'darwin') {
    try {
      for (const name of readdirSync('/Applications')) {
        if (/nsight systems/i.test(name)) roots.push(path.join('/Applications', name, 'Contents'));
      }
    } catch {
      /* ignore */
    }
  } else if (process.platform === 'linux') {
    roots.push('/opt/nvidia/nsight-systems', '/usr/local/cuda/bin', '/usr/local/cuda/nsight-systems');
  } else if (process.platform === 'win32') {
    roots.push('C:\\Program Files\\NVIDIA Corporation');
  }
  for (const r of roots) {
    const hit = searchTree(r, 4);
    if (hit) return (cached = hit);
  }
  return (cached = null);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ code: -1, out: String(err) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

let versionCache;
async function nsysVersion(bin) {
  if (versionCache !== undefined) return versionCache;
  const { code, out } = await run(bin, ['--version']);
  versionCache = code === 0 ? out.trim().split('\n').pop() : null;
  return versionCache;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

/**
 * Handle /api/* requests. Returns true when the request was handled.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleApi(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;

  if (url.pathname === '/api/status' && req.method === 'GET') {
    const bin = findNsys();
    sendJson(res, 200, { nsys: bin, version: bin ? await nsysVersion(bin) : null });
    return true;
  }

  if (url.pathname === '/api/convert' && req.method === 'POST') {
    const bin = findNsys();
    if (!bin) {
      sendJson(res, 501, {
        error:
          'The nsys command-line tool was not found on this computer, so .nsys-rep files cannot be converted here. ' +
          'Export to SQLite where nsys is installed, or set NSYS_PATH and restart the server.',
      });
      req.resume();
      return true;
    }
    const rawName = url.searchParams.get('name') || 'report.nsys-rep';
    const base = path.basename(rawName).replace(/[^\w.\- ]+/g, '_') || 'report.nsys-rep';
    const dir = await mkdtemp(path.join(tmpdir(), 'nsys-web-'));
    const input = path.join(dir, base.endsWith('.nsys-rep') || base.endsWith('.qdrep') ? base : base + '.nsys-rep');
    const output = path.join(dir, 'export.sqlite');
    try {
      await pipeline(req, createWriteStream(input));
      const t0 = Date.now();
      const { code, out } = await run(bin, [
        'export',
        '--type',
        'sqlite',
        '--force-overwrite',
        'true',
        '--output',
        output,
        input,
      ]);
      if (code !== 0 || !existsSync(output)) {
        sendJson(res, 500, { error: `nsys export failed (exit ${code}).`, log: out.slice(-4000) });
        return true;
      }
      const { size } = await stat(output);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'X-Export-Ms': String(Date.now() - t0),
      });
      await pipeline(createReadStream(output), res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
      else res.destroy();
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
