import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectAddress, inspectStreamUrl } from '../sidecar/guard.js';
import { normalizeCameras, normalizeDevices, normalizeZones, pickCamera, withZoneNames } from '../sidecar/homey-client.js';
import { createHomeyServer } from '../sidecar/server.js';
import { createStore } from '../sidecar/store.js';
import { createGateway } from '../gateway.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const TOKEN = 'super-secret-token-value';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function cookiePair(response) {
  const set = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return set.map((value) => value.split(';')[0]).join('; ');
}

async function call(base, pathname, { method = 'GET', cookie = '', json, csrf, origin } = {}) {
  const headers = {
    Accept: 'application/json',
    Origin: origin || base,
    ...(cookie ? { Cookie: cookie } : {}),
    ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(csrf ? { 'X-Homey-CSRF': csrf } : {}),
  };
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text, cookie: cookiePair(response) };
}

function startMe(handler) {
  const hits = { count: 0 };
  const server = http.createServer((req, res) => {
    hits.count += 1;
    handler(req, res, hits);
  });
  return { server, hits };
}

function admin(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    user: { id: 7, role: 'admin', username: 'ada', display_name: 'Ada' },
    permissions: { admin: true, modules: { 'ext:homey': 'write' } },
  }));
}

test('a Homey device list keeps rooms and only controls that can be set', () => {
  const devices = normalizeDevices({
    lamp: {
      id: 'lamp',
      name: 'Taklampe',
      class: 'Light',
      zone: 'zone-stue',
      capabilities: ['measure_power', 'dim', 'onoff'],
      capabilitiesObj: {
        onoff: { setable: true, type: 'boolean', title: { nb: 'På', en: 'On' }, value: false },
        dim: { setable: true, type: 'number', title: 'Dim', min: 0, max: 1, step: 0.01, value: 0.4, units: '%' },
        measure_power: { setable: false, type: 'number', title: 'Effekt' },
      },
    },
    sensor: {
      id: 'sensor',
      name: 'Termometer',
      class: 'sensor',
      zone: 'zone-gang',
      capabilities: ['measure_temperature'],
      capabilitiesObj: {
        measure_temperature: { setable: false, type: 'number', title: 'Temperatur' },
      },
    },
  });
  const named = withZoneNames(devices, normalizeZones({
    'zone-stue': { id: 'zone-stue', name: 'Stue' },
    'zone-gang': { id: 'zone-gang', name: 'Gang' },
  }));
  assert.equal(named.length, 1);
  assert.equal(named[0].zone, 'Stue');
  assert.equal(named[0].deviceClass, 'light');
  assert.equal(named[0].zoneId, undefined);
  assert.deepEqual(named[0].capabilities.map((cap) => cap.id), ['onoff', 'dim']);
  assert.equal(named[0].capabilities[0].title, 'På');
  assert.equal(named[0].capabilities[1].min, 0);
  assert.equal(named[0].capabilities[1].max, 1);
  assert.equal(named[0].capabilities[1].step, 0.01);
});

test('a doorbell without controls still counts as a camera and hides its address', () => {
  const cameras = normalizeCameras({
    bell: {
      id: 'g6',
      name: 'UniFi G6 Entry Pro',
      class: 'doorbell',
      cameraImage: { id: 'img-1', url: 'http://192.168.1.40/secret.jpg' },
      settings: { ip: '192.168.1.40', password: 'secret-pass' },
      capabilitiesObj: { alarm_generic: { setable: false, title: 'Ring' } },
    },
    hall: {
      id: 'hallcam',
      name: 'Gang',
      class: 'camera',
      images: [{ imageObj: { id: 'img-2', url: 'http://hidden.example/snap.jpg' } }],
    },
    lamp: {
      id: 'lamp',
      name: 'Taklampe',
      class: 'light',
      capabilitiesObj: { onoff: { setable: true, type: 'boolean', title: 'På' } },
    },
  });
  assert.deepEqual(cameras.map((camera) => camera.id), ['g6', 'hallcam']);
  assert.equal(cameras[0].deviceClass, 'doorbell');
  assert.equal(cameras[0].image, true);
  assert.equal(cameras[0].snapshot, true);
  const leaked = JSON.stringify(cameras);
  assert.equal(leaked.includes('192.168.1.40'), false);
  assert.equal(leaked.includes('secret'), false);
  assert.equal(leaked.includes('img-1'), false);
  assert.equal(pickCamera(cameras).id, 'g6');
  assert.equal(pickCamera([
    { id: 'garage', name: 'Garasje', deviceClass: 'camera', image: true, snapshot: false },
    { id: 'entry', name: 'G6 Pro Entry', deviceClass: 'camera', image: true, snapshot: false },
  ]).id, 'entry');
});

