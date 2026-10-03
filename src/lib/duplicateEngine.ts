import { DriveFile, DuplicateGroup } from '../types';
import type { VectorRecord } from './vectorIndex';
import { cosineSimilarity, l2Normalize } from './embeddings/vector';


export interface KeepCandidate {
  file: DriveFile;
  score: number;
  reasons: string[];
}

function keepCandidateScore(file: DriveFile, peers: DriveFile[]): KeepCandidate {
  const maxSize = Math.max(1, ...peers.map(f => f.size || 0));
  const normalizedName = (file.name || '').toLowerCase();
  let score = ((file.size || 0) / maxSize) * 12;
  const reasons: string[] = [];
  if (file.starred) { score += 40; reasons.push('starred'); }
  if (file.isOffline) { score += 15; reasons.push('available offline'); }
  if (file.folderId && file.folderId !== 'root') { score += 8; reasons.push('organized in a folder'); }
  if (file.semanticSummary && file.semanticSummary.length >= 80) { score += 4; reasons.push('richer metadata'); }
  if (/\b(copy|duplicate|dup)\b|\(copy(?: \d+)?\)|\(\d+\)$/i.test(normalizedName)) {
    score -= 25;
    reasons.push('copy/duplicate naming penalty');
  }
  const created = Date.parse(file.createdTime);
  if (Number.isFinite(created)) score += Math.max(0, 8 - Math.min(8, (created - Math.min(...peers.map(f => Date.parse(f.createdTime) || created))) / 86_400_000 / 365));
  if (!reasons.length) reasons.push('highest combined preservation score');
  return { file, score, reasons };
}

export function chooseKeepCandidate(files: DriveFile[]): KeepCandidate {
  if (!files.length) throw new Error('chooseKeepCandidate requires at least one file');
  return files.map(file => keepCandidateScore(file, files)).sort((a,b) =>
    b.score - a.score ||
    Date.parse(a.file.createdTime) - Date.parse(b.file.createdTime) ||
    Date.parse(a.file.modifiedTime) - Date.parse(b.file.modifiedTime) ||
    a.file.name.localeCompare(b.file.name) || a.file.id.localeCompare(b.file.id)
  )[0];
}
/**
 * Groups likely exact/candidate duplicates. SHA-256 is the only proof-grade
 * signal; matching size and normalized name remains a review-only candidate.
 */
export function findDuplicates(files: DriveFile[]): DuplicateGroup[] {
  const hashMap = new Map<string, DriveFile[]>();

  files.forEach(file => {
    let key = file.contentHash;
    const verifiedSha = Boolean(
      key?.startsWith('sha256:') && file.contentHashModifiedTime &&
      file.contentHashModifiedTime === file.modifiedTime
    );
    if (!key || key.startsWith('gdrive-') || key.startsWith('user-') || (key.startsWith('sha256:') && !verifiedSha)) {
      if (!file.size || file.size <= 0) {
        key = `unique:${file.id}`;
      } else {
        key = `size:${file.size}|name:${(file.name || '').toLowerCase()}`;
      }
    }
    const existing = hashMap.get(key) || [];
    existing.push(file);
    hashMap.set(key, existing);
  });

  const duplicateGroups: DuplicateGroup[] = [];
  hashMap.forEach((groupFiles, hash) => {
    if (groupFiles.length > 1 && !hash.startsWith('unique:')) {
      const singleSize = groupFiles[0].size;
      const totalSize = groupFiles.reduce((sum, file) => sum + file.size, 0);
      const reclaimableSize = totalSize - singleSize;
      const keep = chooseKeepCandidate(groupFiles).file;
      const sorted = [keep, ...groupFiles.filter(file => file.id !== keep.id).sort(
        (a, b) => new Date(a.modifiedTime).getTime() - new Date(b.modifiedTime).getTime()
      )];
      duplicateGroups.push({
        hash,
        verification: hash.startsWith('sha256:') ? 'sha256' : 'candidate',
        fileCount: sorted.length,
        totalSize,
        reclaimableSize,
        files: sorted,
      });
    }
  });

  return duplicateGroups.sort((a, b) => {
    const aConf = a.hash.startsWith('sha256:') ? 0 : 1;
    const bConf = b.hash.startsWith('sha256:') ? 0 : 1;
    if (aConf !== bConf) return aConf - bConf;
    return b.reclaimableSize - a.reclaimableSize;
  });
}

