/**
 * Homey Pro local Web API.
 *
 * Documented calls used here:
 *   GET  /api/manager/devices/device/
 *   PUT  /api/manager/devices/device/:deviceId/capability/:capabilityId   { value }
 *   GET  /api/manager/flow/flow/
 *   POST /api/manager/flow/flow/:id/trigger
 *   GET  /api/manager/flow/advancedflow/
 *   POST /api/manager/flow/advancedflow/:id/trigger
 *   GET  /webhook?event=&tag=
 *
 * The bearer token is sent only to the saved Homey origin. Webhooks are the
 * unauthenticated trigger Homey documents for flow cards, still on that origin.
 * HTTP calls connect to the address that passed the guard, so a later DNS
 * answer cannot move the request onto a metadata address.
 */

import http from 'node:http';
import https from 'node:https';
import { inspectAddress } from './guard.js';

const NETWORK_DETAILS = new Set(['timeout', 'noroute', 'refused']);

export function classifyNetworkError(err) {
  const code = err?.code;
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'ENETDOWN') return 'noroute';
  return 'timeout';
}

export class HomeyRequestError extends Error {
  constructor(homeyStatus, detail = null) {
    const unauthorized = homeyStatus === 401 || homeyStatus === 403;
    super(unauthorized ? 'Homey rejected the API key.' : 'Homey could not be reached.');
    this.status = unauthorized ? 401 : 502;
    this.reason = unauthorized ? 'homey_unauthorized' : 'homey_unreachable';
    this.homeyStatus = homeyStatus;
    this.detail = !unauthorized && NETWORK_DETAILS.has(detail) ? detail : null;
  }
}

