/**
 * Same-origin gateway for local use.
 *
 * Yuvomi serves the module page, but it does not run module code and it does
 * not mount /api/extensions/<id>. This process listens on the public port,
 * handles that prefix itself, and forwards every other request to Yuvomi.
 *
 *   PORT=3001 npm run dev
 *   node modules/homey/gateway.js
 *
 * HOMEY_GATEWAY_PORT   public port (default 3000)
 * YUVOMI_UPSTREAM      where Yuvomi listens (default http://127.0.0.1:3001)
 * YUVOMI_INTERNAL_URL  where this process asks /api/v1/auth/me (default the upstream)
 * HOMEY_DATA_DIR       state directory (default data/homey)
 * HOMEY_ALLOW_LOOPBACK set to 1 only for tests against a Homey on this machine
 */

import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHomeyHandler } from './sidecar/server.js';

const ALERT_SOURCE = readFileSync(new URL('./alert.js', import.meta.url));

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'transfer-encoding']);
const ALERT_SCRIPT = '<script type="module" src="/homey-alert.js"></script>';
const HTML_LIMIT = 2_000_000;

function wantsDocument(req) {
  if (req.method !== 'GET') return false;
  const pathName = (req.url || '/').split('?')[0];
  if (pathName.startsWith('/api/') || pathName === '/homey-alert.js') return false;
  const dest = String(req.headers['sec-fetch-dest'] || '');
  if (dest && dest !== 'document' && dest !== 'empty') return false;
  if (dest === 'document') return true;
  if (pathName === '/' || pathName === '/index.html' || pathName.endsWith('.html')) return true;
  return String(req.headers.accept || '').includes('text/html');
}

function splitOrigin(value) {
  const url = new URL(value);
  return { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80) };
}

function forwardHeaders(incoming) {
  const headers = { ...incoming };
  for (const name of Object.keys(headers)) {
    if (HOP.has(name.toLowerCase())) delete headers[name];
  }
  return headers;
}

export function createGateway({
  upstream = process.env.YUVOMI_UPSTREAM || 'http://127.0.0.1:3001',
  yuvomiUrl = process.env.YUVOMI_INTERNAL_URL || upstream,
  dataDir = process.env.HOMEY_DATA_DIR || path.resolve('data/homey'),
  allowLoopback = process.env.HOMEY_ALLOW_LOOPBACK === '1',
} = {}) {
  const target = splitOrigin(upstream);
  const homey = createHomeyHandler({ dataDir, yuvomiUrl, allowLoopback });

  function isHomey(req) {
    const pathName = (req.url || '/').split('?')[0];
    return pathName === '/api/extensions/homey' || pathName.startsWith('/api/extensions/homey/');
  }

  function proxy(req, res) {
    const headers = forwardHeaders(req.headers);
    const inject = wantsDocument(req);
    if (inject) delete headers['accept-encoding'];
    const preq = http.request({
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    }, (pres) => {
      const type = String(pres.headers['content-type'] || '');
      const canInject = inject && pres.statusCode === 200 && type.includes('text/html');
      if (!canInject) {
        const responseHeaders = forwardHeaders(pres.headers);
        res.writeHead(pres.statusCode || 502, responseHeaders);
        pres.pipe(res);
        return;
      }
      const chunks = [];
      let size = 0;
      let skipped = false;
      pres.on('data', (chunk) => {
        size += chunk.length;
        if (size > HTML_LIMIT) skipped = true;
        else chunks.push(chunk);
      });
      pres.on('end', () => {
        if (skipped || res.writableEnded) {
          res.destroy();
          return;
        }
        let html = Buffer.concat(chunks).toString('utf8');
        if (html.includes('</body>') && !html.includes('/homey-alert.js')) {
          html = html.replace('</body>', `${ALERT_SCRIPT}</body>`);
        }
        const body = Buffer.from(html);
        const responseHeaders = forwardHeaders(pres.headers);
        delete responseHeaders['content-encoding'];
        responseHeaders['content-length'] = String(body.length);
        res.writeHead(pres.statusCode || 200, responseHeaders);
        res.end(body);
      });
    });
    preq.on('error', () => {
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      const body = JSON.stringify({ error: 'Yuvomi is not reachable.', code: 502, reason: 'upstream' });
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
    req.pipe(preq);
  }

  const server = http.createServer((req, res) => {
    const pathName = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && pathName === '/homey-alert.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': ALERT_SOURCE.length,
      });
      res.end(ALERT_SOURCE);
      return;
    }
    if (isHomey(req)) {
      homey(req, res);
      return;
    }
    proxy(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    if (isHomey(req)) {
      socket.destroy();
      return;
    }
    const headers = forwardHeaders(req.headers);
    const preq = http.request({
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    });
    preq.on('upgrade', (pres, psocket, phead) => {
      const lines = [`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage || ''}`.trimEnd()];
      for (const [key, value] of Object.entries(pres.headers)) {
        const list = Array.isArray(value) ? value : [value];
        for (const item of list) lines.push(`${key}: ${item}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (phead?.length) socket.write(phead);
      if (head?.length) psocket.write(head);
      psocket.pipe(socket);
      socket.pipe(psocket);
      psocket.on('error', () => socket.destroy());
      socket.on('error', () => psocket.destroy());
    });
    preq.on('error', () => socket.destroy());
    preq.end();
  });

  return server;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  const port = Number(process.env.HOMEY_GATEWAY_PORT || process.env.PORT || 3000);
  const host = process.env.HOMEY_BIND || '::';
  const server = createGateway();
  server.listen({ port, host, ipv6Only: false }, () => {
    console.log(`Homey gateway listening on ${host}:${port}`);
  });
}
