/**
 * HTTP API for the Homey module, mounted at /api/extensions/homey.
 * Yuvomi does not execute this file. A reverse proxy or gateway.js does.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { classifyNetworkError, createHomeyClient, pickCamera, withZoneNames } from './homey-client.js';
import { inspectAddress, inspectStreamUrl } from './guard.js';
import { createSessionResolver, moduleAccess } from './session.js';
import { createStore } from './store.js';

const PREFIX = '/api/extensions/homey';
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CAP_RE = /^[A-Za-z0-9_.:$-]{1,120}$/;
const EVENT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const PIN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class HttpError extends Error {
  constructor(status, reason, message, detail) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.detail = detail;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function sessionKey(cookie) {
  const match = String(cookie || '').match(/(?:^|;\s*)yuvomi\.sid=([^;]+)/);
  return match ? match[1] : String(cookie || '');
}

function send(res, status, payload, extra = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 32_768) {
        reject(new HttpError(413, 'invalid', 'Body is too large.'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid', 'Body must be JSON.'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'invalid', 'Body must be JSON.')));
  });
}

function cleanLabel(value) {
  const label = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  if (!label || label.length > 80) throw new HttpError(400, 'invalid', 'Label is required.');
  return label;
}

function cleanDetail(value) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
}

function cleanClass(value) {
  const name = String(value ?? '').toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(name) ? name : '';
}

function validToken(token) {
  return typeof token === 'string'
    && token.length >= 8
    && token.length <= 4000
    && !/[\s\u0000-\u001f]/.test(token);
}

function normalizeValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value)) {
    return value;
  }
  throw new HttpError(400, 'invalid', 'Value is invalid.');
}

function parsePin(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid', 'Body must be JSON.');
  }
  const label = cleanLabel(body.label);
  const detail = cleanDetail(body.detail);
  if (body.kind === 'capability') {
    if (!ID_RE.test(String(body.deviceId || ''))) throw new HttpError(400, 'invalid', 'Device is invalid.');
    if (!CAP_RE.test(String(body.capabilityId || ''))) throw new HttpError(400, 'invalid', 'Capability is invalid.');
    const mode = body.mode === 'set' ? 'set' : 'toggle';
    return {
      kind: 'capability',
      label,
      detail,
      deviceId: String(body.deviceId),
      capabilityId: String(body.capabilityId),
      mode,
      value: mode === 'set' ? normalizeValue(body.value) : null,
      deviceClass: cleanClass(body.deviceClass),
    };
  }
  if (body.kind === 'flow') {
    if (!ID_RE.test(String(body.flowId || ''))) throw new HttpError(400, 'invalid', 'Flow is invalid.');
    return {
      kind: 'flow',
      label,
      detail,
      flowId: String(body.flowId),
      advanced: body.advanced === true,
    };
  }
  if (body.kind === 'webhook') {
    if (!EVENT_RE.test(String(body.event || ''))) throw new HttpError(400, 'invalid', 'Event is invalid.');
    const tag = body.tag ? String(body.tag) : '';
    if (tag && !EVENT_RE.test(tag)) throw new HttpError(400, 'invalid', 'Tag is invalid.');
    return { kind: 'webhook', label, detail, event: String(body.event), tag };
  }
  throw new HttpError(400, 'invalid', 'Unknown button kind.');
}

function publicPin(pin, live = {}) {
  return {
    id: pin.id,
    kind: pin.kind,
    label: pin.label,
    detail: pin.detail || '',
    mode: pin.mode || (pin.kind === 'capability' ? 'toggle' : 'trigger'),
    capabilityId: pin.capabilityId || '',
    deviceClass: pin.deviceClass || '',
    value: live.value === undefined ? null : live.value,
    unavailable: live.unavailable === true,
  };
}

function storeFailure(err) {
  if (err?.code === 'EROFS' || err?.code === 'EACCES' || err?.code === 'EPERM') {
    return new HttpError(503, 'store', 'The doorbell address could not be stored.');
  }
  return err;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== 'string') return false;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const expected = forwarded.split(',')[0].trim();
  return Boolean(expected) && host === expected;
}

async function optionalList(fn) {
  try {
    return { items: await fn(), warning: null };
  } catch (err) {
    if (err && (err.homeyStatus === 401 || err.homeyStatus === 403 || err.homeyStatus === 404)) {
      return { items: [], warning: 'flows_unavailable' };
    }
    throw err;
  }
}

const RING_MS = 30_000;
const RING_LIMIT = 12;

function cleanAlertText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

function readRaw(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'invalid', 'Body is too large.'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new HttpError(400, 'invalid', 'Body was not read.')));
  });
}

function ringSecrets(req, url) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return [url.searchParams.get('token'), req.headers['x-homey-ring'], bearer]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

export function createHomeyHandler({
  dataDir,
  yuvomiUrl,
  allowLoopback = false,
  lookupImpl,
  fetchImpl,
  ttlMs,
  now = Date.now,
} = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  if (!yuvomiUrl) throw new Error('yuvomiUrl is required');
  const store = createStore(dataDir);
  const resolveSession = createSessionResolver({ yuvomiUrl, fetchImpl, ttlMs });
  const homey = createHomeyClient({ allowLoopback, lookupImpl });
  const csrfTokens = new Map();
  const activateHits = new Map();
  const ringHits = [];
  const testHits = [];
  let doorbell = null;

  function csrfFor(cookie) {
    const key = sessionKey(cookie);
    let token = csrfTokens.get(key);
    if (!token) {
      token = randomBytes(32).toString('hex');
      csrfTokens.set(key, token);
    }
    return token;
  }

  function csrfCookie(req, token) {
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted === true;
    return `homey.csrf=${token}; HttpOnly; SameSite=Lax; Path=/api/extensions/homey; Max-Age=86400${secure ? '; Secure' : ''}`;
  }

  function reply(req, res, status, payload) {
    const token = csrfFor(req.headers.cookie || '');
    send(res, status, { ...payload, csrfToken: token }, { 'Set-Cookie': csrfCookie(req, token) });
  }

  async function livePins() {
    const snap = store.snapshot();
    if (!snap.address || !snap.token) {
      return snap.pins.map((pin) => publicPin(pin, { unavailable: true }));
    }
    let devices = null;
    try {
      devices = await homey.devices(snap.address, snap.token);
    } catch {
      devices = null;
    }
    return snap.pins.map((pin) => {
      if (pin.kind !== 'capability') return publicPin(pin, { unavailable: devices == null });
      if (!devices) return publicPin(pin, { unavailable: true });
      const device = devices.find((item) => item.id === pin.deviceId);
      const cap = device?.capabilities.find((item) => item.id === pin.capabilityId);
      if (!cap) return publicPin(pin, { unavailable: true });
      return publicPin(pin, { unavailable: false, value: cap.value });
    });
  }

  async function requireSession(req, { allowNone = false } = {}) {
    const session = await resolveSession(req.headers.cookie || '');
    if (!session) throw new HttpError(401, 'unauthorized', 'Unauthorized.');
    const access = moduleAccess(session);
    if (access === 'none' && !allowNone) throw new HttpError(403, 'forbidden', 'Forbidden.');
    return { session, access };
  }

  function currentDoorbell() {
    if (!doorbell || doorbell.until <= now()) return null;
    const feed = doorbell.feed === 'camera' || doorbell.feed === 'url' ? doorbell.feed : 'none';
    return {
      id: doorbell.id,
      title: doorbell.title,
      body: doorbell.body,
      test: doorbell.test === true,
      stream: feed !== 'none',
      streamKind: feed === 'camera' ? 'image' : (doorbell.streamKind === 'image' ? 'image' : 'video'),
      feed,
      remainingMs: doorbell.until - now(),
    };
  }

  async function chooseFeed(snap) {
    if (snap.address && snap.token) {
      if (snap.cameraId) {
        try {
          const source = await homey.camera(snap.address, snap.token, snap.cameraId);
          if (source?.imageId || source?.snapshotUrl) return { feed: 'camera', cameraId: snap.cameraId };
        } catch {
          return { feed: 'camera', cameraId: snap.cameraId };
        }
      } else {
        try {
          const picked = pickCamera(await homey.cameras(snap.address, snap.token));
          if (picked) return { feed: 'camera', cameraId: picked.id };
        } catch { /* the card still opens */ }
      }
    }
    if (snap.streamUrl) return { feed: 'url', cameraId: null };
    return { feed: 'none', cameraId: null };
  }

  async function beginDoorbell({ title, body, test }) {
    const snap = store.snapshot();
    const choice = await chooseFeed(snap);
    doorbell = {
      id: randomBytes(16).toString('hex'),
      title,
      body,
      test: test === true,
      until: now() + RING_MS,
      feed: choice.feed,
      cameraId: choice.cameraId,
      streamKind: snap.streamKind === 'image' ? 'image' : 'video',
      snapFailed: false,
      imageFailed: false,
      imagePath: '',
    };
    return doorbell;
  }

  function proxyStream(target, res, until, options = {}) {
    const lib = target.protocol === 'https:' ? https : http;
    const timeout = options.timeout || 8000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      const upstream = lib.request({
        host: target.connectHost,
        port: target.port,
        method: 'GET',
        path: target.path,
        headers: { Host: target.hostHeader, Accept: 'image/jpeg, image/*, video/*, */*', ...options.headers },
        servername: target.hostname,
        timeout,
      }, (up) => {
        const rejectBeforeHeaders = (status, reason, detail) => {
          up.resume();
          if (res.headersSent || res.writableEnded) {
            res.destroy();
            finish();
            return;
          }
          finish(new HttpError(status, reason, 'The video stream did not start.', detail));
        };
        if ((up.statusCode || 0) >= 300 && (up.statusCode || 0) < 400) {
          rejectBeforeHeaders(502, 'stream');
          return;
        }
        if ((up.statusCode || 0) < 200 || (up.statusCode || 0) >= 300) {
          rejectBeforeHeaders(502, 'stream');
          return;
        }
        const type = String(up.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const allowed = type.startsWith('video/')
          || type === 'image/jpeg'
          || type === 'image/jpg'
          || type === 'image/png'
          || type === 'image/webp'
          || type === 'multipart/x-mixed-replace'
          || type === 'application/octet-stream';
        if (!allowed) {
          rejectBeforeHeaders(502, 'stream', 'type');
          return;
        }
        if (res.headersSent || res.writableEnded) {
          up.resume();
          finish();
          return;
        }
        res.writeHead(200, {
          'Content-Type': up.headers['content-type'] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        const stop = () => {
          clearTimeout(timer);
          upstream.destroy();
          up.destroy();
        };
        const timer = setTimeout(stop, Math.max(0, until - now()) + 1000);
        res.on('close', stop);
        up.on('error', stop);
        up.on('end', () => {
          clearTimeout(timer);
          finish();
        });
        up.pipe(res);
      });
      upstream.on('timeout', () => {
        upstream.destroy();
        if (!res.headersSent) finish(new HttpError(502, 'stream', 'The video stream did not start.', 'timeout'));
      });
      upstream.on('error', (err) => {
        if (!res.headersSent) {
          finish(new HttpError(502, 'stream', 'The video stream did not start.', classifyNetworkError(err)));
        }
      });
      upstream.end();
    });
  }

  async function serveCamera(res, live) {
    if (live.snapFailed && live.imageFailed) {
      throw new HttpError(502, 'stream', 'The video stream did not start.');
    }
    const snap = store.snapshot();
    let source = null;
    try {
      source = await homey.camera(snap.address, snap.token, live.cameraId);
    } catch {
      source = null;
    }
    if (source?.snapshotUrl && !live.snapFailed) {
      try {
        const target = await inspectStreamUrl(source.snapshotUrl, { allowLoopback, lookupImpl });
        await proxyStream(target, res, live.until, { timeout: 2500 });
        return;
      } catch {
        live.snapFailed = true;
        if (res.headersSent || res.writableEnded) return;
      }
    } else {
      live.snapFailed = true;
    }
    if (live.imageFailed || !source?.imageId) {
      live.imageFailed = true;
      throw new HttpError(502, 'stream', 'The video stream did not start.');
    }
    const target = await inspectAddress(snap.address, { allowLoopback, lookupImpl });
    const hostHeader = new URL(target.origin).host;
    const paths = live.imagePath
      ? [live.imagePath]
      : [
        `/api/image/${encodeURIComponent(source.imageId)}`,
        `/api/manager/images/image/${encodeURIComponent(source.imageId)}`,
      ];
    let lastError = null;
    for (const path of paths) {
      try {
        await proxyStream({
          ...target,
          path,
          hostHeader,
        }, res, live.until, {
          headers: { Authorization: `Bearer ${snap.token}` },
        });
        live.imagePath = path;
        return;
      } catch (err) {
        lastError = err;
        if (res.headersSent || res.writableEnded) return;
      }
    }
    live.imageFailed = true;
    throw lastError || new HttpError(502, 'stream', 'The video stream did not start.');
  }

  async function acceptRing(req, res, url) {
    const expected = store.snapshot().ringToken;
    if (!expected) throw new HttpError(409, 'ring_missing', 'No doorbell address has been created.');
    const presented = ringSecrets(req, url);
    if (!presented.some((value) => safeEqual(value, expected))) {
      throw new HttpError(401, 'unauthorized', 'Unauthorized.');
    }
    const at = now();
    const recent = ringHits.filter((stamp) => at - stamp < 60_000);
    if (recent.length >= RING_LIMIT) throw new HttpError(429, 'limit', 'Too many rings.');
    recent.push(at);
    ringHits.length = 0;
    ringHits.push(...recent);
    let title = cleanAlertText(url.searchParams.get('text'), 80);
    let body = '';
    if (req.method === 'POST') {
      const raw = await readRaw(req);
      if (raw.trim()) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            title = cleanAlertText(parsed.title || parsed.name || parsed.message || title, 80);
            body = cleanAlertText(parsed.body || parsed.text || '', 160);
          }
        } catch {
          title = title || cleanAlertText(raw, 80);
        }
      }
    }
    await beginDoorbell({ title, body, test: false });
    send(res, 200, { ok: true });
  }

  function requireWrite(access) {
    if (access !== 'write') throw new HttpError(403, 'read_only', 'Read-only.');
  }

  function requireAdmin(session, access) {
    if (session.role !== 'admin') throw new HttpError(403, 'admin_required', 'Administrator required.');
    requireWrite(access);
  }

  function requireCsrf(req) {
    if (!originAllowed(req)) throw new HttpError(403, 'origin', 'Origin rejected.');
    const expected = csrfFor(req.headers.cookie || '');
    const header = req.headers['x-homey-csrf'] || '';
    const cookie = cookieValue(req.headers.cookie, 'homey.csrf');
    if (!safeEqual(header, expected) || !safeEqual(cookie, expected)) {
      throw new HttpError(403, 'csrf', 'Security token rejected.');
    }
  }

  function configured() {
    const snap = store.snapshot();
    if (!snap.address || !snap.token) throw new HttpError(409, 'not_configured', 'Homey is not connected.');
    return snap;
  }

  async function activate(pin, snap) {
    if (pin.kind === 'capability') {
      const devices = await homey.devices(snap.address, snap.token);
      const device = devices.find((item) => item.id === pin.deviceId);
      const cap = device?.capabilities.find((item) => item.id === pin.capabilityId);
      if (!cap) throw new HttpError(409, 'homey_unreachable', 'That Homey control is not available.');
      const value = pin.mode === 'toggle' && typeof cap.value === 'boolean'
        ? !cap.value
        : (pin.mode === 'set' ? pin.value : true);
      await homey.setCapability(snap.address, snap.token, pin.deviceId, pin.capabilityId, value);
      return { ok: true, value };
    }
    if (pin.kind === 'flow') {
      await homey.triggerFlow(snap.address, snap.token, pin.flowId, pin.advanced === true);
      return { ok: true, value: null };
    }
    await homey.webhook(snap.address, pin.event, pin.tag || '');
    return { ok: true, value: null };
  }

  return function homeyHandler(req, res) {
    handle(req, res).catch((err) => {
      const status = Number(err?.status) || 500;
      const keep = err?.reason === 'upstream' || err?.reason === 'store' || err?.reason === 'stream';
      const reason = status >= 500
        ? (keep ? err.reason : 'homey_unreachable')
        : (err?.reason || 'invalid');
      const message = status >= 500
        ? (reason === 'upstream' ? 'Yuvomi did not answer.' : 'Homey module failed.')
        : (err?.message || 'Request rejected.');
      const payload = { error: message, code: status, reason };
      if (err?.detail && (reason === 'address' || reason === 'homey_unreachable')) payload.detail = err.detail;
      if (status >= 500) console.error('homey sidecar failed', reason);
      try {
        reply(req, res, status, payload);
      } catch {
        send(res, status, payload);
      }
    });
  };

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
      send(res, 404, { error: 'Not found.', code: 404, reason: 'invalid' });
      return;
    }
    if (req.method === 'OPTIONS') {
      if (!originAllowed(req)) {
        send(res, 403, { error: 'Origin rejected.', code: 403, reason: 'origin' });
        return;
      }
      res.writeHead(204, {
        Allow: 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Origin': req.headers.origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type, X-Homey-CSRF',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      res.end();
      return;
    }

    const rest = pathname.slice(PREFIX.length) || '/';
    if ((req.method === 'GET' || req.method === 'POST') && rest === '/ring') {
      await acceptRing(req, res, url);
      return;
    }

    const { session, access } = await requireSession(req, {
      allowNone: req.method === 'GET' && (rest === '/alert' || rest === '/stream'),
    });
    const mutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
    if (mutating) requireCsrf(req);
    const body = mutating ? await readBody(req) : null;

    if (req.method === 'GET' && rest === '/status') {
      const connection = store.connection();
      const snap = store.snapshot();
      reply(req, res, 200, {
        configured: connection.configured,
        address: connection.address,
        tokenSet: connection.tokenSet,
        ringSet: connection.ringSet,
        streamSet: connection.streamSet,
        streamKind: connection.streamKind,
        ...(session.role === 'admin' ? {
          streamUrl: snap.streamUrl || '',
          cameraId: snap.cameraId || '',
        } : {}),
        access,
        admin: session.role === 'admin',
      });
      return;
    }

    if (req.method === 'GET' && rest === '/stream') {
      const live = doorbell && doorbell.until > now() ? doorbell : null;
      if (!live || live.feed === 'none') {
        send(res, 404, { error: 'No stream is playing.', code: 404, reason: 'ring_missing' });
        return;
      }
      if (live.feed === 'camera') {
        await serveCamera(res, live);
        return;
      }
      const snap = store.snapshot();
      if (!snap.streamUrl) {
        send(res, 404, { error: 'No stream is playing.', code: 404, reason: 'ring_missing' });
        return;
      }
      const target = await inspectStreamUrl(snap.streamUrl, { allowLoopback, lookupImpl });
      await proxyStream(target, res, live.until);
      return;
    }

    if (req.method === 'GET' && rest === '/cameras') {
      requireWrite(access);
      const snap = store.snapshot();
      if (!snap.address || !snap.token) {
        reply(req, res, 200, { cameras: [], cameraId: '' });
        return;
      }
      const cameras = await homey.cameras(snap.address, snap.token);
      reply(req, res, 200, { cameras, cameraId: snap.cameraId || '' });
      return;
    }

    if (req.method === 'GET' && rest === '/alert') {
      reply(req, res, 200, { alert: currentDoorbell() });
      return;
    }

    if (req.method === 'POST' && rest === '/ring-token') {
      requireAdmin(session, access);
      const token = randomBytes(32).toString('base64url');
      try {
        await store.setRingToken(token);
      } catch (err) {
        throw storeFailure(err);
      }
      reply(req, res, 200, { token, ringSet: true });
      return;
    }

    if (req.method === 'DELETE' && rest === '/ring-token') {
      requireAdmin(session, access);
      try {
        await store.clearRingToken();
      } catch (err) {
        throw storeFailure(err);
      }
      reply(req, res, 200, { ringSet: false });
      return;
    }

    if (req.method === 'PUT' && rest === '/ring-stream') {
      requireAdmin(session, access);
      const urlValue = cleanAlertText(body?.url, 2000);
      const kind = body?.kind === 'image' ? 'image' : 'video';
      if (!urlValue) {
        try {
          await store.setStream({ url: null, kind: 'video' });
        } catch (err) {
          throw storeFailure(err);
        }
        reply(req, res, 200, { streamSet: false, streamKind: 'video', streamUrl: '' });
        return;
      }
      await inspectStreamUrl(urlValue, { allowLoopback, lookupImpl });
      try {
        await store.setStream({ url: urlValue, kind });
      } catch (err) {
        throw storeFailure(err);
      }
      reply(req, res, 200, { streamSet: true, streamKind: kind, streamUrl: urlValue });
      return;
    }

    if (req.method === 'POST' && rest === '/ring-test') {
      requireAdmin(session, access);
      const at = now();
      const recent = testHits.filter((stamp) => at - stamp < 60_000);
      if (recent.length >= RING_LIMIT) throw new HttpError(429, 'limit', 'Too many rings.');
      recent.push(at);
      testHits.length = 0;
      testHits.push(...recent);
      if (typeof body?.cameraId === 'string') {
        const requested = body.cameraId.trim();
        if (requested && !ID_RE.test(requested)) throw new HttpError(400, 'invalid', 'Camera is invalid.');
        try {
          await store.setCamera(requested || null);
        } catch (err) {
          throw storeFailure(err);
        }
      }
      await beginDoorbell({ title: 'Test', body: '', test: true });
      const alert = currentDoorbell();
      reply(req, res, 200, { ok: true, feed: alert?.feed || 'none', alert });
      return;
    }

    if (req.method === 'GET' && rest === '/pins') {
      reply(req, res, 200, { pins: await livePins() });
      return;
    }

    if (req.method === 'GET' && rest === '/catalog') {
      requireWrite(access);
      const snap = configured();
      const devices = withZoneNames(
        await homey.devices(snap.address, snap.token),
        await homey.zones(snap.address, snap.token),
      );
      const flows = await optionalList(() => homey.flows(snap.address, snap.token));
      const advanced = await optionalList(() => homey.advancedFlows(snap.address, snap.token));
      const warning = flows.warning && advanced.warning ? 'flows_unavailable' : null;
      reply(req, res, 200, {
        devices,
        flows: flows.items,
        advancedFlows: advanced.items,
        warning,
      });
      return;
    }

    if (req.method === 'PUT' && rest === '/connection') {
      requireAdmin(session, access);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'invalid', 'Body must be JSON.');
      }
      const target = await inspectAddress(body.address, { allowLoopback, lookupImpl });
      const token = body.token ? String(body.token) : (store.snapshot().token || '');
      if (!validToken(token)) throw new HttpError(400, 'invalid', 'API key is invalid.');
      let reachable = true;
      let detail = null;
      try {
        await homey.devices(target.origin, token);
      } catch (err) {
        if (err?.reason === 'homey_unauthorized') throw err;
        reachable = false;
        detail = err?.detail || 'timeout';
      }
      await store.saveConnection({ address: target.origin, token });
      const connection = store.connection();
      reply(req, res, 200, {
        configured: connection.configured,
        address: connection.address,
        tokenSet: connection.tokenSet,
        reachable,
        ...(detail ? { detail } : {}),
      });
      return;
    }

    if (req.method === 'POST' && rest === '/connection/test') {
      requireAdmin(session, access);
      const snap = configured();
      await homey.devices(snap.address, snap.token);
      reply(req, res, 200, { ok: true });
      return;
    }

    if (req.method === 'DELETE' && rest === '/connection') {
      requireAdmin(session, access);
      await store.clearConnection();
      reply(req, res, 200, { configured: false, address: null, tokenSet: false });
      return;
    }

    if (req.method === 'POST' && rest === '/pins') {
      requireWrite(access);
      const pin = parsePin(body);
      const saved = await store.addPin(pin);
      reply(req, res, 201, { pin: publicPin(saved) });
      return;
    }

    const pinMatch = rest.match(/^\/pins\/([^/]+)$/);
    if (pinMatch && req.method === 'DELETE') {
      requireWrite(access);
      const id = decodeURIComponent(pinMatch[1]);
      if (!PIN_RE.test(id)) throw new HttpError(400, 'invalid', 'Button is invalid.');
      await store.removePin(id);
      reply(req, res, 200, { ok: true });
      return;
    }

    const activateMatch = rest.match(/^\/pins\/([^/]+)\/activate$/);
    if (activateMatch && req.method === 'POST') {
      requireWrite(access);
      const id = decodeURIComponent(activateMatch[1]);
      if (!PIN_RE.test(id)) throw new HttpError(400, 'invalid', 'Button is invalid.');
      const now = Date.now();
      const recent = (activateHits.get(session.id) || []).filter((stamp) => now - stamp < 60_000);
      if (recent.length >= 30) throw new HttpError(429, 'limit', 'Too many presses.');
      recent.push(now);
      activateHits.set(session.id, recent);
      const snap = configured();
      const pin = snap.pins.find((item) => item.id === id);
      if (!pin) throw new HttpError(404, 'invalid', 'Button was not found.');
      const result = await activate(pin, snap);
      reply(req, res, 200, result);
      return;
    }

    send(res, 404, { error: 'Not found.', code: 404, reason: 'invalid' });
  }
}

export function createHomeyServer(options) {
  return http.createServer(createHomeyHandler(options));
}
