/** Lightweight browser-side extraction for common DOCX/XLSX files.
 * No server upload: binaries are downloaded from Drive and parsed locally.
 * PDFs and scanned images are handled by the page-aware pipeline in ocrExtract.ts.
 */

const MAX_ZIP_ENTRIES = 2_000;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('Browser lacks DecompressionStream');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEocd(b: Uint8Array): number {
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66_000); i--) {
    if (u32(b, i) === 0x06054b50) return i;
  }
  return -1;
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function readZipEntries(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const b = new Uint8Array(buffer);
  const eocd = findEocd(b);
  if (eocd < 0) throw new Error('Invalid ZIP container');
  const count = Math.min(u16(b, eocd + 10), MAX_ZIP_ENTRIES);
  const cdSize = u32(b, eocd + 12);
  const cdOffset = u32(b, eocd + 16);
  if (cdOffset + cdSize > b.length) throw new Error('Invalid ZIP directory');

  const out = new Map<string, Uint8Array>();
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= b.length; i++) {
    if (u32(b, p) !== 0x02014b50) break;
    const method = u16(b, p + 10);
    const compressedSize = u32(b, p + 20);
    const uncompressedSize = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const localOffset = u32(b, p + 42);
    const name = decodeName(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (uncompressedSize > MAX_ENTRY_BYTES || compressedSize > b.length) continue;
    if (localOffset + 30 > b.length || u32(b, localOffset) !== 0x04034b50) continue;
    const localNameLen = u16(b, localOffset + 26);
    const localExtraLen = u16(b, localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const end = start + compressedSize;
    if (end > b.length) continue;
    const raw = b.subarray(start, end);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else continue;
    out.set(name, data);
  }
  return out;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number(lower.slice(1)));
    return _;
  });
}

function xmlText(xml: string): string {
  return decodeXmlEntities(xml)
    .replace(/<w:tab\s*\/?>/gi, '\t')
    .replace(/<w:br\s*\/?>/gi, '\n')
    .replace(/<\/w:p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const entries = await readZipEntries(buffer);
  const document = entries.get('word/document.xml');
  if (!document) throw new Error('DOCX document.xml missing');
  return xmlText(new TextDecoder().decode(document));
}

function decodeXml(s: string): string {
  return decodeXmlEntities(s);
}

export async function extractXlsxText(buffer: ArrayBuffer): Promise<string> {
  const entries = await readZipEntries(buffer);
  const shared = entries.get('xl/sharedStrings.xml');
  const sharedStrings: string[] = [];
  if (shared) {
    const xml = new TextDecoder().decode(shared);
    for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
      sharedStrings.push(xmlText(match[1]));
    }
  }

  const sheetNames = [...entries.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k)).sort();
  const rows: string[] = [];
  for (const sheet of sheetNames) {
    const xml = new TextDecoder().decode(entries.get(sheet)!);
    rows.push(`[${sheet.replace(/^xl\/worksheets\//, '').replace(/\.xml$/i, '')}]`);
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attrs = cell[1];
        const body = cell[2];
        const type = /\bt=["']([^"']+)/i.exec(attrs)?.[1] || '';
        const value = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1] ?? '';
        const inline = /<t\b[^>]*>([\s\S]*?)<\/t>/i.exec(body)?.[1] ?? '';
        let text = decodeXml(inline || value);
        if (type === 's' && value !== '') text = sharedStrings[Number(value)] ?? text;
        if (type === 'b') text = value === '1' ? 'TRUE' : 'FALSE';
        cells.push(text);
      }
      if (cells.some(Boolean)) rows.push(cells.join('\t'));
    }
  }
  return rows.join('\n').trim();
}
