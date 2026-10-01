#!/usr/bin/env node
const pageUrl = process.argv[2];
if (!pageUrl) {
  console.error('Usage: node scripts/verify-live-pages.mjs <page-url>');
  process.exit(1);
}

const maxAttempts = 8;
const delayMs = 15000;

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyOnce() {
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

  return { seen, failures };
}

let lastFailures = [];
let lastSeen = 0;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const { seen, failures } = await verifyOnce();
  lastSeen = seen.size;
  lastFailures = failures;
  if (failures.length === 0) {
    console.log(`Verified ${seen.size} live page/module URL(s)`);
    console.log('All live JavaScript module references returned HTTP 2xx');
    process.exit(0);
  }
  console.warn(`Live asset verification attempt ${attempt}/${maxAttempts} failed (${failures.length} error(s)); retrying in ${delayMs / 1000}s`);
  for (const failure of failures) console.warn(`  ${failure}`);
  if (attempt < maxAttempts) await sleep(delayMs);
}

console.error('Live asset verification failed after retries:');
for (const failure of lastFailures) console.error(`  ${failure}`);
console.error(`Last reach count before failure: ${lastSeen}`);
process.exit(1);
