import React, { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileUp, LockKeyhole, ShieldCheck } from 'lucide-react';
import {
  createLocalBackupBlob,
  getLocalBackupSummary,
  inspectLocalBackup,
  restoreLocalBackup,
  type LocalBackupPayload,
  type LocalBackupSummary,
} from '../lib/localBackup';

const formatCount = (value: number) => value.toLocaleString();
const formatBytes = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export const LocalBackupManager: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pendingRestore, setPendingRestore] = useState<LocalBackupPayload | null>(null);
  const [summary, setSummary] = useState<LocalBackupSummary | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [busy, setBusy] = useState<'export' | 'inspect' | 'restore' | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const handleExport = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    if (exportPassphrase.length < 12) {
      setMessage({ kind: 'error', text: 'Choose a backup passphrase with at least 12 characters.' });
      return;
    }
    if (exportPassphrase !== confirmPassphrase) {
      setMessage({ kind: 'error', text: 'The backup passphrases do not match.' });
      return;
    }
    setBusy('export');
    try {
      const blob = await createLocalBackupBlob(exportPassphrase);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `drive-semantic-local-backup-${new Date().toISOString().slice(0, 10)}.dssbackup`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage({ kind: 'success', text: `Encrypted backup download started (${formatBytes(blob.size)}). Store the passphrase separately; it cannot be recovered.` });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Could not create the backup.' });
    } finally {
      setExportPassphrase('');
      setConfirmPassphrase('');
      setBusy(null);
    }
  };

  const handleInspect = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    setPendingRestore(null);
    setSummary(null);
    setRestoreConfirmed(false);
    if (!selectedFile) {
      setMessage({ kind: 'error', text: 'Choose a .dssbackup file first.' });
      return;
    }
    setBusy('inspect');
    try {
      const payload = await inspectLocalBackup(selectedFile, importPassphrase);
      setPendingRestore(payload);
      setSummary(getLocalBackupSummary(payload));
      setMessage({ kind: 'success', text: 'Backup decrypted and validated locally. Review its contents before restoring.' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Could not inspect the backup.' });
    } finally {
      setImportPassphrase('');
      setBusy(null);
    }
  };

  const handleRestore = async () => {
    if (!pendingRestore || !restoreConfirmed) return;
    setBusy('restore');
    setMessage(null);
    try {
      const result = await restoreLocalBackup(pendingRestore);
      setPendingRestore(null);
      setSummary(null);
      setSelectedFile(null);
      setRestoreConfirmed(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setMessage({
        kind: 'success',
        text: `Restore complete: ${formatCount(result.documents)} documents, ${formatCount(result.vectors)} vectors, ${formatCount(result.vaultItems)} vault items, and ${formatCount(result.driveSnapshots)} Drive snapshots merged. Sync Drive to refresh its snapshot.`,
      });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Restore stopped; some earlier records may already have been merged.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <header className="rounded-2xl border border-blue-200 dark:border-blue-900/50 bg-gradient-to-r from-blue-50 to-indigo-50/70 dark:from-blue-950/30 dark:to-indigo-950/20 p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-blue-600 p-2.5 text-white"><ShieldCheck className="h-5 w-5" /></div>
          <div>
            <h1 className="text-lg font-bold">Encrypted local backup</h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
              Create a passphrase-protected file on this device, or inspect and merge one from a previous backup. Backup creation and restore run in your browser; no backup is uploaded to a server.
            </p>
          </div>
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Download className="h-4 w-4 text-blue-600" />
            <h2 className="font-bold">Create backup</h2>
          </div>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Includes extracted/indexed text, semantic vectors, Drive metadata snapshots, and already-encrypted vault items. The backup file is compressed and encrypted with a separate passphrase (PBKDF2-SHA-256 + AES-GCM).
          </p>
          <form onSubmit={handleExport} className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs font-semibold">Backup passphrase (minimum 12 characters)</span>
              <input type="password" autoComplete="new-password" value={exportPassphrase} onChange={event => setExportPassphrase(event.target.value)} className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-semibold">Confirm passphrase</span>
              <input type="password" autoComplete="new-password" value={confirmPassphrase} onChange={event => setConfirmPassphrase(event.target.value)} className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm" />
            </label>
            <button type="submit" disabled={busy !== null} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              <LockKeyhole className="h-4 w-4" /> {busy === 'export' ? 'Encrypting backup…' : 'Create encrypted backup'}
            </button>
          </form>
        </div>

        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <FileUp className="h-4 w-4 text-emerald-600" />
            <h2 className="font-bold">Inspect and restore</h2>
          </div>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Choose a backup and enter its passphrase to decrypt and validate it in memory. Nothing is changed until you review the record counts and confirm the merge.
          </p>
          <form onSubmit={handleInspect} className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs font-semibold">Backup file</span>
              <input ref={fileInputRef} type="file" accept=".dssbackup,application/octet-stream" onChange={event => {
                setSelectedFile(event.target.files?.[0] || null);
                setPendingRestore(null);
                setSummary(null);
                setRestoreConfirmed(false);
                setMessage(null);
              }} className="block w-full text-xs file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 dark:file:bg-zinc-800 file:px-3 file:py-2" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-semibold">Backup passphrase</span>
              <input type="password" autoComplete="current-password" value={importPassphrase} onChange={event => setImportPassphrase(event.target.value)} className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm" />
            </label>
            <button type="submit" disabled={busy !== null || !selectedFile} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
              {busy === 'inspect' ? 'Decrypting and validating…' : 'Inspect backup'}
            </button>
          </form>
          {summary && pendingRestore && (
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/70 dark:bg-emerald-950/20 p-3 space-y-2">
              <p className="text-xs font-bold">Backup contents · {new Date(summary.createdAt).toLocaleString()}</p>
              <p className="text-xs text-zinc-600 dark:text-zinc-300">
                {formatCount(summary.documentCount)} indexed documents · {formatCount(summary.vectorCount)} vectors · {formatCount(summary.vaultItemCount)} vault items · {formatCount(summary.driveSnapshotCount)} Drive snapshots ({formatCount(summary.driveFileCount)} files, {formatCount(summary.folderCount)} folders)
              </p>
              <label className="flex items-start gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                <input type="checkbox" checked={restoreConfirmed} onChange={event => setRestoreConfirmed(event.target.checked)} className="mt-0.5" />
                <span>Merge this backup into this browser. Matching documents and Drive snapshots are replaced; a restored document’s vector profile is replaced by the backup profile (or cleared if none was saved). Matching vault items are overwritten, while unrelated records are retained.</span>
              </label>
              <button type="button" onClick={() => void handleRestore()} disabled={!restoreConfirmed || busy !== null} className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">
                {busy === 'restore' ? 'Restoring…' : 'Restore as merge'}
              </button>
            </div>
          )}
        </div>
      </section>

      {message && (
        <div role="status" className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${message.kind === 'error' ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300' : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'}`}>
          {message.kind === 'error' ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}

      <section className="rounded-2xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/20 p-4 space-y-2">
        <h3 className="text-xs font-bold text-amber-900 dark:text-amber-300">Scope and safety</h3>
        <ul className="list-disc pl-5 space-y-1 text-xs text-amber-900/80 dark:text-amber-200/80">
          <li>Offline cached file bytes are excluded because they are a size-limited, re-downloadable cache; re-pin files after restoring. Session credentials, Drive change tokens, embedding consent, and diagnostics are never exported.</li>
          <li>The backup includes readable extracted document text and vector records, so treat the encrypted file as sensitive. If you forget its separate passphrase, it cannot be recovered.</li>
          <li>Vault items are copied as ciphertext; restoring them does not change their original vault passphrase. Sync Drive after restore to refresh metadata and obtain fresh sync tokens.</li>
          <li>Restore merges into local IndexedDB. Matching keys are overwritten, unrelated records are retained, and the operation is not atomic across all browser stores; a storage/quota failure can leave a partial merge.</li>
          <li>Backups are capped at 128 MB of uncompressed data and 160 MB as a file to protect browser memory and storage.</li>
        </ul>
      </section>
    </div>
  );
};
