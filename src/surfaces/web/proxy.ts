// SPDX-License-Identifier: Apache-2.0
// The origin block's floor: an in-process HTTP proxy that a browser context sends every request through. ctx.route
// and ctx.routeWebSocket work inside the page, so a dedicated or shared worker's WebSocket never meets them. The
// proxy sits in the network stack, below every page, frame and worker, and nothing in the page can route around it.

import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { bareHost, isAllowedConnectHostPort, isAllowedHttpProxyUrl, tryParseUrl } from './policy.js';

export interface OriginProxy {
  /** For Playwright's `proxy.server`. */
  server: string;
  close: () => Promise<void>;
}

/** Hop-by-hop headers (RFC 9110 7.6.1), plus any the Connection header names: one hop's, never forwarded. */
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function endToEnd(raw: string[]): string[] {
  const named = raw.flatMap((v, i) => (i % 2 === 0 && v.toLowerCase() === 'connection' ? raw[i + 1]!.split(',').map((t) => t.trim().toLowerCase()) : []));
  const drop = new Set([...HOP, ...named]);
  return raw.filter((_, i) => !drop.has(raw[i - (i % 2)]!.toLowerCase()));
}

const refuse = (sock: Duplex) => void sock.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');

/** Forward plain HTTP to `origin` and tunnel CONNECT (https:, ws: and wss:) to its host and port; refuse the rest. */
export function originProxy(origin: string): Promise<OriginProxy> {
  const allowed = new URL(origin);
  const socks = new Set<Duplex>();
  const keep = (s: Duplex) => {
    socks.add(s);
    s.on('error', () => {});
    s.on('close', () => socks.delete(s));
  };
  const srv = createServer((req, res) => {
    const rawUrl = req.url ?? '';
    const u = tryParseUrl(rawUrl);
    if (!u || !isAllowedHttpProxyUrl(rawUrl, allowed.origin)) return void res.writeHead(403, { 'content-length': '0' }).end();
    // agent: false, so each upstream socket closes after its response and none outlives close().
    const up = request({ host: bareHost(u.hostname), port: u.port || 80, method: req.method, path: u.pathname + u.search, headers: endToEnd(req.rawHeaders), agent: false }, (r) => {
      res.writeHead(r.statusCode ?? 502, endToEnd(r.rawHeaders));
      r.pipe(res);
      // An upstream reset mid-body: drop the client's response too, or it waits for the rest forever.
      r.on('error', () => res.destroy());
      r.on('aborted', () => res.destroy());
    });
    up.on('socket', keep);
    up.on('error', () => res.destroy());
    req.on('error', () => up.destroy());
    req.pipe(up);
  });
  srv.on('connection', keep);
  srv.on('connect', (req, sock: Duplex, head: Buffer) => {
    const authority = req.url ?? '';
    const u = tryParseUrl(`http://${authority}`);
    if (!u || !isAllowedConnectHostPort(authority, allowed.origin)) return refuse(sock);
    const up = connect(Number(u.port || 80), bareHost(u.hostname), () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    keep(up);
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
  });
  // Chromium tunnels ws: through CONNECT; an upgrade sent to the proxy as a plain request is refused.
  srv.on('upgrade', (_, sock: Duplex) => refuse(sock));
  const close = () =>
    new Promise<void>((resolve) => {
      for (const s of socks) s.destroy();
      srv.close(() => resolve());
    });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ server: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close }));
  });
}
