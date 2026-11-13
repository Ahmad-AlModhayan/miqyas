// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// A small static server for built single-page apps (mutated copies of a build are served from here). Loopback only.

import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

/** Serve `root` on 127.0.0.1 (port 0 = any free port). Unknown paths without an extension fall back to index.html. */
export async function serveDir(root: string, port = 0): Promise<StaticServer> {
  const base = path.resolve(root);
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      let file = path.resolve(base, '.' + rel);
      if (file !== base && !file.startsWith(base + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const st = await stat(file).catch(() => undefined);
      if (!st?.isFile()) {
        if (path.extname(rel)) {
          res.writeHead(404).end();
          return;
        }
        file = path.join(base, 'index.html');
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server has no port');
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
