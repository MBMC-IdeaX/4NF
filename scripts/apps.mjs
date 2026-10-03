// Builds or serves the five independent builds: the site, the Rider, Crew
// and Owner apps, and the Staff console (see vite.config.js).
//
//   node scripts/apps.mjs build            all four into dist/
//   node scripts/apps.mjs build crew       one of them
//   node scripts/apps.mjs dev              four dev servers; open the site's
//                                          port, it proxies /app, /crew, /owner, /staff
//
// The site is built first because it owns dist/ and empties it.

import { spawn } from 'node:child_process';

const ALL = ['site', 'rider', 'crew', 'owner', 'staff'];
const [command = 'build', ...names] = process.argv.slice(2);
const apps = names.length ? names : ALL;
for (const name of apps) {
  if (!ALL.includes(name)) throw new Error(`unknown app ${name}; one of ${ALL.join(', ')}`);
}

function run(name, args) {
  return spawn('npx', ['vite', ...args], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, BHADA_APP: name },
  });
}

if (command === 'build') {
  const ordered = ALL.filter((name) => apps.includes(name));
  for (const name of ordered) {
    const code = await new Promise((resolve) => run(name, ['build']).on('exit', resolve));
    if (code !== 0) process.exit(code ?? 1);
  }
} else if (command === 'dev') {
  const children = apps.map((name) => run(name, []));
  const stop = () => { for (const child of children) child.kill(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  throw new Error(`unknown command ${command}; build or dev`);
}
