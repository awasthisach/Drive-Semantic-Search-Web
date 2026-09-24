/**
 * Hybrid search: neural cosine (optional) + BM25 body + metadata keywords.
 * Weights are PROVISIONAL — tune with real eval corpus (Phase 5/11).
 */
import { DriveFile, SemanticSearchResult } from '../types';
import { searchContentIndex } from './contentIndex';
import { expandSemanticQueries, expandTerms } from './queryExpand';
import { isEmbedConfigured } from './embeddings/config';
import { createEmbeddingProvider } from './embeddings/client';
import { getFirebaseIdToken } from './firebaseAuth';
import { searchNeuralByEmbedding } from './vectorIndex';

/** Provisional hybrid weights (must sum ~1). Not final without eval. */
export const HYBRID_WEIGHTS = {
  neural: 0.55,
  bm25: 0.25,
  metadata: 0.2,
} as const;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were',
  'be', 'been', 'it', 'this', 'that', 'with', 'from', 'by', 'as', 'at', 'into', 'about',
  'report', 'file', 'document', 'pdf', 'doc', 'sheet',
]);

function metadataScore(query: string, file: DriveFile): { score: number; reasons: string[] } {
  const queryTerms = expandTerms(query);
  let score = 0;
  const reasons: string[] = [];
  const fileNameLower = file.name.toLowerCase();
  const summaryLower = (file.semanticSummary || '').toLowerCase();
  const tagsCombined = (file.tags || []).join(' ').toLowerCase();
  const q = query.toLowerCase().trim();
  const nameStem = fileNameLower.replace(/\.[a-z0-9]{1,8}$/i, '');

  const exactName = fileNameLower === q || nameStem === q;
  const multiPhrase =
    queryTerms.length > 1 && (fileNameLower.includes(q) || summaryLower.includes(q));

  if (exactName) {
    score += 50;
    reasons.push('Exact filename match');
  } else if (multiPhrase) {
    score += 45;
    reasons.push('Metadata phrase match');
  }

  let matchedTermsCount = 0;
  for (const term of queryTerms) {
    if (fileNameLower.includes(term)) {
      score += 25;
      matchedTermsCount++;
      continue;
    }
    if (STOPWORDS.has(term)) continue;
    if (summaryLower.includes(term)) {
      score += 15;
      matchedTermsCount++;
    } else if (tagsCombined.includes(term)) {
      score += 10;
      matchedTermsCount++;
    }
  }
  if (matchedTermsCount > 0) reasons.push(`Metadata terms ${matchedTermsCount}/${queryTerms.length}`);

  if (file.starred && (matchedTermsCount > 0 || exactName || multiPhrase)) {
    score += 5;
    reasons.push('Starred');
  }
  return { score: Math.min(score, 100), reasons };
}

/** Map cosine [-1,1] → [0,100] for hybrid blend (negative treated as 0). */
export function neuralToDisplayScore(cosine: number): number {
  return Math.round(Math.max(0, Math.min(1, cosine)) * 100);
}

async function tryNeuralSearch(
  query: string,
  corpusKey: string | undefined,
  liveFileIds: Set<string>,
  onStatus?: (message: string) => void
): Promise<Map<string, { score: number; snippet: string }> | null> {
  if (!isEmbedConfigured() || !corpusKey || !query.trim()) return null;
  try {
    const provider = createEmbeddingProvider(() => getFirebaseIdToken());
    const out = new Map<string, { score: number; snippet: string }>();
    const variants = expandSemanticQueries(query);
    let succeeded = 0;
    for (const variant of variants) {
      try {
        const qVec = await provider.embedQuery(variant);
        if (!qVec.length) continue;
        succeeded++;
        const hits = await searchNeuralByEmbedding(qVec, corpusKey, {
          minScore: -1,
          topK: 200,
          liveFileIds,
        });
        for (const h of hits) {
          const prev = out.get(h.fileId);
          if (!prev || h.score > prev.score) {
            out.set(h.fileId, { score: h.score, snippet: h.snippet });
          }
        }
      } catch (variantError) {
        console.warn('[searchEngine] neural variant failed', variant, variantError);
      }
    }
    if (!succeeded) {
      onStatus?.('Neural search unavailable; showing BM25 and metadata matches.');
      return null;
    }
    onStatus?.('Neural search active.');
    return out;
  } catch (e) {
    console.warn('[searchEngine] neural search failed; BM25/metadata only', e);
    onStatus?.('Neural search unavailable; showing BM25 and metadata matches.');
    return null;
  }
}

export async function runHybridSearch(
  query: string,
  files: DriveFile[],
  filterCategory?: string,
  corpusKey?: string,
  onNeuralStatus?: (message: string) => void
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

  const liveIds = new Set(filtered.map(f => f.id));
  const [contentHits, neuralHits] = await Promise.all([
    searchContentIndex(query, corpusKey),
    tryNeuralSearch(query, corpusKey, liveIds, onNeuralStatus),
  ]);

  const results: SemanticSearchResult[] = [];
  const fileById = new Map(filtered.map(f => [f.id, f]));

  // Candidates = files with any positive signal (not entire drive listing)
  const candidateIds = new Set<string>();
  for (const f of filtered) {
    if (metadataScore(query, f).score > 0) candidateIds.add(f.id);
  }
  for (const id of contentHits.keys()) {
    if (fileById.has(id)) candidateIds.add(id);
  }
  if (neuralHits) {
    for (const id of neuralHits.keys()) {
      if (fileById.has(id)) candidateIds.add(id);
    }
  }

  // neuralHits !== null means embed pipeline succeeded (may be empty map)
  const neuralPipelineOk = neuralHits !== null;

  for (const id of candidateIds) {
    const file = fileById.get(id);
    if (!file) continue;

    const meta = metadataScore(query, file);
    const content = contentHits.get(file.id);
    const neural = neuralHits?.get(file.id);

    const metaN = meta.score;
    const bm25N = content ? Math.min(100, content.score * 12) : 0;
    const neuralN = neural ? neuralToDisplayScore(neural.score) : 0;

    const hasAny = metaN > 0 || bm25N > 0 || neuralN > 0;
    if (!hasAny) continue;

    let score: number;
    const reasons: string[] = [...meta.reasons];

    if (neuralPipelineOk) {
      // Always same hybrid formula when neural path ran — neuralN may be 0 for this file
      score = Math.round(
        HYBRID_WEIGHTS.neural * neuralN +
          HYBRID_WEIGHTS.bm25 * bm25N +
          HYBRID_WEIGHTS.metadata * metaN
      );
      if (neuralN > 0) reasons.unshift(`Semantic ${neuralN}`);
      if (bm25N > 0) reasons.push('Content body match');
    } else {
      // Embed not configured / failed → BM25 + metadata only
      score = content
        ? Math.round(Math.min(100, metaN + Math.min(40, content.score * 8) * 0.5))
        : metaN;
      if (content) reasons.push('Content body match');
    }

    if (score <= 0) continue;

    results.push({
      file,
      score: Math.min(score, 100),
      matchedSnippet:
        neural?.snippet || content?.snippet || file.semanticSummary || file.name,
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
      relevanceReason: meta.reasons.join(' · ') || 'Match',
    });
  }
  return results.sort((a, b) => b.score - a.score);
}
