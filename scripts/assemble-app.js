const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '../src/app_chunks');
const out = path.join(__dirname, '../src/AppMain.tsx');
const parts = [];
for (let i = 0; i < 32; i++) {
  const f = path.join(dir, 'c' + i + '.txt');
  if (!fs.existsSync(f)) break;
  parts.push(fs.readFileSync(f, 'utf8'));
}
if (!parts.length) {
  console.error('No app chunks found at', dir);
  process.exit(1);
}
const body = parts.join('');
fs.writeFileSync(out, body);
console.log('Assembled AppMain.tsx', body.length, 'bytes from', parts.length, 'chunks');
