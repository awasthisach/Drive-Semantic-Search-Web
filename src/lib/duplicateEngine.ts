import { DriveFile, DuplicateGroup } from '../types';
import type { VectorRecord } from './vectorIndex';
import { cosineSimilarity, l2Normalize } from './embeddings/vector';

/**
 * Groups likely duplicates.
 * Primary: contentHash when sha256:…
 * Fallback: same size + normalized name — only when size > 0.
 * Files with unknown size (0) are never size+name grouped.
 */
export function findDuplicates(files: DriveFile[]): DuplicateGroup[] {
  const hashMap = new Map<string, DriveFile[]>();

  files.forEach(file => {
    let key = file.contentHash;
    if (!key || key.startsWith('gdrive-') || key.startsWith('user-')) {
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
      const totalSize = groupFiles.reduce((s, f) => s + f.size, 0);
      const reclaimableSize = totalSize - singleSize;

      const sorted = [...groupFiles].sort(
        (a, b) => new Date(a.modifiedTime).getTime() - new Date(b.modifiedTime).getTime()
      );

      duplicateGroups.push({
        hash,
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
  similarity: number;
  files: DriveFile[];
}

/**
 * Builds review-only near-duplicate groups from already indexed embeddings.
 * It never mutates files and never marks a file safe to trash: semantic
 * similarity can indicate paraphrases, templates, or related documents.
 */
export function findSemanticDuplicatesFromVectors(
  files: DriveFile[],
  vectors: VectorRecord[],
  threshold = 0.9,
  maxFiles = 500
): SemanticDuplicateGroup[] {
  const fileById = new Map(files.map(file => [file.id, file]));
  const sums = new Map<string, number[]>();
  const counts = new Map<string, number>();
  const dimension = vectors.find(v => v.embedding?.length)?.embedding.length;
  if (!dimension || !Number.isFinite(threshold)) return [];

  for (const vector of vectors) {
    if (!fileById.has(vector.fileId) || vector.embedding.length !== dimension) continue;
    if (vector.embedding.some(value => !Number.isFinite(value))) continue;
    const sum = sums.get(vector.fileId) || new Array(dimension).fill(0);
    vector.embedding.forEach((value, index) => { sum[index] += value; });
    sums.set(vector.fileId, sum);
    counts.set(vector.fileId, (counts.get(vector.fileId) || 0) + 1);
  }

  const profiles = [...sums.entries()]
    .slice(0, maxFiles)
    .map(([fileId, sum]) => ({
      fileId,
      centroid: l2Normalize(sum.map(value => value / (counts.get(fileId) || 1))),
    }));
  if (profiles.length < 2) return [];

  const parent = new Map(profiles.map(profile => [profile.fileId, profile.fileId]));
  const find = (id: string): string => {
    let root = parent.get(id) || id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const similarities = new Map<string, number>();
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const similarity = cosineSimilarity(profiles[i].centroid, profiles[j].centroid);
      if (similarity >= threshold) {
        union(profiles[i].fileId, profiles[j].fileId);
        const key = [profiles[i].fileId, profiles[j].fileId].sort().join('|');
        similarities.set(key, similarity);
      }
    }
  }

  const grouped = new Map<string, DriveFile[]>();
  for (const profile of profiles) {
    const group = grouped.get(find(profile.fileId)) || [];
    group.push(fileById.get(profile.fileId)!);
    grouped.set(find(profile.fileId), group);
  }
  return [...grouped.values()]
    .filter(group => group.length > 1)
    .map(group => {
      let best = threshold;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const value = similarities.get([group[i].id, group[j].id].sort().join('|'));
          if (value && value > best) best = value;
        }
      }
      return { similarity: best, files: group.sort((a, b) => new Date(a.modifiedTime).getTime() - new Date(b.modifiedTime).getTime()) };
    })
    .sort((a, b) => b.similarity - a.similarity);
}
