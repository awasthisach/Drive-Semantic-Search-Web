import React, { useState } from 'react';
import { Copy, Trash2, CheckCircle, Check, FileText } from 'lucide-react';
import { DriveFile } from '../types';
import { findDuplicates, safeTrashSelection, wouldEmptyGroup } from '../lib/duplicateEngine';
import { formatBytes } from '../lib/driveApi';

interface DuplicateFinderProps {
  files: DriveFile[];
  onRemoveFiles: (ids: string[]) => void;
  onVerifyHashes?: (fileIds: string[]) => Promise<void>;
  verifyBusy?: boolean;
}

export const DuplicateFinder: React.FC<DuplicateFinderProps> = ({ files, onRemoveFiles, onVerifyHashes, verifyBusy }) => {
  const [selectedDuplicates, setSelectedDuplicates] = useState<Set<string>>(() => new Set());
  const [keepOneHint, setKeepOneHint] = useState<string | null>(null);
  const duplicateGroups = findDuplicates(files);
  const totalReclaimable = duplicateGroups.reduce((acc, group) => acc + group.reclaimableSize, 0);

  const confirmedIds = new Set(
    duplicateGroups
      .filter(g => g.hash.startsWith('sha256:'))
      .flatMap(g => g.files.map(f => f.id))
  );

  const toggleSelect = (id: string) => {
    if (!confirmedIds.has(id)) return;
    const next = new Set(selectedDuplicates);
    if (next.has(id)) {
      next.delete(id);
    } else {
      const group = duplicateGroups.find(g => g.files.some(f => f.id === id));
      if (group && wouldEmptyGroup(group, next, id)) {
        setKeepOneHint(group.hash);
        return;
      }
      next.add(id);
    }
    setKeepOneHint(null);
    setSelectedDuplicates(next);
  };

  const handleSelectAllDuplicates = () => {
    const next = new Set<string>();
    duplicateGroups.forEach(group => {
      if (!group.hash.startsWith('sha256:')) return;
      group.files.slice(1).forEach(f => next.add(f.id));
    });
    setSelectedDuplicates(next);
  };

  const handleDeselectAll = () => setSelectedDuplicates(new Set());

  const handleCleanSelected = () => {
    const safe = safeTrashSelection(duplicateGroups, selectedDuplicates);
    if (safe.length === 0) return;
    onRemoveFiles(safe);
    setSelectedDuplicates(new Set());
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl p-5 sm:p-6 bg-gradient-to-br from-indigo-950/80 via-zinc-900 to-zinc-950 text-white border border-indigo-900/30 shadow-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start sm:items-center gap-3.5">
            <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 shrink-0">
              <Copy className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg sm:text-xl font-bold tracking-tight">Duplicate Candidate Cleaner</h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  Size/name · sha256 when verified
                </span>
              </div>
              <p className="text-xs sm:text-sm text-zinc-400 mt-1 max-w-xl">
                Trash locked until SHA-256 verify. Use Verify candidates to hash Drive files (download/export).
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[11px] text-zinc-400 uppercase tracking-wider font-semibold">Candidate reclaim*</p>
            <p className="text-base sm:text-xl font-bold text-emerald-400 font-mono">{formatBytes(totalReclaimable)}</p>
            <p className="text-[10px] text-zinc-500 mt-0.5">*Real only after SHA-256 confirm</p>
          </div>
        </div>
      </div>

      {duplicateGroups.length === 0 ? (
        <div className="text-center py-12 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-800">
          <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
          <h3 className="text-base font-bold">No candidate groups</h3>
          <p className="text-xs text-zinc-500 mt-1">Sync Drive files, then verify hashes for confirmed duplicates.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white dark:bg-zinc-900 p-4 rounded-2xl border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="font-semibold">{duplicateGroups.length} group(s)</span>
              <button type="button" onClick={handleSelectAllDuplicates} className="text-indigo-600 hover:underline font-medium">
                Select non-primary (SHA-256 only)
              </button>
              <button type="button" onClick={handleDeselectAll} className="text-zinc-500 hover:underline">
                Clear selection
              </button>
              {onVerifyHashes && (
                <button
                  type="button"
                  disabled={verifyBusy}
                  onClick={() => {
                    const ids = duplicateGroups
                      .filter(g => !g.hash.startsWith('sha256:'))
                      .flatMap(g => g.files.map(f => f.id));
                    if (ids.length) onVerifyHashes(ids);
                  }}
                  className="text-emerald-600 hover:underline font-medium disabled:opacity-50"
                >
                  {verifyBusy ? 'Verifying SHA-256…' : 'Verify candidates (SHA-256)'}
                </button>
              )}
            </div>
            <button
              type="button"
              disabled={selectedDuplicates.size === 0}
              onClick={handleCleanSelected}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-600 text-white text-xs font-bold disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Trash selected ({selectedDuplicates.size})
            </button>
          </div>

          {duplicateGroups.map(group => {
            const confirmed = group.hash.startsWith('sha256:');
            return (
              <div
                key={group.hash}
                className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden"
              >
                <div className="px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between gap-2 text-xs">
                  <span className={`font-bold ${confirmed ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {confirmed ? 'confirmed SHA-256' : 'candidate (size + name) — trash locked'}
                  </span>
                  <div className="flex items-center gap-2">
                    {!confirmed && onVerifyHashes && (
                      <button
                        type="button"
                        disabled={verifyBusy}
                        className="text-[10px] font-bold text-emerald-600 hover:underline disabled:opacity-50"
                        onClick={() => onVerifyHashes(group.files.map(f => f.id))}
                      >
                        Verify group
                      </button>
                    )}
                    <span className="text-zinc-500">{group.fileCount} files · reclaim ~{formatBytes(group.reclaimableSize)}</span>
                  </div>
                </div>
                {keepOneHint === group.hash && (
                  <p className="px-4 py-1.5 text-[11px] font-semibold text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300">
                    At least one copy must stay — deselect another file first.
                  </p>
                )}
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {group.files.map((file, idx) => (
                    <li key={file.id} className="flex items-center gap-3 px-4 py-3">
                      {confirmed ? (
                        <button type="button" onClick={() => toggleSelect(file.id)} className="shrink-0" title="Select for trash">
                          {selectedDuplicates.has(file.id) ? (
                            <Check className="w-4 h-4 text-indigo-600" />
                          ) : (
                            <span className="w-4 h-4 inline-block rounded border border-zinc-300 dark:border-zinc-600" />
                          )}
                        </button>
                      ) : (
                        <span
                          className="w-4 h-4 inline-block rounded border border-dashed border-zinc-300 dark:border-zinc-600 opacity-40 shrink-0"
                          title="Verify SHA-256 before trash"
                        />
                      )}
                      <FileText className="w-4 h-4 text-zinc-400 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold truncate">{file.name}</div>
                        <div className="text-[11px] text-zinc-500">
                          {formatBytes(file.size)} · {new Date(file.modifiedTime).toLocaleDateString()}
                        </div>
                      </div>
                      {idx === 0 && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                          Primary (review)
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
