import { describe, expect, it } from 'vitest';
import type { FolderItem } from '../../types';
import { averageEmbedding, buildFolderEmbeddingText, buildFolderPathLabel, canSuggestFolders, rankFolderSuggestions } from '../categorySuggestions';

const folders: FolderItem[] = [
  { id: 'root-books', name: 'Books', color: 'blue' },
  { id: 'physics', name: 'Physics', color: 'purple', parentIds: ['root-books'] },
  { id: 'art', name: 'Art', color: 'amber' },
];

describe('folder category suggestions', () => {
  it('disables the Suggest folders action until its prerequisites are ready', () => {
    expect(canSuggestFolders({ hasSelectedFile: false, hasFolders: true, loading: false })).toBe(false);
    expect(canSuggestFolders({ hasSelectedFile: true, hasFolders: false, loading: false })).toBe(false);
    expect(canSuggestFolders({ hasSelectedFile: true, hasFolders: true, loading: true })).toBe(false);
    expect(canSuggestFolders({ hasSelectedFile: true, hasFolders: true, loading: false })).toBe(true);
  });

  it('builds a folder label using existing Drive parent/name metadata', () => {
    expect(buildFolderPathLabel(folders[1], folders)).toBe('Books / Physics');
    expect(buildFolderEmbeddingText(folders[1], folders)).toContain('Books / Physics');
  });

  it('handles missing parents and folder cycles safely', () => {
    const cycle: FolderItem[] = [
      { id: 'a', name: 'A', color: 'blue', parentIds: ['b'] },
      { id: 'b', name: 'B', color: 'blue', parentIds: ['a'] },
    ];
    expect(buildFolderPathLabel(cycle[0], cycle)).toBe('B / A');
  });

  it('averages compatible vectors and ranks folder suggestions semantically', () => {
    expect(averageEmbedding([[1, 0], [1, 0]])).toEqual([1, 0]);
    const suggestions = rankFolderSuggestions(
      [1, 0],
      folders,
      new Map([
        ['root-books', [0.8, 0.6]],
        ['physics', [0.99, 0.01]],
        ['art', [0, 1]],
      ]),
      2
    );
    expect(suggestions.map(suggestion => suggestion.folder.id)).toEqual(['physics', 'root-books']);
    expect(suggestions[0].score).toBeGreaterThan(suggestions[1].score);
  });

  it('does not invent a category when no folder vector exists', () => {
    expect(rankFolderSuggestions([1, 0], folders, new Map())).toEqual([]);
  });
});
