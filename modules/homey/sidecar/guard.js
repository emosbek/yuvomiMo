/**
 * Address check for the household's Homey.
 *
 * Homey Pro lives on the LAN, often at a private address or a `.local` name.
 * Yuvomi's own outbound guard blocks those on purpose. This check is narrower:
 * the saved address may be a private host, and nothing else. Link-local
 * metadata, loopback, non-HTTP schemes and unresolved names stay closed.
 * Loopback opens only when `allowLoopback` is set, which the test suite uses.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
]) {
  blocked.addSubnet(address, prefix, type);
}

const BLOCKED_NAMES = new Set([
  'metadata.google.internal',
  'metadata.google.com',
  'metadata',
]);

export class GuardError extends Error {
  constructor(detail) {
    super('Address is not allowed.');
    this.status = 400;
    this.reason = 'address';
    this.detail = detail;
  }
}

function unwrapMapped(ip) {
  const lower = String(ip).toLowerCase();
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return dotted ? dotted[1] : lower;
}

function isLoopback(ip) {
  const value = unwrapMapped(ip);
  return value === '::1' || value.startsWith('127.');
}

function isBlocked(ip) {
  const value = unwrapMapped(ip);
  const kind = isIP(value);
  if (!kind) return true;
  return blocked.check(value, kind === 6 ? 'ipv6' : 'ipv4');
}

/**
 * @param {string} input
 * @param {{ allowLoopback?: boolean, lookupImpl?: Function }} [opts]
 * @returns {Promise<{ origin: string, connectHost: string, hostname: string, protocol: string, port: string }>}
 */
export async function inspectAddress(input, { allowLoopback = false, lookupImpl = dnsLookup } = {}) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new GuardError('scheme');
  }
  if (url.username || url.password) throw new GuardError('userinfo');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GuardError('scheme');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new GuardError('path');

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || BLOCKED_NAMES.has(host)) throw new GuardError('blocked');
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) throw new GuardError('blocked');
  if (/^\d+(\.\d+){1,3}$/.test(host) && isIP(host) === 0) throw new GuardError('blocked');
  if (host === 'localhost' && !allowLoopback) throw new GuardError('loopback');

  const literal = isIP(host);
  let ips;
  if (literal) {
    ips = [host];
  } else {
    let records;
    try {
      records = await lookupImpl(host, { all: true, verbatim: true });
    } catch {
      throw new GuardError('resolve');
    }
    ips = (Array.isArray(records) ? records : [records])
      .map((record) => record?.address)
      .filter(Boolean);
    if (!ips.length) throw new GuardError('resolve');
  }

  for (const ip of ips) {
    if (isLoopback(ip)) {
      if (!allowLoopback) throw new GuardError('loopback');
      continue;
    }
    if (isBlocked(ip)) throw new GuardError('blocked');
  }

  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return {
    origin: `${url.protocol}//${url.host}`,
    connectHost: unwrapMapped(ips[0]),
    hostname: host,
    protocol: url.protocol,
    port,
  };
}

/**
 * A camera stream may have a path and a query. The host is checked the same
 * way as a Homey address. The browser never sees this URL: the gateway fetches
 * it and only while a doorbell card is on screen.
 */
export async function inspectStreamUrl(input, opts = {}) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 2000) throw new GuardError('blocked');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new GuardError('scheme');
  }
  if (url.username || url.password) throw new GuardError('userinfo');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GuardError('scheme');
  const checked = await inspectAddress(`${url.protocol}//${url.host}`, opts);
  return {
    ...checked,
    path: `${url.pathname || '/'}${url.search}`,
    hostHeader: url.host,
  };
}
