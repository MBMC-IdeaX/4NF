// Every app, served to phones on the same Wi-Fi, against the local backend.
//
//   npm run sync:local      (first terminal: the local backend on :8787)
//   npm run dev:phone       (second terminal: this)
//
// Phones only allow the camera and GPS on HTTPS, so this keeps the dev
// server's self-signed certificate on. The apps call the backend at /sync and
// /local/* on the same address, and the dev server passes those to :8787, so
// nothing the phones do can reach the live database.

import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const env = {
  ...process.env,
  BHADA_LOCAL_DB: '1',
  VITE_SYNC_URL: '/sync',
  VITE_LOCAL_DB_URL: '/',
};
delete env.BHADA_HTTP;

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((net) => net && net.family === 'IPv4' && !net.internal)
  .map((net) => net.address);

console.log('\nOpen on each phone (same Wi-Fi), and accept the certificate warning once:');
for (const ip of addresses) console.log(`  https://${ip}:${5199 + Number(process.env.BHADA_DEMO_PORT_OFFSET ?? 0)}`);
console.log('\nLocal demo backend: ' + (env.BHADA_LOCAL_BACKEND || 'http://localhost:8787') + '\n');

const child = spawn(process.execPath, ['scripts/apps.mjs', 'dev'], { stdio: 'inherit', env });
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => process.exit(code ?? 0));
