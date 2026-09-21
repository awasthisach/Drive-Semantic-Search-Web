/** Hybrid search: metadata keyword ranking + indexed document body (BM25-ish). */
import { DriveFile, SemanticSearchResult } from '../types';
import { searchContentIndex } from './contentIndex';

/** Common English stopwords — no +45 phrase boost for these alone. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were',
  'be', 'been', 'it', 'this', 'that', 'with', 'from', 'by', 'as', 'at', 'into', 'about',
  'report', 'file', 'document', 'pdf', 'doc', 'sheet',
]);

function metadataScore(query: string, file: DriveFile): { score: number; reasons: string[] } {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  const reasons: string[] = [];
  const fileNameLower = file.name.toLowerCase();
  const summaryLower = (file.semanticSummary || '').toLowerCase();
  const tagsCombined = (file.tags || []).join(' ').toLowerCase();
  const q = query.toLowerCase().trim();

  // Exact filename (with or without extension stem) gets strong boost
  const nameStem = fileNameLower.replace(/\.[a-z0-9]{1,8}$/i, '');
  if (fileNameLower === q || nameStem === q) {
    score += 50;
    reasons.push('Exact filename match');
  } else if (queryTerms.length > 1 && (fileNameLower.includes(q) || summaryLower.includes(q))) {
    // Multi-word phrase only — avoids "report"/"the" +45 inflation
    score += 45;
    reasons.push('Metadata phrase match');
  }

  let matchedTermsCount = 0;
  for (const term of queryTerms) {
    if (STOPWORDS.has(term) && queryTerms.length === 1) continue;
    if (fileNameLower.includes(term)) {
      score += 25;
      matchedTermsCount++;
    } else if (summaryLower.includes(term)) {
      score += 15;
      matchedTermsCount++;
    } else if (tagsCombined.includes(term)) {
      score += 10;
      matchedTermsCount++;
    }
  }
  if (matchedTermsCount > 0) reasons.push(`Metadata terms ${matchedTermsCount}/${queryTerms.length}`);
  if (file.starred) {
    score += 5;
    reasons.push('Starred');
  }
  return { score: Math.min(score, 100), reasons };
}

export async function runHybridSearch(
  query: string,
  files: DriveFile[],
  filterCategory?: string
): Promise<SemanticSearchResult[]> {
  const filtered = files.filter(file => {
    if (!filterCategory || filterCategory === 'all') return true;
    if (filterCategory === 'google_drive') return Boolean(file.isGoogleDriveItem);
    return file.category === filterCategory;
  });

  if (!query.trim()) {
    return filtered.map(file => ({
      file,
      score: 0,
      matchedSnippet: file.semanticSummary || file.name,
      relevanceReason: 'Browse mode (no query)',
    }));
  }

  const contentHits = await searchContentIndex(query);

  const results: SemanticSearchResult[] = [];

  for (const file of filtered) {
    const meta = metadataScore(query, file);
    const content = contentHits.get(file.id);
    // Do NOT normalize content scores to 100 relative to local max —
    // that forced weak content hits to dominate strong filename matches.
    // BM25-ish scores are small; scale modestly into metadata 0–100 space.
    const contentScore = content ? Math.min(40, content.score * 8) : 0;

    let score: number;
    const reasons = [...meta.reasons];
    if (contentScore > 0) {
      // Metadata primary; content is a bounded additive boost (max +40)
      score = Math.round(Math.min(100, meta.score + contentScore * 0.5));
      reasons.push('Content body match');
    } else {
      score = meta.score;
    }

    if (score <= 0) continue;

    results.push({
      file,
      score: Math.min(score, 100),
      matchedSnippet: content?.snippet || file.semanticSummary || file.name,
      relevanceReason: reasons.join(' · ') || 'Match',
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

/** Sync metadata-only search (Dashboard quick filter). */
export function runSemanticSearch(
  query: string,
  files: DriveFile[],
  filterCategory?: string
): SemanticSearchResult[] {
  const filtered = files.filter(file => {
    if (!filterCategory || filterCategory === 'all') return true;
    if (filterCategory === 'google_drive') return Boolean(file.isGoogleDriveItem);
    return file.category === filterCategory;
  });

  if (!query.trim()) {
    return filtered.map(file => ({
      file,
      score: 0,
      matchedSnippet: file.semanticSummary || file.name,
      relevanceReason: 'Browse mode (no query)',
    }));
  }

  const results: SemanticSearchResult[] = [];
  for (const file of filtered) {
    const meta = metadataScore(query, file);
    if (meta.score <= 0) continue;
    results.push({
      file,
      score: meta.score,
      matchedSnippet: file.semanticSummary || file.name,
      relevanceReason: meta.reasons.join(' · ') || 'Keyword match',
    });
  }
  return results.sort((a, b) => b.score - a.score);
}
