/** Lightweight Hindi/Hinglish synonym pairs for query expansion (not embeddings). */
const PAIRS: [string, string][] = [
  ['bhang', 'भांग'],
  ['bhaang', 'भांग'],
  ['cannabis', 'कैनबिस'],
  ['hemp', 'हेम्प'],
  ['video', 'वीडियो'],
  ['report', 'रिपोर्ट'],
  ['folder', 'फ़ोल्डर'],
  ['photo', 'फोटो'],
  ['document', 'दस्तावेज़'],
];

const LOOKUP = new Map<string, string>();
for (const [a, b] of PAIRS) {
  LOOKUP.set(a.toLowerCase(), b);
  LOOKUP.set(b, a.toLowerCase());
}

/** Expand query terms with latin\u2194devanagari pairs when present. */
export function expandTerms(query: string): string[] {
  const raw = query
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(t => t.length >= 2);
  const out = new Set<string>(raw);
  for (const t of raw) {
    const alt = LOOKUP.get(t);
    if (alt) out.add(alt);
  }
  return [...out];
}
