// Starts an isolated local demo, checks all role links, and stops its tree.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const dataDir = resolve('.bench', `demo-smoke-${Date.now()}`);
await mkdir(dataDir, { recursive: true });
const child = spawn(process.execPath, ['scripts/demo-phones.mjs'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BHADA_LOCAL_DATA_DIR: dataDir, BHADA_DEMO_BACKEND_PORT: '8891', BHADA_DEMO_PORT_OFFSET: '200' } });
let output = '';
let done = false;
const stop = () => {
  if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
};
const timer = setTimeout(() => { console.error(output); console.error('Demo readiness timed out.'); stop(); process.exitCode = 1; }, 90000);
child.stdout.on('data', (data) => {
  output += data;
  if (!done && /Staff: https:/.test(output)) {
    done = true;
    clearTimeout(timer);
    console.log('PASS: backend and all five HTTPS app servers ready; role links printed.');
    stop();
  }
});
child.stderr.on('data', (data) => { output += data; });
child.on('error', (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { if (!done) { clearTimeout(timer); console.error(output); process.exitCode = code || 1; } });