test('guard allows a LAN address and rejects metadata, loopback and tricks', async () => {
  const lookupImpl = async (host) => {
    if (host === 'homey.local') return [{ address: '192.168.1.20', family: 4 }];
    if (host === 'evil.test') return [{ address: '169.254.169.254', family: 4 }];
    if (host === 'mapped.test') return [{ address: '::ffff:169.254.169.254', family: 6 }];
    const error = new Error('ENOTFOUND');
    error.code = 'ENOTFOUND';
    throw error;
  };
  const lan = await inspectAddress('http://10.1.2.3', { lookupImpl });
  assert.equal(lan.origin, 'http://10.1.2.3');
  assert.equal(lan.connectHost, '10.1.2.3');
  const named = await inspectAddress('http://homey.local:80', { lookupImpl });
  assert.equal(named.connectHost, '192.168.1.20');

  await assert.rejects(inspectAddress('http://169.254.169.254', { lookupImpl }), { detail: 'blocked' });
  await assert.rejects(inspectAddress('http://[::ffff:169.254.169.254]', { lookupImpl }), { detail: 'blocked' });
  await assert.rejects(inspectAddress('http://evil.test', { lookupImpl }), { detail: 'blocked' });
  await assert.rejects(inspectAddress('http://mapped.test', { lookupImpl }), { detail: 'blocked' });
  await assert.rejects(inspectAddress('http://127.0.0.1', { lookupImpl }), { detail: 'loopback' });
  await assert.rejects(inspectAddress('http://localhost', { lookupImpl }), { detail: 'loopback' });
  const loop = await inspectAddress('http://127.0.0.1:9', { lookupImpl, allowLoopback: true });
  assert.equal(loop.connectHost, '127.0.0.1');
  await assert.rejects(inspectAddress('http://user:pass@10.1.2.3', { lookupImpl }), { detail: 'userinfo' });
  await assert.rejects(inspectAddress('file:///etc/passwd', { lookupImpl }), { detail: 'scheme' });
  await assert.rejects(inspectAddress('http://10.1.2.3/api', { lookupImpl }), { detail: 'path' });
  await assert.rejects(inspectAddress('http://2130706433', { lookupImpl }), { detail: 'loopback' });
  await assert.rejects(inspectAddress('http://2852039166', { lookupImpl }), { detail: 'blocked' });
  await assert.rejects(inspectAddress('http://missing.local', { lookupImpl }), { detail: 'resolve' });

  const stream = await inspectStreamUrl('http://10.4.5.6/cam/live.mjpg?token=abc', { lookupImpl });
  assert.equal(stream.path, '/cam/live.mjpg?token=abc');
  assert.equal(stream.connectHost, '10.4.5.6');
  await assert.rejects(inspectStreamUrl('rtsp://10.4.5.6/live', { lookupImpl }), { detail: 'scheme' });
  await assert.rejects(inspectStreamUrl('http://user:pass@10.4.5.6/live', { lookupImpl }), { detail: 'userinfo' });
});

