/**
 * The module's own state. Never yuvomi.db.
 * The API key is written here and is not returned by any route.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_PINS = 48;

function empty() {
  return {
    version: 1,
    address: null,
    token: null,
    ringToken: null,
    streamUrl: null,
    streamKind: 'video',
    cameraId: null,
    pins: [],
  };
}

function readState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty();
    return {
      version: 1,
      address: typeof parsed.address === 'string' ? parsed.address : null,
      token: typeof parsed.token === 'string' ? parsed.token : null,
      ringToken: typeof parsed.ringToken === 'string' ? parsed.ringToken : null,
      streamUrl: typeof parsed.streamUrl === 'string' ? parsed.streamUrl : null,
      streamKind: parsed.streamKind === 'image' ? 'image' : 'video',
      cameraId: typeof parsed.cameraId === 'string' && parsed.cameraId ? parsed.cameraId : null,
      pins: Array.isArray(parsed.pins)
        ? parsed.pins.filter((pin) => pin && typeof pin.id === 'string')
        : [],
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return empty();
    throw err;
  }
}

export function createStore(dir) {
  const file = path.join(dir, 'state.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* a read-only mount still fails at write time */ }
  let state = readState(file);
  let queue = Promise.resolve();

  function persist() {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  }

  function mutate(fn) {
    const run = queue.then(() => {
      state = fn(state) || state;
      persist();
      return state;
    });
    queue = run.then(() => {}, () => {});
    return run;
  }

  return {
    maxPins: MAX_PINS,
    snapshot() {
      return {
        address: state.address,
        token: state.token,
        ringToken: state.ringToken,
        streamUrl: state.streamUrl,
        streamKind: state.streamKind === 'image' ? 'image' : 'video',
        cameraId: state.cameraId,
        pins: state.pins.map((pin) => ({ ...pin })),
      };
    },
    connection() {
      return {
        configured: Boolean(state.address && state.token),
        address: state.address,
        tokenSet: Boolean(state.token),
        ringSet: Boolean(state.ringToken),
        streamSet: Boolean(state.streamUrl),
        streamKind: state.streamKind === 'image' ? 'image' : 'video',
      };
    },
    setRingToken(ringToken) {
      return mutate((current) => ({ ...current, ringToken }));
    },
    clearRingToken() {
      return mutate((current) => ({ ...current, ringToken: null }));
    },
    setStream({ url, kind }) {
      return mutate((current) => ({
        ...current,
        streamUrl: url || null,
        streamKind: kind === 'image' ? 'image' : 'video',
      }));
    },
    setCamera(cameraId) {
      return mutate((current) => ({ ...current, cameraId: cameraId || null }));
    },
    saveConnection({ address, token }) {
      return mutate((current) => ({ ...current, address, token }));
    },
    clearConnection() {
      return mutate((current) => ({ ...current, address: null, token: null }));
    },
    addPin(pin) {
      return mutate((current) => {
        if (current.pins.length >= MAX_PINS) {
          const err = new Error('Too many pins.');
          err.status = 400;
          err.reason = 'limit';
          throw err;
        }
        const next = { ...pin, id: randomUUID(), createdAt: new Date().toISOString() };
        return { ...current, pins: [...current.pins, next] };
      }).then((next) => next.pins[next.pins.length - 1]);
    },
    removePin(id) {
      return mutate((current) => ({
        ...current,
        pins: current.pins.filter((pin) => pin.id !== id),
      }));
    },
  };
}