export interface SemanticDuplicateGroup {
  /** Composite content-overlap score, not proof of byte identity. */
  bestPairSimilarity: number;
  files: DriveFile[];
}

export interface UncertainSemanticPair {
  files: [DriveFile, DriveFile];
  similarity: number;
}

export interface SemanticDuplicateAnalysis {
  groups: SemanticDuplicateGroup[];
  /** Pairs within five percentage points below the selected threshold. */
  uncertainPairs: UncertainSemanticPair[];
}

const MAX_FILES = 500;
const MAX_PROFILE_CHUNKS = 12;
const MAX_CANDIDATES_PER_FILE = 8;
const UNCERTAIN_MARGIN = 0.05;

function representativeVectors(rows: VectorRecord[]): VectorRecord[] {
  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  if (ordered.length <= MAX_PROFILE_CHUNKS) return ordered;
  const selected: VectorRecord[] = [];
  for (let i = 0; i < MAX_PROFILE_CHUNKS; i++) {
    const index = Math.round(i * (ordered.length - 1) / (MAX_PROFILE_CHUNKS - 1));
    selected.push(ordered[index]);
  }
  return selected;
}

function profileCentroid(rows: VectorRecord[], dimension: number): number[] {
  const sum = new Array(dimension).fill(0);
  for (const row of rows) row.embedding.forEach((value, index) => { sum[index] += value; });
  return l2Normalize(sum.map(value => value / Math.max(1, rows.length)));
}

interface ChunkMatch {
  left: number;
  right: number;
  similarity: number;
}

function longestIncreasingMatches(matches: ChunkMatch[]): ChunkMatch[] {
  if (!matches.length) return [];
  const ordered = [...matches].sort((a, b) => a.left - b.left || a.right - b.right);
  const tails: number[] = [];
  const tailPositions: number[] = [];
  const previous = new Array(ordered.length).fill(-1);

  for (let i = 0; i < ordered.length; i++) {
    const value = ordered[i].right;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tails[middle] < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[i] = tailPositions[low - 1];
    tails[low] = value;
    tailPositions[low] = i;
  }

  const result: ChunkMatch[] = [];
  let cursor = tailPositions[tails.length - 1];
  while (cursor !== undefined && cursor >= 0) {
    result.push(ordered[cursor]);
    cursor = previous[cursor];
  }
  return result.reverse();
}

/**
 * Compare multi-chunk profiles. One-to-one matching prevents a single generic
 * passage from matching many chunks; monotonic alignment rewards shared content
 * in the same order, which helps distinguish the same work from a shared topic.
 */
function scoreChunkProfiles(left: VectorRecord[], right: VectorRecord[], threshold: number): number | null {
  const floor = Math.max(0.55, threshold - 0.15);
  const candidates: ChunkMatch[] = [];
  for (let i = 0; i < left.length; i++) {
    for (let j = 0; j < right.length; j++) {
      const similarity = cosineSimilarity(left[i].embedding, right[j].embedding);
      if (similarity >= floor) candidates.push({ left: i, right: j, similarity });
    }
  }
  candidates.sort((a, b) => b.similarity - a.similarity);

  const usedLeft = new Set<number>();
  const usedRight = new Set<number>();
  const uniqueMatches: ChunkMatch[] = [];
  for (const match of candidates) {
    if (usedLeft.has(match.left) || usedRight.has(match.right)) continue;
    usedLeft.add(match.left);
    usedRight.add(match.right);
    uniqueMatches.push(match);
  }

  const aligned = longestIncreasingMatches(uniqueMatches);
  const smallerProfileSize = Math.min(left.length, right.length);
  const minimumMatches = Math.min(2, smallerProfileSize);
  if (aligned.length < minimumMatches) return null;
  const coverageOfSmallerProfile = aligned.length / smallerProfileSize;
  const meanMatchedSimilarity = aligned.reduce((sum, match) => sum + match.similarity, 0) / aligned.length;
  return Math.max(0, Math.min(1, coverageOfSmallerProfile * meanMatchedSimilarity));
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join('|');
}

/**
 * Compare files without name/size gates. Embedding centroids shortlist likely
 * pairs; a bounded page/chunk-level ordered overlap score does the final review
 * ranking. Groups and borderline pairs are suggestions only: never safe-to-trash.
 */
