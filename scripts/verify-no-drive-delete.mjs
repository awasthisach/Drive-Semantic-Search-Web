import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const ROOTS = ['src', 'workers', 'scripts'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) out.push(path);
  }
  return out;
}
const files = (await Promise.all(ROOTS.map(walk))).flat();
const forbidden = [
  { re: /\/trash(?:[?/'"]|$)/i, label: 'Drive trash endpoint' },
  { re: /files\.delete\b/i, label: 'Drive files.delete API call' },
  { re: /method:\s*['"]DELETE['"]/i, label: 'HTTP DELETE mutation' },
  { re: /trashed\s*:\s*true/i, label: 'Drive trash mutation payload' },
];
const hits = [];
for (const file of files) {
  const text = await readFile(file, 'utf8');
  for (const rule of forbidden) if (rule.re.test(text)) hits.push(file + ': ' + rule.label);
}
if (hits.length) { console.error('NO-DRIVE-TRASH GUARD FAILED\n' + hits.join('\n')); process.exit(1); }
console.log('No Drive trash/delete mutation patterns found in application sources.');