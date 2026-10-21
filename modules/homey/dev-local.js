/**
 * Start Yuvomi and the Homey gateway on this computer.
 * The browser uses http://127.0.0.1:3000. Homey calls leave from this machine,
 * so it has to be on the same network as Homey.
 *
 *   npm run dev:homey
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const yuvomiPort = process.env.YUVOMI_PORT || '3001';
const gatewayPort = process.env.HOMEY_GATEWAY_PORT || '3000';
const upstream = `http://127.0.0.1:${yuvomiPort}`;

const children = [];
let stopping = false;

function start(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  children.push(child);
  return child;
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode == null && child.pid) child.kill('SIGTERM');
  }
}

const yuvomi = start(['--import', 'dotenv/config', '--watch', 'server/index.js'], {
  PORT: yuvomiPort,
});
const gateway = start(['modules/homey/gateway.js'], {
  HOMEY_GATEWAY_PORT: gatewayPort,
  YUVOMI_UPSTREAM: upstream,
  YUVOMI_INTERNAL_URL: upstream,
});

for (const child of [yuvomi, gateway]) {
  child.on('exit', (code) => {
    if (stopping) return;
    stop();
    process.exit(code == null ? 1 : code);
  });
}

process.on('SIGINT', () => { stop(); });
process.on('SIGTERM', () => { stop(); });
console.log(`Homey dev server: http://127.0.0.1:${gatewayPort}  (Yuvomi on ${upstream})`);