export function analyzeSemanticDuplicatesFromVectors(
  files: DriveFile[],
  vectors: VectorRecord[],
  threshold = 0.9,
  maxFiles = MAX_FILES
): SemanticDuplicateAnalysis {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return { groups: [], uncertainPairs: [] };
  }
  const fileById = new Map(files.map(file => [file.id, file]));
  const byFile = new Map<string, VectorRecord[]>();
  const dimension = vectors.find(vector => vector.embedding?.length)?.embedding.length;
  if (!dimension) return { groups: [], uncertainPairs: [] };

  for (const vector of vectors) {
    if (!fileById.has(vector.fileId) || vector.embedding.length !== dimension) continue;
    if (vector.embedding.some(value => !Number.isFinite(value))) continue;
    const rows = byFile.get(vector.fileId) || [];
    rows.push(vector);
    byFile.set(vector.fileId, rows);
  }

  const profiles = [...byFile.entries()]
    .slice(0, Math.max(0, maxFiles))
    .map(([fileId, rows]) => {
      const chunks = representativeVectors(rows);
      return { fileId, chunks, centroid: profileCentroid(chunks, dimension) };
    })
    .filter(profile => profile.chunks.length > 0);
  if (profiles.length < 2) return { groups: [], uncertainPairs: [] };

  const candidatePairs = new Set<string>();
  for (let i = 0; i < profiles.length; i++) {
    const nearest = profiles
      .map((profile, index) => ({
        index,
        similarity: index === i ? -1 : cosineSimilarity(profiles[i].centroid, profile.centroid),
      }))
      .filter(item => item.index !== i)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, MAX_CANDIDATES_PER_FILE);
    for (const item of nearest) {
      const key = pairKey(profiles[i].fileId, profiles[item.index].fileId);
      candidatePairs.add(key);
    }
  }

  const profileById = new Map(profiles.map(profile => [profile.fileId, profile]));
  const scoredPairs = new Map<string, number>();
  const uncertainPairs: UncertainSemanticPair[] = [];
  for (const key of candidatePairs) {
    const [leftId, rightId] = key.split('|');
    const left = profileById.get(leftId);
    const right = profileById.get(rightId);
    if (!left || !right) continue;
    const score = scoreChunkProfiles(left.chunks, right.chunks, threshold);
    if (score === null) continue;
    if (score >= threshold) {
      scoredPairs.set(key, score);
    } else if (score >= threshold - UNCERTAIN_MARGIN) {
      uncertainPairs.push({
        files: [fileById.get(leftId)!, fileById.get(rightId)!],
        similarity: score,
      });
    }
  }

  const parent = new Map(profiles.map(profile => [profile.fileId, profile.fileId]));
  const find = (id: string): string => {
    let root = parent.get(id) || id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const key of scoredPairs.keys()) {
    const [leftId, rightId] = key.split('|');
    union(leftId, rightId);
  }

  const groups = new Map<string, DriveFile[]>();
  for (const profile of profiles) {
    const root = find(profile.fileId);
    const group = groups.get(root) || [];
    group.push(fileById.get(profile.fileId)!);
    groups.set(root, group);
  }
  const duplicateGroups = [...groups.values()]
    .filter(group => group.length > 1)
    .map(group => {
      let best = threshold;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const value = scoredPairs.get(pairKey(group[i].id, group[j].id));
          if (value !== undefined) best = Math.max(best, value);
        }
      }
      return {
        bestPairSimilarity: best,
        files: group.sort((a, b) => new Date(a.modifiedTime).getTime() - new Date(b.modifiedTime).getTime()),
      };
    })
    .sort((a, b) => b.bestPairSimilarity - a.bestPairSimilarity);

  uncertainPairs.sort((a, b) => b.similarity - a.similarity);
  return { groups: duplicateGroups, uncertainPairs };
}

/** Backward-compatible groups-only API for existing consumers and tests. */
export function findSemanticDuplicatesFromVectors(
  files: DriveFile[],
  vectors: VectorRecord[],
  threshold = 0.9,
  maxFiles = MAX_FILES
): SemanticDuplicateGroup[] {
  return analyzeSemanticDuplicatesFromVectors(files, vectors, threshold, maxFiles).groups;
}
