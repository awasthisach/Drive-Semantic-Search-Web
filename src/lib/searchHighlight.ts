export type HighlightSegment = {
  text: string;
  match: boolean;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split text into matched / non-matched segments for query terms (len >= 2). */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(t => t.length >= 2);

  if (!text) return [];
  if (!terms.length) return [{ text, match: false }];

  const re = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(re).filter(Boolean);

  return parts.map(part => ({
    text: part,
    match: terms.includes(part.toLowerCase()),
  }));
}
