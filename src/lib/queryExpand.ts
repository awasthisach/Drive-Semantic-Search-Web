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

const SEMANTIC_VARIANTS: Record<string, string[]> = {
  cannabis: ['cannabis', 'hemp', 'bhang', 'भांग', 'कैनबिस'],
  hemp: ['hemp', 'cannabis', 'bhang', 'भांग', 'कैनबिस'],
  bhang: ['bhang', 'cannabis', 'hemp', 'भांग', 'कैनबिस'],
  भांग: ['भांग', 'bhang', 'cannabis', 'hemp', 'कैनबिस'],
  कैनबिस: ['कैनबिस', 'cannabis', 'hemp', 'bhang', 'भांग'],
};

/** term → all alternate forms (latin ↔ devanagari). */
const LOOKUP = new Map<string, Set<string>>();
function addAlt(from: string, to: string) {
  let s = LOOKUP.get(from);
  if (!s) {
    s = new Set();
    LOOKUP.set(from, s);
  }
  s.add(to);
}
for (const [a, b] of PAIRS) {
  addAlt(a.toLowerCase(), b);
  addAlt(b, a.toLowerCase());
}

/** Expand query terms with latin\u2194devanagari pairs when present. */
export function expandTerms(query: string): string[] {
  const raw = query
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{M}\p{N}_-]/gu, ''))
    .filter(t => t.length >= 2);
  const out = new Set<string>(raw);
  for (const t of raw) {
    const alts = LOOKUP.get(t);
    if (alts) for (const a of alts) out.add(a);
  }
  return [...out];
}

/** Return a bounded set of high-confidence whole-query neural variants. */
export function expandSemanticQueries(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const rawTerms = trimmed
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{M}\p{N}_-]/gu, ''))
    .filter(Boolean);
  const variants = new Set<string>([trimmed]);

  for (const term of rawTerms) {
    const aliases = SEMANTIC_VARIANTS[term];
    if (!aliases) continue;
    for (const alias of aliases) {
      variants.add(rawTerms.map(current => (current === term ? alias : current)).join(' '));
    }
  }

  return [...variants].slice(0, 8);
}
