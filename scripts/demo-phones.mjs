// Local-only orchestration; reuses dev-phone HTTPS and the five-app runner.
import { spawn, spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { access } from 'node:fs/promises';

const backendPort = Number(process.env.BHADA_DEMO_BACKEND_PORT ?? 8787);
const offset = Number(process.env.BHADA_DEMO_PORT_OFFSET ?? 0);
const ports = [backendPort, ...[5199, 5201, 5202, 5203, 5204].map((port) => port + offset)];
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
function start(script) {
  const child = spawn(process.execPath, [script], { stdio: 'inherit', windowsHide: true, env: { ...process.env, PORT: String(backendPort), BHADA_LOCAL_DB: '1', BHADA_LOCAL_BACKEND: `http://localhost:${backendPort}`, VITE_SYNC_URL: '/sync', VITE_LOCAL_DB_URL: '/' } });
  children.push(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { if (!stopping) { console.error(`${script} exited unexpectedly (${code}).`); stop(1); } });
}
async function free(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied. Stop its existing server before starting demo:phones.`)));
    server.listen(port, () => server.close(resolve));
  });
}
async function httpsReady(port) {
  return new Promise((resolve) => {
    // Trust only this loopback request's development certificate.
    const req = request({ hostname: 'localhost', port, path: '/', rejectUnauthorized: false, timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}
async function waitFor(check, label) {
  const deadline = Date.now() + 60000;
  while (!stopping && Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready within 60 seconds.`);
}
try {
  await access('node_modules/vite/bin/vite.js');
  await access('node_modules/@electric-sql/pglite/package.json');
  await access('node_modules/@vitejs/plugin-basic-ssl/package.json');
  const ips = Object.values(networkInterfaces()).flat().filter((n) => n?.family === 'IPv4' && !n.internal).map((n) => n.address);
  if (!ips.length) throw new Error('No LAN IPv4 address found. Connect to Wi-Fi and retry.');
  for (const port of ports) await free(port);
  start('scripts/local-sync-server.mjs');
  await waitFor(async () => { try { const response = await fetch(`http://localhost:${backendPort}/health`, { signal: AbortSignal.timeout(1000) }); return (await response.json()).local === true; } catch { return false; } }, 'Local backend');
  start('scripts/dev-phone.mjs');
  for (const port of ports.slice(1)) await waitFor(() => httpsReady(port), `App server :${port}`);
  console.log('\nLOCAL DEMO READY - no live backend, data preserved.');
  for (const ip of ips) for (const [role, path] of [['Site', '/'], ['Rider', '/app/'], ['Crew', '/crew/'], ['Owner', '/owner/'], ['Staff', '/staff/']]) console.log(`${role}: https://${ip}:${ports[1]}${path}`);
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Dependencies missing. Run npm ci, then npm run demo:phones.' : error.message);
  stop(1);
}
