#!/usr/bin/env node
const pageUrl = process.argv[2];
if (!pageUrl) {
  console.error('Usage: node scripts/verify-live-pages.mjs <page-url>');
  process.exit(1);
}

const seen = new Set();
const queue = [new URL(pageUrl)];
const failures = [];

while (queue.length) {
  const url = queue.shift();
  const key = url.href;
  if (seen.has(key)) continue;
  seen.add(key);
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    failures.push(`${url.href}: ${error.message}`);
    continue;
  }
  if (!response.ok) {
    failures.push(`${url.href}: HTTP ${response.status}`);
    continue;
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('javascript') && !url.pathname.endsWith('.html') && !url.pathname.endsWith('/')) continue;
  const source = await response.text();
  const refs = [
    ...source.matchAll(/(?:src|href)=["']([^"']+\.js)["']/g),
    ...source.matchAll(/(?:import\s*\(|from\s*)["']([^"']+\.js)["']/g),
  ];
  for (const match of refs) {
    const child = new URL(match[1], url);
    if (child.origin === new URL(pageUrl).origin) queue.push(child);
  }
}

console.log(`Verified ${seen.size} live page/module URL(s)`);
if (failures.length) {
  console.error('Live asset verification failed:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('All live JavaScript module references returned HTTP 2xx');
