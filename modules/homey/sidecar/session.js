/**
 * Identity comes from Yuvomi. The browser is not a trusted caller:
 * every request is checked against GET /api/v1/auth/me, and that answer
 * is cached for a few seconds so the module does not spend the shared
 * /api/ rate limit on itself.
 */

import { createHash } from 'node:crypto';

const MODULE_KEY = 'ext:homey';

export function moduleAccess(session) {
  const raw = session?.permissions?.modules?.[MODULE_KEY];
  if (raw === 'none' || raw === 'read' || raw === 'write') return raw;
  return 'write';
}

export function createSessionResolver({
  yuvomiUrl,
  fetchImpl = globalThis.fetch,
  ttlMs = 5000,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();

  return async function resolveSession(cookie) {
    if (!cookie || typeof cookie !== 'string') return null;
    const key = createHash('sha256').update(cookie).digest('hex');
    const time = now();
    const hit = cache.get(key);
    if (hit && hit.exp > time) return hit.value;

    let res;
    try {
      res = await fetchImpl(new URL('/api/v1/auth/me', yuvomiUrl), {
        headers: { Accept: 'application/json', Cookie: cookie },
        redirect: 'manual',
      });
    } catch {
      const err = new Error('Yuvomi did not answer.');
      err.status = 503;
      err.reason = 'upstream';
      throw err;
    }
    if (!res || res.status !== 200) return null;
    const body = await res.json();
    const user = body?.user;
    if (!user || (typeof user.id !== 'number' && typeof user.id !== 'string')) return null;
    const value = {
      id: user.id,
      role: user.role === 'admin' ? 'admin' : 'member',
      permissions: body.permissions && typeof body.permissions === 'object' ? body.permissions : {},
    };
    cache.set(key, { exp: time + ttlMs, value });
    return value;
  };
}
