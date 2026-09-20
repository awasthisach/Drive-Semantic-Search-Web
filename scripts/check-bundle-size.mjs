#!/usr/bin/env node
/**
 * Fails if production dist JS bundles exceed budget (bytes, uncompressed).
 * Tune MAX_TOTAL_JS if intentional growth is needed.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const MAX_TOTAL_JS = 2_500_000; // ~2.5 MB uncompressed JS across assets
const MAX_SINGLE_JS = 1_200_000; // single chunk soft cap

if (!existsSync(DIST)) {
  console.error('dist/ missing — run npm run build first');
  process.exit(1);
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith('.js')) acc.push({ path: p, size: st.size });
  }
  return acc;
}

const files = walk(DIST);
const total = files.reduce((s, f) => s + f.size, 0);
const biggest = files.slice().sort((a, b) => b.size - a.size)[0];

console.log('JS bundles:');
for (const f of files.sort((a, b) => b.size - a.size).slice(0, 8)) {
  console.log(`  ${(f.size / 1024).toFixed(1)} KB  ${f.path}`);
}
console.log(`Total JS: ${(total / 1024).toFixed(1)} KB (budget ${(MAX_TOTAL_JS / 1024).toFixed(0)} KB)`);

if (biggest && biggest.size > MAX_SINGLE_JS) {
  console.error(`Single chunk too large: ${biggest.path} (${(biggest.size / 1024).toFixed(1)} KB > ${(MAX_SINGLE_JS / 1024).toFixed(0)} KB)`);
  process.exit(1);
}
if (total > MAX_TOTAL_JS) {
  console.error(`Total JS exceeds budget: ${(total / 1024).toFixed(1)} KB > ${(MAX_TOTAL_JS / 1024).toFixed(0)} KB`);
  process.exit(1);
}
console.log('Bundle size OK');