test('store keeps the API key on disk and out of the public connection', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'homey-store-'));
  try {
    const store = createStore(dir);
    assert.equal(store.connection().tokenSet, false);
    await store.saveConnection({ address: 'http://10.1.2.3', token: TOKEN });
    assert.equal(store.connection().tokenSet, true);
    assert.equal(JSON.stringify(store.connection()).includes(TOKEN), false);
    const mode = statSync(path.join(dir, 'state.json')).mode & 0o777;
    assert.equal(mode, 0o600);
    for (let i = 0; i < store.maxPins; i += 1) {
      await store.addPin({ kind: 'webhook', label: `Knapp ${i}`, event: `ev${i}`, tag: '' });
    }
    await assert.rejects(store.addPin({ kind: 'webhook', label: 'for mange', event: 'overflow', tag: '' }), { reason: 'limit' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sidecar pins a device, toggles it, triggers a flow and a webhook', async () => {
  const homeyState = {
    onoff: false,
    requests: [],
  };
  const homeyServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    homeyState.requests.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      authorization: req.headers.authorization || '',
    });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const auth = req.headers.authorization || '';
      if (url.pathname.startsWith('/api/') && auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `rejected ${TOKEN}` }));
        return;
      }
      if (url.pathname === '/api/manager/devices/device/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          lamp: {
            id: 'lamp',
            name: 'Taklampe',
            class: 'light',
            zone: 'zone-stue',
            capabilities: ['onoff', 'dim', 'button'],
            capabilitiesObj: {
              onoff: { value: homeyState.onoff, setable: true, type: 'boolean', title: 'På' },
              dim: { value: 0.2, setable: true, type: 'number', title: 'Dim' },
              button: { value: false, setable: false, type: 'button', title: 'Skjult' },
              measure: { value: 1, setable: false, type: 'number', title: 'Måler' },
            },
          },
        }));
        return;
      }
      if (url.pathname === '/api/manager/zones/zone/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 'zone-stue': { id: 'zone-stue', name: 'Stue' } }));
        return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/manager/devices/device/lamp/capability/onoff') {
        homeyState.onoff = JSON.parse(raw).value;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (url.pathname === '/api/manager/flow/flow/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ night: { id: 'night', name: 'God natt', enabled: true } }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/manager/flow/flow/night/trigger') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (url.pathname === '/api/manager/flow/advancedflow/') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (url.pathname === '/webhook') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  const me = startMe((req, res) => {
    if (!String(req.headers.cookie || '').includes('yuvomi.sid=ok')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"Unauthorized"}');
      return;
    }
    admin(res);
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'homey-side-'));
  const homeyUrl = await listen(homeyServer);
  const meUrl = await listen(me.server);
  const sidecar = createHomeyServer({
    dataDir: dir,
    yuvomiUrl: meUrl,
    allowLoopback: true,
  });
  const base = await listen(sidecar);

  try {
    const anon = await call(base, '/api/extensions/homey/status');
    assert.equal(anon.status, 401);
    assert.equal(anon.text.includes(TOKEN), false);

    const first = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=ok' });
    assert.equal(first.status, 200);
    assert.equal(first.body.configured, false);
    assert.equal(first.body.admin, true);
    const jar = `yuvomi.sid=ok; ${first.cookie}`;
    const warmed = await call(base, '/api/extensions/homey/status', { cookie: jar });
    assert.equal(warmed.status, 200);
    const before = me.hits.count;
    const second = await call(base, '/api/extensions/homey/status', { cookie: jar });
    assert.equal(second.status, 200);
    assert.equal(me.hits.count, before, 'a second call inside the cache window does not ask Yuvomi again');

    const saved = await call(base, '/api/extensions/homey/connection', {
      method: 'PUT',
      cookie: jar,
      csrf: first.body.csrfToken,
      json: { address: homeyUrl, token: TOKEN },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.reachable, true);
    assert.equal(saved.body.tokenSet, true);
    assert.equal(saved.text.includes(TOKEN), false);

    const catalog = await call(base, '/api/extensions/homey/catalog', { cookie: jar });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.devices[0].name, 'Taklampe');
    assert.equal(catalog.body.devices[0].zone, 'Stue');
    assert.equal(catalog.body.devices[0].deviceClass, 'light');
    assert.deepEqual(catalog.body.devices[0].capabilities.map((cap) => cap.id), ['onoff', 'dim']);
    assert.equal(catalog.body.flows[0].name, 'God natt');
    assert.equal(catalog.body.warning, null);
    assert.equal(catalog.text.includes(TOKEN), false);

    const pin = await call(base, '/api/extensions/homey/pins', {
      method: 'POST',
      cookie: jar,
      csrf: first.body.csrfToken,
      json: {
        kind: 'capability',
        label: 'Taklampe',
        detail: 'Stue · På',
        deviceId: 'lamp',
        capabilityId: 'onoff',
        mode: 'toggle',
      },
    });
    assert.equal(pin.status, 201, JSON.stringify(pin.body));
    const pressed = await call(base, `/api/extensions/homey/pins/${pin.body.pin.id}/activate`, {
      method: 'POST',
      cookie: jar,
      csrf: first.body.csrfToken,
      json: {},
    });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    assert.equal(pressed.body.value, true);
    assert.equal(homeyState.onoff, true);
    const put = homeyState.requests.find((item) => item.method === 'PUT');
    assert.equal(put.path, '/api/manager/devices/device/lamp/capability/onoff');
    assert.equal(put.authorization, `Bearer ${TOKEN}`);

    const flow = await call(base, '/api/extensions/homey/pins', {
      method: 'POST',
      cookie: jar,
      csrf: first.body.csrfToken,
      json: { kind: 'flow', label: 'God natt', flowId: 'night', advanced: false },
    });
    const triggered = await call(base, `/api/extensions/homey/pins/${flow.body.pin.id}/activate`, {
      method: 'POST',
      cookie: jar,
      csrf: first.body.csrfToken,
      json: {},
    });
    assert.equal(triggered.status, 200);
    assert.ok(homeyState.requests.some((item) => item.path === '/api/manager/flow/flow/night/trigger' && item.method === 'POST'));

    const hook = await call(base, '/api/extensions/homey/pins', {
      method: 'POST',
      cookie: jar,
      csrf: first.body.csrfToken,
      json: { kind: 'webhook', label: 'Kveld', event: 'night', tag: 'home' },
    });
    const hooked = await call(base, `/api/extensions/homey/pins/${hook.body.pin.id}/activate`, {
      method: 'POST',
      cookie: jar,
      csrf: first.body.csrfToken,
      json: {},
    });
    assert.equal(hooked.status, 200);
    const webhook = homeyState.requests.find((item) => item.path === '/webhook');
    assert.equal(webhook.authorization, '');
    assert.equal(webhook.search, '?event=night&tag=home');

    const pins = await call(base, '/api/extensions/homey/pins', { cookie: jar });
    const lamp = pins.body.pins.find((item) => item.id === pin.body.pin.id);
    assert.equal(lamp.value, true);
    assert.equal(pins.text.includes(TOKEN), false);

    const noCsrf = await call(base, '/api/extensions/homey/pins', {
      method: 'POST',
      cookie: jar,
      json: { kind: 'webhook', label: 'Uten', event: 'nope' },
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.reason, 'csrf');

    const noOrigin = await fetch(`${base}/api/extensions/homey/connection/test`, {
      method: 'POST',
      headers: {
        Cookie: jar,
        'Content-Type': 'application/json',
        'X-Homey-CSRF': first.body.csrfToken,
      },
      body: '{}',
    });
    assert.equal(noOrigin.status, 403);
  } finally {
    await close(sidecar);
    await close(homeyServer);
    await close(me.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-only can look, a member cannot save the key, and none is refused', async () => {
  const roles = { current: 'read' };
  const me = startMe((req, res) => {
    if (!String(req.headers.cookie || '').includes('yuvomi.sid=')) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    const access = roles.current;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      user: { id: 3, role: access === 'member' ? 'member' : 'admin', display_name: 'Noa' },
      permissions: { modules: { 'ext:homey': access === 'member' ? 'write' : access } },
    }));
  });
  const homeyServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'homey-acl-'));
  const meUrl = await listen(me.server);
  const homeyUrl = await listen(homeyServer);
  const sidecar = createHomeyServer({ dataDir: dir, yuvomiUrl: meUrl, allowLoopback: true });
  const base = await listen(sidecar);
  try {
    const read = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=ok' });
    assert.equal(read.body.access, 'read');
    const jar = `yuvomi.sid=ok; ${read.cookie}`;
    const denied = await call(base, '/api/extensions/homey/pins', {
      method: 'POST',
      cookie: jar,
      csrf: read.body.csrfToken,
      json: { kind: 'webhook', label: 'Nei', event: 'nope' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'read_only');

    roles.current = 'member';
    const member = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=member' });
    const memberJar = `yuvomi.sid=member; ${member.cookie}`;
    const save = await call(base, '/api/extensions/homey/connection', {
      method: 'PUT',
      cookie: memberJar,
      csrf: member.body.csrfToken,
      json: { address: homeyUrl, token: TOKEN },
    });
    assert.equal(save.status, 403);
    assert.equal(save.body.reason, 'admin_required');
    assert.equal(save.text.includes(TOKEN), false);

    roles.current = 'none';
    const none = await call(base, '/api/extensions/homey/pins', { cookie: 'yuvomi.sid=none' });
    assert.equal(none.status, 403);
    assert.equal(none.body.reason, 'forbidden');
  } finally {
    await close(sidecar);
    await close(homeyServer);
    await close(me.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bad API key is not stored and is not echoed', async () => {
  const homeyServer = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: TOKEN }));
  });
  const me = startMe((req, res) => admin(res));
  const dir = mkdtempSync(path.join(tmpdir(), 'homey-auth-'));
  const homeyUrl = await listen(homeyServer);
  const meUrl = await listen(me.server);
  const sidecar = createHomeyServer({ dataDir: dir, yuvomiUrl: meUrl, allowLoopback: true });
  const base = await listen(sidecar);
  try {
    const first = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=ok' });
    const saved = await call(base, '/api/extensions/homey/connection', {
      method: 'PUT',
      cookie: `yuvomi.sid=ok; ${first.cookie}`,
      csrf: first.body.csrfToken,
      json: { address: homeyUrl, token: TOKEN },
    });
    assert.equal(saved.status, 401);
    assert.equal(saved.body.reason, 'homey_unauthorized');
    assert.equal(saved.text.includes(TOKEN), false);
    const after = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=ok' });
    assert.equal(after.body.configured, false);
  } finally {
    await close(sidecar);
    await close(homeyServer);
    await close(me.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a closed port is reported as refused and the key stays out of the answer', async () => {
  const probe = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const me = startMe((req, res) => admin(res));
  const dir = mkdtempSync(path.join(tmpdir(), 'homey-refused-'));
  await listen(probe);
  const closedPort = probe.address().port;
  await close(probe);
  const meUrl = await listen(me.server);
  const sidecar = createHomeyServer({ dataDir: dir, yuvomiUrl: meUrl, allowLoopback: true });
  const base = await listen(sidecar);
  try {
    const first = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=ok' });
    const saved = await call(base, '/api/extensions/homey/connection', {
      method: 'PUT',
      cookie: `yuvomi.sid=ok; ${first.cookie}`,
      csrf: first.body.csrfToken,
      json: { address: `http://127.0.0.1:${closedPort}`, token: TOKEN },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.reachable, false);
    assert.equal(saved.body.detail, 'refused');
    assert.equal(saved.text.includes(TOKEN), false);
  } finally {
    await close(sidecar);
    await close(me.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a doorbell ring stays up for thirty seconds and a locked tablet can see it', async () => {
  let time = 1_700_000_000_000;
  const roles = { current: 'admin' };
  const me = startMe((req, res) => {
    if (!String(req.headers.cookie || '').includes('yuvomi.sid=')) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    const access = roles.current;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      user: { id: 4, role: access === 'member' ? 'member' : 'admin', display_name: 'Noa' },
      permissions: { modules: { 'ext:homey': access === 'member' ? 'write' : access } },
    }));
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'homey-ring-'));
  const meUrl = await listen(me.server);
  const sidecar = createHomeyServer({
    dataDir: dir,
    yuvomiUrl: meUrl,
    allowLoopback: true,
    now: () => time,
  });
  const base = await listen(sidecar);
  try {
    const missing = await call(base, '/api/extensions/homey/ring');
    assert.equal(missing.status, 409);
    assert.equal(missing.body.reason, 'ring_missing');

    const first = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=ok' });
    const jar = `yuvomi.sid=ok; ${first.cookie}`;
    const created = await call(base, '/api/extensions/homey/ring-token', {
      method: 'POST',
      cookie: jar,
      csrf: first.body.csrfToken,
      json: {},
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const ringToken = created.body.token;
    assert.equal(typeof ringToken, 'string');
    assert.equal(ringToken.length > 20, true);
    const again = await call(base, '/api/extensions/homey/status', { cookie: jar });
    assert.equal(again.body.ringSet, true);
    assert.equal(again.text.includes(ringToken), false);

    const wrong = await call(base, '/api/extensions/homey/ring?token=not-the-token');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.text.includes(ringToken), false);

    const ring = await call(base, `/api/extensions/homey/ring?token=${encodeURIComponent(ringToken)}&text=Inngang`);
    assert.equal(ring.status, 200, JSON.stringify(ring.body));
    assert.equal(ring.text.includes(ringToken), false);
    const seen = await call(base, '/api/extensions/homey/alert', { cookie: jar });
    assert.equal(seen.body.alert.title, 'Inngang');
    assert.equal(seen.body.alert.remainingMs, 30_000);

    roles.current = 'none';
    const tablet = await call(base, '/api/extensions/homey/alert', { cookie: 'yuvomi.sid=tablet' });
    assert.equal(tablet.status, 200, JSON.stringify(tablet.body));
    assert.equal(tablet.body.alert.title, 'Inngang');
    const hidden = await call(base, '/api/extensions/homey/pins', { cookie: 'yuvomi.sid=tablet' });
    assert.equal(hidden.status, 403);

    time += 30_001;
    const gone = await call(base, '/api/extensions/homey/alert', { cookie: jar });
    assert.equal(gone.body.alert, null);

    roles.current = 'member';
    const member = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=member' });
    const refused = await call(base, '/api/extensions/homey/ring-token', {
      method: 'POST',
      cookie: `yuvomi.sid=member; ${member.cookie}`,
      csrf: member.body.csrfToken,
      json: {},
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.reason, 'admin_required');
  } finally {
    await close(sidecar);
    await close(me.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a test button shows the card and the camera stream without ringing', async () => {
  const picture = Buffer.from('camera-frame');
  const camera = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(picture);
  });
  const me = startMe((req, res) => {
    const cookie = String(req.headers.cookie || '');
    if (!cookie.includes('yuvomi.sid=')) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    const role = cookie.includes('yuvomi.sid=member') ? 'member' : 'admin';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      user: { id: role === 'admin' ? 7 : 3, role, display_name: 'Noa' },
      permissions: { modules: { 'ext:homey': 'write' } },
    }));
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'homey-stream-'));
  const meUrl = await listen(me.server);
  const cameraUrl = await listen(camera);
  const sidecar = createHomeyServer({
    dataDir: dir,
    yuvomiUrl: meUrl,
    allowLoopback: true,
  });
  const base = await listen(sidecar);
  try {
    const first = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=ok' });
    const jar = `yuvomi.sid=ok; ${first.cookie}`;
    const closed = await call(base, '/api/extensions/homey/stream', { cookie: jar });
    assert.equal(closed.status, 404);

    const saved = await call(base, '/api/extensions/homey/ring-stream', {
      method: 'PUT',
      cookie: jar,
      csrf: first.body.csrfToken,
      json: { url: `${cameraUrl}/cam/live.jpg`, kind: 'image' },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.streamSet, true);
    const tested = await call(base, '/api/extensions/homey/ring-test', {
      method: 'POST',
      cookie: jar,
      csrf: saved.body.csrfToken,
    });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.alert.test, true);
    assert.equal(tested.body.alert.stream, true);
    assert.equal(tested.body.alert.streamKind, 'image');
    assert.equal(tested.text.includes(cameraUrl), false);

    const viewer = await call(base, '/api/extensions/homey/alert', { cookie: 'yuvomi.sid=member' });
    assert.equal(viewer.status, 200, JSON.stringify(viewer.body));
    assert.equal(viewer.body.alert.stream, true);
    assert.equal(viewer.text.includes(cameraUrl), false);
    const frame = await call(base, '/api/extensions/homey/stream', { cookie: 'yuvomi.sid=member' });
    assert.equal(frame.status, 200, frame.text);
    assert.equal(frame.text, 'camera-frame');

    const status = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=member' });
    assert.equal(status.body.streamUrl, undefined);
    const refused = await call(base, '/api/extensions/homey/ring-test', {
      method: 'POST',
      cookie: `yuvomi.sid=member; ${status.cookie}`,
      csrf: status.body.csrfToken,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.reason, 'admin_required');
    const rtsp = await call(base, '/api/extensions/homey/ring-stream', {
      method: 'PUT',
      cookie: jar,
      csrf: saved.body.csrfToken,
      json: { url: 'rtsp://10.1.1.1/live', kind: 'video' },
    });
    assert.equal(rtsp.status, 400);
    assert.equal(rtsp.body.reason, 'address');
  } finally {
    await close(sidecar);
    await close(camera);
    await close(me.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the doorbell test shows the UniFi picture Homey already has', async () => {
  const snapBytes = Buffer.from('snap-jpeg');
  const homeyBytes = Buffer.from('homey-jpeg');
  const seen = { snap: [], homey: [], decoy: 0 };
  let snapStatus = 200;
  let blank = false;
  let snapHost = '127.0.0.1:9';
  const snap = http.createServer((req, res) => {
    seen.snap.push({ path: req.url, authorization: req.headers.authorization || '' });
    if (snapStatus !== 200) {
      res.writeHead(snapStatus, { 'Content-Type': 'text/plain' });
      res.end('no');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(snapBytes);
  });
  const decoy = http.createServer((req, res) => {
    seen.decoy += 1;
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end('url-frame');
  });
  const homey = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.homey.push({ path: url.pathname, authorization: req.headers.authorization || '' });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const doorbell = blank
      ? { id: 'g6', name: 'UniFi G6 Entry Pro', class: 'doorbell', settings: { password: 'secret-pass' } }
      : {
        id: 'g6',
        name: 'UniFi G6 Entry Pro',
        class: 'doorbell',
        cameraImage: { id: 'img-1', url: 'http://192.168.1.40/secret.jpg' },
        settings: { ip: snapHost, password: 'secret-pass' },
      };
    if (url.pathname === '/api/manager/devices/device/' || url.pathname === '/api/manager/devices/device/g6') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const list = blank ? { g6: doorbell } : {
        g6: doorbell,
        hall: {
          id: 'hallcam',
          name: 'Gang',
          class: 'camera',
          images: [{ imageObj: { id: 'img-2', url: 'http://hidden.example/a.jpg' } }],
        },
        lamp: {
          id: 'lamp',
          name: 'Taklampe',
          class: 'light',
          capabilities: ['onoff'],
          capabilitiesObj: { onoff: { setable: true, type: 'boolean', title: 'På', value: true } },
        },
      };
      res.end(JSON.stringify(url.pathname.endsWith('/g6') ? doorbell : list));
      return;
    }
    if (url.pathname === '/api/image/img-1') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(homeyBytes);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('missing');
  });
  const me = startMe((req, res) => admin(res));
  const dir = mkdtempSync(path.join(tmpdir(), 'homey-g6-'));
  const meUrl = await listen(me.server);
  const snapUrl = await listen(snap);
  const decoyUrl = await listen(decoy);
  const homeyUrl = await listen(homey);
  snapHost = `127.0.0.1:${new URL(snapUrl).port}`;
  const sidecar = createHomeyServer({ dataDir: dir, yuvomiUrl: meUrl, allowLoopback: true });
  const base = await listen(sidecar);
  try {
    const first = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=ok' });
    const jar = `yuvomi.sid=ok; ${first.cookie}`;
    const saved = await call(base, '/api/extensions/homey/connection', {
      method: 'PUT',
      cookie: jar,
      csrf: first.body.csrfToken,
      json: { address: homeyUrl, token: TOKEN },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const listed = await call(base, '/api/extensions/homey/cameras', {
      cookie: jar,
      csrf: saved.body.csrfToken,
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.cameras.map((camera) => camera.id), ['g6', 'hallcam']);
    assert.equal(listed.text.includes('192.168.1.40'), false);
    assert.equal(listed.text.includes(snapHost), false);
    assert.equal(listed.text.includes('secret'), false);
    assert.equal(listed.text.includes('img-1'), false);
    assert.equal(listed.text.includes(TOKEN), false);

    const pasted = await call(base, '/api/extensions/homey/ring-stream', {
      method: 'PUT',
      cookie: jar,
      csrf: listed.body.csrfToken,
      json: { url: `${decoyUrl}/live.jpg`, kind: 'image' },
    });
    assert.equal(pasted.status, 200, JSON.stringify(pasted.body));
    const tested = await call(base, '/api/extensions/homey/ring-test', {
      method: 'POST',
      cookie: jar,
      csrf: pasted.body.csrfToken,
      json: { cameraId: '' },
    });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.feed, 'camera');
    assert.equal(tested.body.alert.stream, true);
    assert.equal(tested.body.alert.streamKind, 'image');
    assert.equal(tested.body.alert.test, true);
    assert.equal(tested.text.includes(TOKEN), false);
    assert.equal(tested.text.includes(snapHost), false);
    assert.equal(tested.text.includes('img-1'), false);
    const frame = await call(base, '/api/extensions/homey/stream', { cookie: jar });
    assert.equal(frame.status, 200, frame.text);
    assert.equal(frame.text, 'snap-jpeg');
    assert.equal(seen.decoy, 0);
    assert.equal(seen.snap.every((hit) => hit.authorization === ''), true);
    assert.equal(seen.homey.some((hit) => hit.path === '/api/image/img-1'), false);

    snapStatus = 404;
    const again = await call(base, '/api/extensions/homey/ring-test', {
      method: 'POST',
      cookie: jar,
      csrf: tested.body.csrfToken,
      json: {},
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const before = seen.snap.length;
    const fallback = await call(base, '/api/extensions/homey/stream', { cookie: jar });
    assert.equal(fallback.status, 200, fallback.text);
    assert.equal(fallback.text, 'homey-jpeg');
    assert.equal(seen.snap.length, before + 1);
    assert.equal(seen.snap.at(-1).authorization, '');
    const imageHits = seen.homey.filter((hit) => hit.path === '/api/image/img-1');
    assert.equal(imageHits.length, 1);
    assert.equal(imageHits[0].authorization, `Bearer ${TOKEN}`);
    const second = await call(base, '/api/extensions/homey/stream', { cookie: jar });
    assert.equal(second.text, 'homey-jpeg');
    assert.equal(seen.snap.length, before + 1);

    blank = true;
    const cleared = await call(base, '/api/extensions/homey/ring-stream', {
      method: 'PUT',
      cookie: jar,
      csrf: again.body.csrfToken,
      json: { url: '', kind: 'image' },
    });
    const quiet = await call(base, '/api/extensions/homey/ring-test', {
      method: 'POST',
      cookie: jar,
      csrf: cleared.body.csrfToken,
      json: { cameraId: '' },
    });
    assert.equal(quiet.status, 200, JSON.stringify(quiet.body));
    assert.equal(quiet.body.feed, 'none');
    assert.equal(quiet.body.alert.test, true);
    assert.equal(quiet.body.alert.stream, false);
  } finally {
    await close(sidecar);
    await close(homey);
    await close(snap);
    await close(decoy);
    await close(me.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a doorbell address reports when the data folder cannot be written', async () => {
  const me = startMe((req, res) => admin(res));
  const dir = mkdtempSync(path.join(tmpdir(), 'homey-ring-ro-'));
  const meUrl = await listen(me.server);
  const sidecar = createHomeyServer({ dataDir: dir, yuvomiUrl: meUrl, allowLoopback: true });
  const base = await listen(sidecar);
  try {
    chmodSync(dir, 0o555);
    const first = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=ok' });
    const created = await call(base, '/api/extensions/homey/ring-token', {
      method: 'POST',
      cookie: `yuvomi.sid=ok; ${first.cookie}`,
      csrf: first.body.csrfToken,
      json: {},
    });
    assert.equal(created.status, 503, JSON.stringify(created.body));
    assert.equal(created.body.reason, 'store');
  } finally {
    chmodSync(dir, 0o700);
    await close(sidecar);
    await close(me.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gateway serves Homey itself and forwards everything else', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ path: req.url, encoding: req.headers['accept-encoding'] || '' });
    if (req.url === '/app') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><p>Yuvomi</p></body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('from-yuvomi');
  });
  const me = startMe((req, res) => admin(res));
  const dir = mkdtempSync(path.join(tmpdir(), 'homey-gw-'));
  const upstreamUrl = await listen(upstream);
  const meUrl = await listen(me.server);
  const gateway = createGateway({
    upstream: upstreamUrl,
    yuvomiUrl: meUrl,
    dataDir: dir,
    allowLoopback: true,
  });
  const base = await listen(gateway);
  try {
    const forwarded = await fetch(`${base}/health`);
    assert.equal(await forwarded.text(), 'from-yuvomi');
    const page = await fetch(`${base}/app`, {
      headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'document', 'Accept-Encoding': 'gzip' },
    });
    const html = await page.text();
    assert.match(html, /\/homey-alert\.js/);
    const script = await fetch(`${base}/homey-alert.js`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /startDoorbellWatch/);
    assert.equal(seen.find((item) => item.path === '/app').encoding, '');
    const status = await call(base, '/api/extensions/homey/status', { cookie: 'yuvomi.sid=ok' });
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, false);
    const created = await call(base, '/api/extensions/homey/ring-token', {
      method: 'POST',
      cookie: `yuvomi.sid=ok; ${status.cookie}`,
      csrf: status.body.csrfToken,
      json: {},
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(typeof created.body.token, 'string');
    assert.equal(created.body.token.length > 20, true);
  } finally {
    await close(gateway);
    await close(upstream);
    await close(me.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Yuvomi accepts the Homey manifest', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'homey-manifest-'));
  const dbPath = path.join(dir, 'manifest.db');
  const script = `
    const svc = await import(${JSON.stringify(pathToFileURL(path.join(root, 'server/services/modules.js')).href)});
    const mods = await svc.listModules({ admin: true });
    const homey = mods.find((mod) => mod.id === 'homey');
    if (!homey) throw new Error('homey missing from ' + mods.map((mod) => mod.id).join(','));
    if (homey.status !== 'enabled') throw new Error(homey.error || homey.status);
    if (homey.capabilities?.apiPrefix !== '/api/extensions/homey') throw new Error('prefix ' + homey.capabilities?.apiPrefix);
    if (homey.route?.path !== '/m/homey') throw new Error('route ' + homey.route?.path);
    if (!homey.i18n?.availableLocales?.includes('nb')) throw new Error('locales ' + homey.i18n?.availableLocales);
    console.log('manifest-ok');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_PATH: dbPath,
      DB_ENCRYPTION_KEY: '',
      MODULES_DIR: path.join(root, 'modules'),
      SESSION_SECRET: 'manifest-check-secret-manifest-check-secret',
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /manifest-ok/);
  rmSync(dir, { recursive: true, force: true });
});
