import React, { useMemo, useState } from 'react';
import { Copy, Trash2, CheckCircle, Check, FileText, FolderInput, Sparkles, Loader2 } from 'lucide-react';
import { DriveFile } from '../types';
import { findDuplicates, findSemanticDuplicatesFromVectors, SemanticDuplicateGroup } from '../lib/duplicateEngine';
import { listVectors } from '../lib/vectorIndex';
import { MoveToFolderModal } from './MoveToFolderModal';
import { formatBytes } from '../lib/driveApi';

interface DuplicateFinderProps {
  files: DriveFile[];
  folders: import('../types').FolderItem[];
  corpusKey: string;
  onRemoveFiles: (ids: string[]) => void;
  onMoveFiles: (ids: string[], folderId: string | undefined) => void;
  onCreateFolder: (folder: import('../types').FolderItem) => void;
  onVerifyHashes?: (fileIds: string[]) => Promise<void>;
  verifyBusy?: boolean;
}

export const DuplicateFinder: React.FC<DuplicateFinderProps> = ({ files, folders, corpusKey, onRemoveFiles, onMoveFiles, onCreateFolder, onVerifyHashes, verifyBusy }) => {
  const [selectedDuplicates, setSelectedDuplicates] = useState<Set<string>>(() => new Set());
  const [selectedForMove, setSelectedForMove] = useState<Set<string>>(() => new Set());
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [semanticGroups, setSemanticGroups] = useState<SemanticDuplicateGroup[]>([]);
  const [semanticThreshold, setSemanticThreshold] = useState(0.9);
  const [semanticBusy, setSemanticBusy] = useState(false);
  const [semanticStatus, setSemanticStatus] = useState('');
  const duplicateGroups = findDuplicates(files);
  const totalReclaimable = duplicateGroups.reduce((acc, group) => acc + group.reclaimableSize, 0);
  const selectedMoveFiles = useMemo(() => files.filter(file => selectedForMove.has(file.id)), [files, selectedForMove]);

  const toggleMove = (id: string) => {
    setSelectedForMove(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const findSemanticNearDuplicates = async () => {
    setSemanticBusy(true);
    setSemanticStatus('Reading indexed embeddings…');
    try {
      const vectors = await listVectors(corpusKey);
      const groups = findSemanticDuplicatesFromVectors(files, vectors, semanticThreshold);
      setSemanticGroups(groups);
      setSemanticStatus(groups.length ? `${groups.length} semantic group(s) found — review before moving.` : 'No semantic near-duplicate groups found.');
    } catch (error) {
      console.warn('[DuplicateFinder] semantic duplicate scan failed', error);
      setSemanticGroups([]);
      setSemanticStatus('Semantic scan unavailable; index content first.');
    } finally {
      setSemanticBusy(false);
    }
  };

  const selectSemanticGroup = (group: SemanticDuplicateGroup) => {
    setSelectedForMove(previous => {
      const next = new Set(previous);
      group.files.forEach(file => next.add(file.id));
      return next;
    });
  };

  const selectAllMoveCandidates = () => {
    const ids = duplicateGroups.flatMap(group => group.files.map(file => file.id));
    setSelectedForMove(new Set([...ids, ...semanticGroups.flatMap(group => group.files.map(file => file.id))]));
  };

  const toggleMoveChecked = (id: string) => toggleMove(id);

  const confirmedIds = new Set(
    duplicateGroups
      .filter(g => g.hash.startsWith('sha256:'))
      .flatMap(g => g.files.map(f => f.id))
  );

  const toggleSelect = (id: string) => {
    if (!confirmedIds.has(id)) return;
    const next = new Set(selectedDuplicates);
    if (next.has(id)) next.delete(id);
    else next.add(id);
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
    const safe = Array.from(selectedDuplicates).filter(id => confirmedIds.has(id));
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

      {duplicateGroups.length === 0 && semanticGroups.length === 0 ? (
        <div className="text-center py-12 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-800 space-y-3">
          <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto" />
          <h3 className="text-base font-bold">No exact candidate groups</h3>
          <p className="text-xs text-zinc-500 mt-1">You can still scan indexed embeddings for semantic near-duplicates.</p>
          <div className="flex items-center justify-center gap-2">
            <select value={semanticThreshold} onChange={e => setSemanticThreshold(Number(e.target.value))} className="text-xs rounded-lg border px-2 py-1.5 bg-white dark:bg-zinc-900">
              <option value="0.85">85% similarity</option><option value="0.9">90% similarity</option><option value="0.95">95% similarity</option>
            </select>
            <button type="button" onClick={() => void findSemanticNearDuplicates()} disabled={semanticBusy} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold disabled:opacity-50">
              {semanticBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {semanticBusy ? 'Scanning…' : 'Find semantic duplicates'}
            </button>
          </div>
          {semanticStatus && <p className="text-[11px] text-zinc-500">{semanticStatus}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white dark:bg-zinc-900 p-4 rounded-2xl border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="font-semibold">{duplicateGroups.length} exact/candidate group(s)</span>
              <button type="button" onClick={selectAllMoveCandidates} className="text-blue-600 hover:underline font-medium">
                Select all for move
              </button>
              <button type="button" onClick={handleSelectAllDuplicates} className="text-indigo-600 hover:underline font-medium">
                Select non-primary for trash
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
            <div className="flex items-center gap-2">
              <button type="button" disabled={selectedForMove.size === 0} onClick={() => setShowMoveModal(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold disabled:opacity-40">
                <FolderInput className="w-3.5 h-3.5" /> Move selected ({selectedForMove.size})
              </button>
              <button type="button" disabled={selectedDuplicates.size === 0} onClick={handleCleanSelected} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-600 text-white text-xs font-bold disabled:opacity-40">
                <Trash2 className="w-3.5 h-3.5" /> Trash verified ({selectedDuplicates.size})
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/50 dark:bg-indigo-950/20 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-bold"><Sparkles className="w-4 h-4 text-indigo-500" /> Semantic near-duplicate review</div>
                <p className="text-[11px] text-zinc-500 mt-1">Uses indexed embeddings to find similar content. Similar is not proof of duplication; trash stays locked to SHA-256.</p>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-zinc-500">Similarity</label>
                <select value={semanticThreshold} onChange={e => setSemanticThreshold(Number(e.target.value))} className="text-xs rounded-lg border px-2 py-1.5 bg-white dark:bg-zinc-900">
                  <option value="0.85">85%</option><option value="0.9">90%</option><option value="0.95">95%</option>
                </select>
                <button type="button" onClick={() => void findSemanticNearDuplicates()} disabled={semanticBusy} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold disabled:opacity-50">
                  {semanticBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {semanticBusy ? 'Scanning…' : 'Find similar files'}
                </button>
              </div>
            </div>
            {semanticStatus && <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{semanticStatus}</p>}
            {semanticGroups.map((group, index) => (
              <div key={`${index}-${group.files.map(file => file.id).join('-')}`} className="rounded-xl border border-indigo-200/70 dark:border-indigo-900/60 bg-white/70 dark:bg-zinc-900/60 p-3">
                <div className="flex items-center justify-between gap-2 mb-2"><span className="text-xs font-bold text-indigo-700 dark:text-indigo-300">Semantic similarity {Math.round(group.similarity * 100)}%</span><button type="button" onClick={() => selectSemanticGroup(group)} className="text-[11px] text-indigo-600 hover:underline">Select group for move</button></div>
                <div className="space-y-1">{group.files.map(file => <label key={file.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={selectedForMove.has(file.id)} onChange={() => toggleMove(file.id)} /><span className="truncate">{file.name}</span></label>)}</div>
              </div>
            ))}
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
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {group.files.map((file, idx) => (
                    <li key={file.id} className="flex items-center gap-3 px-4 py-3">
                      <button type="button" onClick={() => toggleMoveChecked(file.id)} className="shrink-0" title="Select for move">
                        {selectedForMove.has(file.id) ? <Check className="w-4 h-4 text-blue-600" /> : <span className="w-4 h-4 inline-block rounded border border-zinc-300 dark:border-zinc-600" />}
                      </button>
                      {confirmed ? (
                        <button type="button" onClick={() => toggleSelect(file.id)} className="shrink-0" title="Select for trash">
                          {selectedDuplicates.has(file.id) ? <Trash2 className="w-3.5 h-3.5 text-red-600" /> : <span className="w-3.5 h-3.5 inline-block rounded border border-dashed border-red-300 dark:border-red-700" />}
                        </button>
                      ) : (
                        <span className="w-3.5 h-3.5 inline-block rounded border border-dashed border-zinc-300 dark:border-zinc-600 opacity-40 shrink-0" title="Verify SHA-256 before trash" />
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
      <MoveToFolderModal
        isOpen={showMoveModal}
        onClose={() => setShowMoveModal(false)}
        selectedFiles={selectedMoveFiles}
        folders={folders}
        allFiles={files}
        onConfirmMove={folderId => {
          onMoveFiles(selectedMoveFiles.map(file => file.id), folderId);
          setSelectedForMove(new Set());
          setShowMoveModal(false);
        }}
        onCreateFolder={onCreateFolder}
      />
    </div>
  );
};
