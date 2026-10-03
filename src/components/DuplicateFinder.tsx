import React, { useMemo, useState } from 'react';
import { Copy, CheckCircle, Check, FileText, FolderInput, Sparkles, Loader2 } from 'lucide-react';
import { DriveFile } from '../types';
import { analyzeSemanticDuplicatesFromVectors, chooseKeepCandidate, findDuplicates, SemanticDuplicateGroup, UncertainSemanticPair } from '../lib/duplicateEngine';
import { countVectors, listVectors } from '../lib/vectorIndex';
import { isLegacyTitleEmbeddingChunk } from '../lib/contentIndex';
import { EMBED_CONFIG } from '../lib/embeddings/config';
import { MoveToFolderModal } from './MoveToFolderModal';
import { formatBytes } from '../lib/driveApi';

interface DuplicateFinderProps {
  files: DriveFile[];
  folders: import('../types').FolderItem[];
  corpusKey: string;
  onMoveFiles: (ids: string[], folderId: string | undefined) => void;
  onCreateFolder: (folder: import('../types').FolderItem) => void;
  onVerifyHashes?: (fileIds: string[]) => Promise<void>;
  verifyBusy?: boolean;
  onDeepCheck?: (fileIds: string[]) => Promise<void>;
  deepCheckBusy?: boolean;
}

const SEMANTIC_THRESHOLDS = [
  { value: 0.85, label: '85%', name: 'Broad', help: 'More related files; review carefully.' },
  { value: 0.9, label: '90%', name: 'Balanced', help: 'Recommended starting point.' },
  { value: 0.95, label: '95%', name: 'Strict', help: 'Only very similar content.' },
] as const;

