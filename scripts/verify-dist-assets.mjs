#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = 'dist';
const entry = join(DIST, 'index.html');
if (!existsSync(entry)) {
  console.error('dist/index.html is missing — run npm run build first');
  process.exit(1);
}

const queue = [];
const visited = new Set();
const missing = [];
const html = readFileSync(entry, 'utf8');
for (const match of html.matchAll(/(?:src|href)=["'](\.?\/[^"']+)["']/g)) {
  const ref = match[1].split(/[?#]/, 1)[0];
  if (ref.endsWith('.js')) queue.push(ref);
}

while (queue.length) {
  const ref = queue.shift();
  const file = join(DIST, ref.replace(/^\.\//, ''));
  if (visited.has(file)) continue;
  visited.add(file);
  if (!existsSync(file)) {
    missing.push(ref);
    continue;
  }
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:import\s*\(|from\s*)["'](\.?\/[^"']+\.js)["']/g)) {
    const child = match[1].split(/[?#]/, 1)[0];
    const childFile = join(DIST, relative(DIST, join(file, '..', child)));
    const childRef = './' + relative(DIST, childFile).replaceAll('\\', '/');
    if (!visited.has(childFile)) queue.push(childRef);
  }
}

console.log(`Verified ${visited.size} JavaScript asset(s) from dist/index.html`);
if (missing.length) {
  console.error('Missing JavaScript assets:');
  for (const ref of missing) console.error(`  ${ref}`);
  process.exit(1);
}
console.log('Production asset graph is complete');
