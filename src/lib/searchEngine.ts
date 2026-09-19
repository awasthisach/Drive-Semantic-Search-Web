/** Hybrid search: metadata keyword ranking + indexed document body (BM25-ish). */
import { DriveFile, SemanticSearchResult } from '../types';
import { searchContentIndex } from './contentIndex';

function metadataScore(query: string, file: DriveFile): { score: number; reasons: string[] } {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  const reasons: string[] = [];
  const fileNameLower = file.name.toLowerCase();
  const summaryLower = (file.semanticSummary || '').toLowerCase();
  const tagsCombined = (file.tags || []).join(' ').toLowerCase();
  const q = query.toLowerCase();

  if (summaryLower.includes(q) || fileNameLower.includes(q)) {
    score += 45;
    reasons.push('Metadata phrase match');
  }

  let matchedTermsCount = 0;
  for (const term of queryTerms) {
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
  let maxContent = 0;
  contentHits.forEach(v => {
    if (v.score > maxContent) maxContent = v.score;
  });

  const results: SemanticSearchResult[] = [];

  for (const file of filtered) {
    const meta = metadataScore(query, file);
    const content = contentHits.get(file.id);
    const contentNorm = content && maxContent > 0 ? Math.min(100, (content.score / maxContent) * 100) : 0;

    let score: number;
    const reasons = [...meta.reasons];
    if (content && contentNorm > 0) {
      score = Math.round(0.4 * meta.score + 0.6 * contentNorm);
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
