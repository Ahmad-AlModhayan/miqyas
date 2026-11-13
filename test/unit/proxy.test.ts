// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { createServer, request, type IncomingMessage } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { originProxy, type OriginProxy } from '../../src/surfaces/web/proxy.js';

// The app: /reset sends half a body and drops the socket; /ok answers with hop-by-hop headers the proxy must drop.
const app = createServer((req, res) => {
  if (req.url === '/reset') {
    res.writeHead(200, { 'content-length': '100' });
    res.write('0123456789');
    setTimeout(() => res.socket?.destroy(), 20);
    return;
  }
  res.writeHead(200, { connection: 'keep-alive, x-hop', 'keep-alive': 'timeout=5', 'x-hop': '1', 'x-end': '1' }).end('ok');
});
let origin = '';
let proxy: OriginProxy;

beforeAll(async () => {
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  proxy = await originProxy(origin);
});
afterAll(async () => {
  await proxy.close();
  await new Promise<void>((resolve) => app.close(() => resolve()));
});

/** A request through the proxy, as Chromium sends one: the absolute URL as the path. */
function get(url: string): Promise<{ res: IncomingMessage; body: string }> {
  const p = new URL(proxy.server);
  return new Promise((resolve, reject) => {
    const req = request({ host: p.hostname, port: p.port, path: url, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ res, body }));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('aborted')));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('originProxy', () => {
  it('survives an upstream reset mid-response, and strips hop-by-hop headers from the response', async () => {
    await expect(get(`${origin}/reset`)).rejects.toThrow();
    const { res, body } = await get(`${origin}/ok`);
    expect(body).toBe('ok');
    expect(res.headers['x-end']).toBe('1');
    expect(res.headers['keep-alive']).toBeUndefined();
    expect(res.headers['x-hop']).toBeUndefined();
  });

  it('refuses another origin', async () => {
    const { res } = await get('http://127.0.0.1:1/');
    expect(res.statusCode).toBe(403);
  });
});