export const DuplicateFinder: React.FC<DuplicateFinderProps> = ({ files, folders, corpusKey, onMoveFiles, onCreateFolder, onVerifyHashes, verifyBusy, onDeepCheck, deepCheckBusy }) => {
  const [selectedForMove, setSelectedForMove] = useState<Set<string>>(() => new Set());
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [semanticGroups, setSemanticGroups] = useState<SemanticDuplicateGroup[]>([]);
  const [uncertainPairs, setUncertainPairs] = useState<UncertainSemanticPair[]>([]);
  const [semanticThreshold, setSemanticThreshold] = useState(0.9);
  const [semanticBusy, setSemanticBusy] = useState(false);
  const [semanticStatus, setSemanticStatus] = useState('');
  const [actionStatus, setActionStatus] = useState('');
  const [indexedVectorCount, setIndexedVectorCount] = useState(0);
  const duplicateGroups = findDuplicates(files);
  const totalReclaimable = duplicateGroups.reduce((acc, group) => acc + group.reclaimableSize, 0);
  const selectedMoveFiles = useMemo(() => files.filter(file => selectedForMove.has(file.id)), [files, selectedForMove]);

  React.useEffect(() => {
    let cancelled = false;
    void countVectors(corpusKey).then(count => {
      if (!cancelled) setIndexedVectorCount(count);
    });
    return () => { cancelled = true; };
  }, [corpusKey]);

  React.useEffect(() => {
    const liveIds = new Set(files.map(file => file.id));
    setSelectedForMove(previous => {
      const next = new Set([...previous].filter(id => liveIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [files]);

  const toggleMove = (id: string) => {
    setSelectedForMove(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const findSemanticNearDuplicates = async () => {
    if (!indexedVectorCount) {
      setSemanticStatus('No indexed embeddings found. Open Search and index extractable content first.');
      return;
    }
    setSemanticBusy(true);
    setSemanticStatus('Comparing indexed file profiles…');
    try {
      const vectors = (await listVectors(corpusKey)).filter(vector =>
        vector.embeddingModel === EMBED_CONFIG.model &&
        vector.embeddingVersion === EMBED_CONFIG.version &&
        vector.dimension === EMBED_CONFIG.dimension
      );
      if (!vectors.length) {
        setSemanticGroups([]);
        setUncertainPairs([]);
        setSemanticStatus('No compatible current-model vectors found. In Search, enable embeddings and run Index / Rebuild before scanning.');
        return;
      }
      const liveIds = new Set(files.map(file => file.id));
      const legacyProfileIds = new Set(vectors
        .filter(vector => liveIds.has(vector.fileId) && isLegacyTitleEmbeddingChunk(vector.text))
        .map(vector => vector.fileId));
      if (legacyProfileIds.size) {
        setSemanticGroups([]);
        setUncertainPairs([]);
        setSemanticStatus(`${legacyProfileIds.size} live profile(s) still include filenames in their vectors. In Search, set scope to All and click Index / Rebuild once, then scan again.`);
        return;
      }
      const analysis = analyzeSemanticDuplicatesFromVectors(files, vectors, semanticThreshold);
      setSemanticGroups(analysis.groups);
      setUncertainPairs(analysis.uncertainPairs);
      setSemanticStatus(analysis.groups.length || analysis.uncertainPairs.length
        ? `${analysis.groups.length} likely group(s), ${analysis.uncertainPairs.length} borderline pair(s) at ${Math.round(semanticThreshold * 100)}%. Similarity is review-only.`
        : `No likely or borderline duplicate pairs at ${Math.round(semanticThreshold * 100)}%. Try a broader threshold.`);
    } catch (error) {
      console.warn('[DuplicateFinder] semantic duplicate scan failed', error);
      setSemanticGroups([]);
      setUncertainPairs([]);
      setSemanticStatus('Semantic scan unavailable; index content first.');
    } finally {
      setSemanticBusy(false);
    }
  };

  const handleThresholdChange = (value: number) => {
    setSemanticThreshold(value);
    setSemanticGroups([]);
    setUncertainPairs([]);
    setSemanticStatus('Threshold changed. Scan again to refresh results.');
  };

  const handleDeepCheck = async (pair: UncertainSemanticPair) => {
    if (!onDeepCheck) {
      setSemanticStatus('Expanded OCR is unavailable in this session.');
      return;
    }
    try {
      setSemanticStatus('Checking selected PDFs with up to five additional middle pages…');
      await onDeepCheck(pair.files.map(file => file.id));
      setSemanticGroups([]);
      setUncertainPairs([]);
      setSemanticStatus('Expanded page samples updated. Run the semantic duplicate scan again.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSemanticStatus(`Expanded OCR failed: ${message}`);
    }
  };

  const selectSemanticGroup = (group: SemanticDuplicateGroup) => {
    setSelectedForMove(previous => {
      const next = new Set(previous);
      const keepId = chooseKeepCandidate(group.files).file.id;
      group.files.filter(file => file.id !== keepId).forEach(file => next.add(file.id));
      return next;
    });
  };

  const selectAllMoveCandidates = () => {
    const ids = duplicateGroups.flatMap(group => { const keepId = chooseKeepCandidate(group.files).file.id; return group.files.filter(file => file.id !== keepId).map(file => file.id); });
    const semanticIds = semanticGroups.flatMap(group => { const keepId = chooseKeepCandidate(group.files).file.id; return group.files.filter(file => file.id !== keepId).map(file => file.id); });
    const next = new Set([...ids, ...semanticIds]);
    setSelectedForMove(next);
    setActionStatus(next.size
      ? `Selected ${next.size} candidate file(s) for move. Click “Move selected”.`
      : 'No non-primary candidates to move.');
  };

  const toggleMoveChecked = (id: string) => toggleMove(id);

  const handleDeselectAll = () => {
    setSelectedForMove(new Set());
    setSelectedForMove(new Set());
    setActionStatus('Selection cleared.');
  };

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
                  SHA-256 · semantic · size/name candidates
                </span>
              </div>
              <p className="text-xs sm:text-sm text-zinc-400 mt-1 max-w-xl">
                Files are never deleted or sent to Drive Trash. SHA-256 is used only to prove exact duplicates before review/move.
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

      {duplicateGroups.length === 0 && semanticGroups.length === 0 && uncertainPairs.length === 0 ? (
        <div className="text-center py-12 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-800 space-y-3">
          <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto" />
          <h3 className="text-base font-bold">No exact candidate groups</h3>
          <p className="text-xs text-zinc-500 mt-1">You can still scan indexed embeddings for semantic near-duplicates.</p>
          <div className="flex items-center justify-center gap-2">
            <div className="flex gap-1" role="group" aria-label="Semantic similarity threshold">
              {SEMANTIC_THRESHOLDS.map(option => <button key={option.value} type="button" onClick={() => handleThresholdChange(option.value)} aria-pressed={semanticThreshold === option.value} title={`${option.name}: ${option.help}`} className={`px-2 py-1.5 rounded-lg border text-[11px] font-semibold ${semanticThreshold === option.value ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'}`}>{option.label}</button>)}
            </div>
            <button type="button" onClick={() => void findSemanticNearDuplicates()} disabled={semanticBusy} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold disabled:opacity-50">
              {semanticBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {semanticBusy ? 'Scanning…' : 'Find semantic duplicates'}
            </button>
          </div>
          <p className="text-[11px] text-zinc-500">{indexedVectorCount ? `${indexedVectorCount} indexed embedding vector(s) available.` : 'Index extractable content from Search before scanning.'}</p>
          {semanticStatus && <p className="text-[11px] text-zinc-500" role="status">{semanticStatus}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white dark:bg-zinc-900 p-4 rounded-2xl border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="font-semibold">{duplicateGroups.length} exact/candidate group(s)</span>
              <button type="button" onClick={selectAllMoveCandidates} className="text-blue-600 hover:underline font-medium">
                Select non-primary for move
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
                    if (!ids.length) {
                      setActionStatus('All candidate groups are already SHA-256 verified (or none pending).');
                      return;
                    }
                    setActionStatus('Verifying SHA-256… Demo Drive cannot download real bytes — sign in with Google for hash verify. Trash stays locked until hashes succeed.');
                    onVerifyHashes(ids);
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
              <button type="button" disabled={selectedDuplicates.size === 0} onClick={handleCleanSelected} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-600 text-white text-xs font-bold disabled:opacity-40" title="Trash only after SHA-256 verify">
                <Trash2 className="w-3.5 h-3.5" /> Trash verified ({selectedDuplicates.size})
              </button>
            </div>
          </div>
          {actionStatus && (
            <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-xl px-3 py-2" role="status">
              {actionStatus}
            </p>
          )}

          <div className="rounded-2xl border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/50 dark:bg-indigo-950/20 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-bold"><Sparkles className="w-4 h-4 text-indigo-500" /> Semantic near-duplicate review</div>
                <p className="text-[11px] text-zinc-500 mt-1">Compares multiple content chunks in order, not names or file sizes. Same-topic files are not proof of duplicates; results are review-only; no delete or trash action exists.</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-zinc-500">Content match</span>
                <div className="flex gap-1" role="group" aria-label="Semantic similarity threshold">
                  {SEMANTIC_THRESHOLDS.map(option => <button key={option.value} type="button" onClick={() => handleThresholdChange(option.value)} aria-pressed={semanticThreshold === option.value} title={`${option.name}: ${option.help}`} className={`px-2 py-1.5 rounded-lg border text-[11px] font-semibold ${semanticThreshold === option.value ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'}`}>{option.label}</button>)}
                </div>
                <button type="button" onClick={() => void findSemanticNearDuplicates()} disabled={semanticBusy} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold disabled:opacity-50">
                  {semanticBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {semanticBusy ? 'Scanning…' : 'Find similar files'}
                </button>
              </div>
            </div>
            <p className="text-[11px] text-zinc-500">{indexedVectorCount ? `${indexedVectorCount} indexed embedding vector(s) available.` : 'Index extractable content from Search before scanning.'}</p>
            {semanticStatus && <p className="text-[11px] text-zinc-600 dark:text-zinc-400" role="status">{semanticStatus}</p>}
            {semanticGroups.map((group, index) => (
              <div key={`${index}-${group.files.map(file => file.id).join('-')}`} className="rounded-xl border border-indigo-200/70 dark:border-indigo-900/60 bg-white/70 dark:bg-zinc-900/60 p-3">
                <div className="flex items-center justify-between gap-2 mb-2"><span className="text-xs font-bold text-indigo-700 dark:text-indigo-300" title="Strongest direct aligned-chunk overlap score in this connected group. Some members may be linked indirectly; review before acting.">Best direct content-match score {Math.round(group.bestPairSimilarity * 100)}%</span><button type="button" onClick={() => selectSemanticGroup(group)} className="text-[11px] text-indigo-600 hover:underline">Select non-primary for move</button></div>
                <div className="space-y-1">{group.files.map(file => <label key={file.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={selectedForMove.has(file.id)} onChange={() => toggleMove(file.id)} /><span className="truncate">{file.name}</span></label>)}</div>
              </div>
            ))}
            {uncertainPairs.length > 0 && (
              <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/20 p-3 space-y-2">
                <div className="text-xs font-bold text-amber-800 dark:text-amber-300">Borderline pairs · more evidence may help</div>
                <p className="text-[11px] text-zinc-600 dark:text-zinc-400">These pairs are within five points below the selected score. For PDFs, deep-checking adds up to five middle pages to the sample; it does not OCR the whole book.</p>
                {uncertainPairs.map(pair => {
                  const hasDrivePdf = pair.files.some(file => file.isGoogleDriveItem && (file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.name)));
                  return (
                    <div key={pair.files.map(file => file.id).sort().join('|')} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t border-amber-200 dark:border-amber-900 pt-2">
                      <span className="text-[11px] truncate">{pair.files[0].name} ↔ {pair.files[1].name} · {Math.round(pair.similarity * 100)}%</span>
                      {hasDrivePdf ? (
                        <button
                          type="button"
                          disabled={deepCheckBusy || !onDeepCheck}
                          onClick={() => void handleDeepCheck(pair)}
                          className="shrink-0 px-2 py-1 rounded border border-amber-400 text-amber-800 dark:text-amber-200 text-[10px] font-semibold disabled:opacity-50"
                        >
                          {deepCheckBusy ? 'Checking…' : 'Expand PDF sample'}
                        </button>
                      ) : (
                        <span className="shrink-0 text-[10px] text-zinc-500">No Drive PDF to expand</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {duplicateGroups.map(group => {
            const confirmed = group.verification === 'sha256';
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
                        onClick={() => {
                          setActionStatus('Verifying group SHA-256… Real Google Drive sign-in required. Trash stays locked until success.');
                          onVerifyHashes(group.files.map(f => f.id));
                        }}
                      >
                        Verify group
                      </button>
                    )}
                    <span className="text-zinc-500">{group.fileCount} files · reclaim ~{formatBytes(group.reclaimableSize)}</span>
                  </div>
                </div>
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {group.files.map(file => (
                    <li key={file.id} className="flex items-center gap-3 px-4 py-3">
                      <button type="button" onClick={() => toggleMoveChecked(file.id)} className="shrink-0" title="Select for move">
                        {selectedForMove.has(file.id) ? <Check className="w-4 h-4 text-blue-600" /> : <span className="w-4 h-4 inline-block rounded border border-zinc-300 dark:border-zinc-600" />}
                      </button>
                      <FileText className="w-4 h-4 text-zinc-400 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold truncate">{file.name}</div>
                        <div className="text-[11px] text-zinc-500">
                          {formatBytes(file.size)} · {new Date(file.modifiedTime).toLocaleDateString()}
                        </div>
                      </div>
                      {file.id === chooseKeepCandidate(group.files).file.id && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300" title={chooseKeepCandidate(group.files).reasons.join(', ')}>
                          Keep candidate
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
