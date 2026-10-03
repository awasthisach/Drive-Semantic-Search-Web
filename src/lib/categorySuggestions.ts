import type { FolderItem } from '../types';
import { cosineSimilarity, l2Normalize } from './embeddings/vector';

export interface RankedFolderSuggestion {
  folder: FolderItem;
  label: string;
  score: number;
}

export function buildFolderPathLabels(folders: FolderItem[]): Map<string, string> {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const labels = new Map<string, string>();
  for (const folder of folders) {
    const parts: string[] = [];
    const visited = new Set<string>();
    let current: FolderItem | undefined = folder;
    while (current && !visited.has(current.id) && parts.length < 20) {
      visited.add(current.id);
      parts.unshift(current.name.trim());
      const parentId: string | undefined = current.parentIds?.[0];
      current = parentId ? byId.get(parentId) : undefined;
    }
    labels.set(folder.id, parts.filter(Boolean).join(' / ') || folder.name);
  }
  return labels;
}

export function buildFolderPathLabel(folder: FolderItem, folders: FolderItem[]): string {
  return buildFolderPathLabels(folders).get(folder.id) || folder.name;
}

/** Only existing folder names and their parent names leave the browser. */
export function buildFolderEmbeddingTexts(folders: FolderItem[]): Map<string, string> {
  const labels = buildFolderPathLabels(folders);
  return new Map(folders.map(folder => [
    folder.id,
    `Existing Google Drive category folder names: ${labels.get(folder.id) || folder.name}`,
  ]));
}

export function buildFolderEmbeddingText(folder: FolderItem, folders: FolderItem[]): string {
  return buildFolderEmbeddingTexts(folders).get(folder.id) || `Existing Google Drive category folder names: ${folder.name}`;
}

export function averageEmbedding(vectors: number[][]): number[] {
  const dimension = vectors.find(vector => vector.length)?.length || 0;
  if (!dimension) return [];
  const sum = new Array(dimension).fill(0);
  let count = 0;
  for (const vector of vectors) {
    if (vector.length !== dimension || vector.some(value => !Number.isFinite(value))) continue;
    for (let index = 0; index < dimension; index++) sum[index] += vector[index];
    count++;
  }
  return count ? l2Normalize(sum.map(value => value / count)) : [];
}

export function rankFolderSuggestions(
  documentEmbedding: number[],
  folders: FolderItem[],
  folderEmbeddings: Map<string, number[]>,
  limit = 3
): RankedFolderSuggestion[] {
  if (!documentEmbedding.length || !limit) return [];
  const labels = buildFolderPathLabels(folders);
  return folders
    .flatMap(folder => {
      const label = labels.get(folder.id) || folder.name;
      const embedding = folderEmbeddings.get(folder.id);
      if (!embedding || embedding.length !== documentEmbedding.length) return [];
      const score = cosineSimilarity(documentEmbedding, embedding);
      return Number.isFinite(score) ? [{ folder, label, score }] : [];
    })
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, Math.max(0, limit));
}