function requestOnce({ target, token, method, path, body, auth }) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = {
    Accept: 'application/json',
    Host: new URL(target.origin).host,
  };
  if (auth !== false && token) headers.Authorization = `Bearer ${token}`;
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(payload.length);
  }
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (detail) => {
      if (settled) return;
      settled = true;
      reject(new HomeyRequestError(0, detail));
    };
    const req = lib.request({
      host: target.connectHost,
      port: target.port,
      method,
      path,
      headers,
      servername: target.hostname,
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      fail('timeout');
    });
    req.on('error', (err) => fail(classifyNetworkError(err)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function call(target, token, path, { method = 'GET', body, auth = true } = {}) {
  let res;
  try {
    res = await requestOnce({ target, token, method, path, body, auth });
  } catch (err) {
    if (err instanceof HomeyRequestError) throw err;
    throw new HomeyRequestError(0);
  }
  if (res.status >= 300 && res.status < 400) throw new HomeyRequestError(0);
  if (res.status < 200 || res.status >= 300) throw new HomeyRequestError(res.status);
  if (!res.body) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return Object.values(data);
  return [];
}

function text(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object') {
    for (const key of ['nb', 'no', 'nn', 'en', 'de']) {
      if (typeof value[key] === 'string' && value[key]) return value[key];
    }
    const first = Object.values(value).find((item) => typeof item === 'string' && item);
    if (typeof first === 'string') return first;
  }
  return fallback;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function capabilityRank(id) {
  if (id === 'onoff') return 0;
  if (id === 'button') return 1;
  if (id === 'dim' || id.startsWith('dim.')) return 2;
  return 3;
}

function capabilityList(device) {
  const obj = device.capabilitiesObj && typeof device.capabilitiesObj === 'object'
    ? device.capabilitiesObj
    : {};
  const ids = Array.isArray(device.capabilities) ? device.capabilities : Object.keys(obj);
  return ids.map((id) => {
    const cap = obj[id] && typeof obj[id] === 'object' ? obj[id] : null;
    if (!cap || cap.setable !== true) return null;
    const values = Array.isArray(cap.values)
      ? cap.values
        .map((entry) => {
          if (entry == null) return null;
          if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
            return { id: String(entry), title: String(entry) };
          }
          if (typeof entry === 'object' && entry.id != null) {
            return { id: String(entry.id), title: text(entry.title, String(entry.id)) };
          }
          return null;
        })
        .filter(Boolean)
        .slice(0, 20)
      : [];
    return {
      id: String(id),
      title: text(cap.title, String(id)),
      type: String(cap.type || ''),
      value: cap.value === undefined ? null : cap.value,
      units: text(cap.units),
      min: finite(cap.min),
      max: finite(cap.max),
      step: finite(cap.step),
      values,
    };
  }).filter((cap) => cap && cap.id && cap.id.length <= 120)
    .sort((a, b) => capabilityRank(a.id) - capabilityRank(b.id) || a.title.localeCompare(b.title, 'nb'));
}

export function normalizeDevices(data) {
  return asList(data)
    .filter((device) => device && device.id)
    .map((device) => ({
      id: String(device.id),
      name: text(device.name, String(device.id)),
      zone: text(device.zoneName),
      zoneId: typeof device.zone === 'string' ? device.zone : '',
      deviceClass: typeof device.class === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(device.class)
        ? device.class.toLowerCase()
        : '',
      capabilities: capabilityList(device),
    }))
    .filter((device) => device.capabilities.length > 0);
}

export function normalizeZones(data) {
  return asList(data)
    .filter((zone) => zone && zone.id)
    .map((zone) => ({
      id: String(zone.id),
      name: text(zone.name, String(zone.id)),
    }));
}

export function withZoneNames(devices, zones) {
  const names = new Map((zones || []).map((zone) => [zone.id, zone.name]));
  return devices.map((device) => {
    const { zoneId, ...rest } = device;
    return { ...rest, zone: device.zone || names.get(zoneId) || '' };
  });
}

const CAMERA_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const IMAGE_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const SNAPSHOT_HOST_RE = /^([A-Za-z0-9.-]{1,253})(?::([0-9]{1,5}))?$/;

function imageIdOf(device) {
  const direct = device?.cameraImage?.id;
  if (typeof direct === 'string' && direct) return direct;
  const images = Array.isArray(device?.images) ? device.images : [];
  for (const image of images) {
    const id = image?.imageObj?.id || image?.id;
    if (typeof id === 'string' && id) return id;
  }
  return '';
}

function snapshotHost(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return '';
  for (const key of ['ip', 'address', 'host', 'hostname', 'camera_ip']) {
    const value = settings[key];
    if (typeof value !== 'string') continue;
    const host = value.trim();
    const match = SNAPSHOT_HOST_RE.exec(host);
    if (!match) continue;
    const port = match[2] ? Number(match[2]) : 80;
    if (port < 1 || port > 65535) continue;
    return host;
  }
  return '';
}

function cameraClass(device) {
  return typeof device?.class === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(device.class)
    ? device.class.toLowerCase()
    : '';
}

function isCameraDevice(device) {
  const kind = cameraClass(device);
  return kind === 'doorbell' || kind === 'camera' || Boolean(imageIdOf(device));
}

/**
 * Doorbells and cameras, including those with no setable control.
 * The browser gets a name and whether a picture exists. It does not get the
 * image address, the camera IP, or anything from device settings.
 */
export function normalizeCameras(data) {
  return asList(data)
    .filter((device) => device && device.id && isCameraDevice(device))
    .map((device) => {
      const id = String(device.id);
      if (!CAMERA_ID_RE.test(id)) return null;
      const kind = cameraClass(device);
      return {
        id,
        name: text(device.name, id).slice(0, 120),
        deviceClass: kind === 'doorbell' || kind === 'camera' ? kind : 'camera',
        image: Boolean(imageIdOf(device)),
        snapshot: Boolean(snapshotHost(device.settings)),
      };
    })
    .filter(Boolean);
}

export function cameraSource(device) {
  if (!device || !device.id || !CAMERA_ID_RE.test(String(device.id))) return null;
  const imageId = imageIdOf(device);
  const host = snapshotHost(device.settings);
  return {
    id: String(device.id),
    imageId: IMAGE_ID_RE.test(imageId) ? imageId : '',
    snapshotUrl: host ? `http://${host}/snap.jpeg` : '',
  };
}

export function pickCamera(cameras) {
  const usable = (cameras || []).filter((camera) => camera && (camera.image || camera.snapshot));
  return usable.find((camera) => camera.deviceClass === 'doorbell')
    || usable.find((camera) => /g6|entry|doorbell|dør|ring/i.test(camera.name || ''))
    || usable.find((camera) => camera.deviceClass === 'camera')
    || usable[0]
    || null;
}

export function normalizeFlows(data) {
  return asList(data)
    .filter((flow) => flow && flow.id && flow.enabled !== false && flow.triggerable !== false)
    .map((flow) => ({
      id: String(flow.id),
      name: String(flow.name || flow.id),
    }));
}

export function createHomeyClient({ allowLoopback = false, lookupImpl } = {}) {
  async function targetFor(address) {
    return inspectAddress(address, { allowLoopback, lookupImpl });
  }

  return {
    targetFor,
    async devices(address, token) {
      const data = await call(await targetFor(address), token, '/api/manager/devices/device/');
      return normalizeDevices(data);
    },
    async cameras(address, token) {
      const data = await call(await targetFor(address), token, '/api/manager/devices/device/');
      return normalizeCameras(data);
    },
    async camera(address, token, deviceId) {
      const target = await targetFor(address);
      try {
        const data = await call(target, token, `/api/manager/devices/device/${encodeURIComponent(deviceId)}`);
        const source = cameraSource(data);
        if (source && (source.imageId || source.snapshotUrl)) return source;
      } catch (err) {
        if (err?.reason === 'homey_unauthorized') throw err;
      }
      const data = await call(target, token, '/api/manager/devices/device/');
      const found = asList(data).find((device) => device && String(device.id) === String(deviceId));
      return cameraSource(found);
    },
    async zones(address, token) {
      try {
        const data = await call(await targetFor(address), token, '/api/manager/zones/zone/');
        return normalizeZones(data);
      } catch {
        return [];
      }
    },
    async flows(address, token) {
      const data = await call(await targetFor(address), token, '/api/manager/flow/flow/');
      return normalizeFlows(data);
    },
    async advancedFlows(address, token) {
      const data = await call(await targetFor(address), token, '/api/manager/flow/advancedflow/');
      return normalizeFlows(data);
    },
    setCapability(address, token, deviceId, capabilityId, value) {
      const path = `/api/manager/devices/device/${encodeURIComponent(deviceId)}/capability/${encodeURIComponent(capabilityId)}`;
      return targetFor(address).then((target) => call(target, token, path, { method: 'PUT', body: { value } }));
    },
    triggerFlow(address, token, flowId, advanced) {
      const root = advanced ? 'advancedflow' : 'flow';
      const path = `/api/manager/flow/${root}/${encodeURIComponent(flowId)}/trigger`;
      return targetFor(address).then((target) => call(target, token, path, { method: 'POST', body: {} }));
    },
    webhook(address, event, tag) {
      const query = `event=${encodeURIComponent(event)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`;
      return targetFor(address).then((target) => call(target, null, `/webhook?${query}`, { auth: false }));
    },
  };
}
