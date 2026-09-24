import { DriveFile, DuplicateGroup } from '../types';

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

/**
 * Trash-safety: a duplicate group must always keep at least one copy.
 * Returns the ids that are safe to remove given the user's selection:
 * only SHA-256 confirmed groups, and never every file of a group (the
 * oldest/primary is kept when the whole group was selected).
 */
export function safeTrashSelection(groups: DuplicateGroup[], selected: Set<string>): string[] {
  const out = new Set<string>();
  for (const group of groups) {
    if (!group.hash.startsWith('sha256:')) continue;
    const picked = group.files.filter(f => selected.has(f.id));
    if (picked.length === 0) continue;
    const keep = picked.length === group.files.length ? group.files[0].id : null;
    for (const f of picked) if (f.id !== keep) out.add(f.id);
  }
  return Array.from(out);
}

/** True when selecting `id` would leave no unselected copy in its group. */
export function wouldEmptyGroup(group: DuplicateGroup, selected: Set<string>, id: string): boolean {
  return group.files.filter(f => f.id !== id).every(f => selected.has(f.id));
}
