import React, { useState } from 'react';
import { Lock, Unlock, Plus, Trash2, Eye, EyeOff, Shield, X } from 'lucide-react';
import { VaultFile } from '../types';
import { encryptDataWithWorker, decryptDataWithWorker } from '../lib/cryptoVault';

interface PrivacyVaultProps {
  vaultFiles: VaultFile[];
  onAddVaultFile: (file: VaultFile) => void;
  onDeleteVaultFile: (id: string) => void;
}

export const PrivacyVault: React.FC<PrivacyVaultProps> = ({
  vaultFiles,
  onAddVaultFile,
  onDeleteVaultFile,
}) => {
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [inputPass, setInputPass] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [isAddingFile, setIsAddingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [newFileTags, setNewFileTags] = useState('confidential');
  const [encrypting, setEncrypting] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ name: string; content: string } | null>(null);
  const [decryptingId, setDecryptingId] = useState<string | null>(null);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputPass || inputPass.length < 8) {
      setErrorMsg('Passphrase must be at least 8 characters');
      return;
    }

    // Existing vaults must be verified before opening. A fresh vault has no
    // verifier yet, so the first passphrase becomes its passphrase.
    if (vaultFiles.length > 0) {
      try {
        await decryptDataWithWorker(
          vaultFiles[0].encryptedData,
          vaultFiles[0].iv,
          vaultFiles[0].salt,
          inputPass
        );
      } catch {
        setErrorMsg('Incorrect vault passphrase or damaged vault item');
        return;
      }
    }

    setPassphrase(inputPass);
    setIsUnlocked(true);
    setErrorMsg('');
    setInputPass('');
  };

  const handleLock = () => {
    setIsUnlocked(false);
    setPassphrase('');
    setPreviewFile(null);
  };

  const handleAddEncrypted = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFileName.trim() || !newFileContent.trim() || !passphrase) return;
    setEncrypting(true);
    try {
      const { ciphertext, iv, salt } = await encryptDataWithWorker(newFileContent, passphrase);
      onAddVaultFile({
        id: 'vault-' + Date.now(),
        name: newFileName.trim() + '.aes',
        originalName: newFileName.trim(),
        size: newFileContent.length,
        mimeType: 'text/plain',
        encryptedData: ciphertext,
        iv,
        salt,
        uploadedAt: new Date().toISOString(),
        tags: newFileTags.split(',').map(t => t.trim()).filter(Boolean),
        notes: 'Encrypted in browser with AES-GCM',
      });
      setNewFileName('');
      setNewFileContent('');
      setIsAddingFile(false);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Encryption failed');
    } finally {
      setEncrypting(false);
    }
  };

  const handleDecrypt = async (file: VaultFile) => {
    if (!passphrase) return;
    setDecryptingId(file.id);
    try {
      const plainText = await decryptDataWithWorker(file.encryptedData, file.iv, file.salt, passphrase);
      setPreviewFile({ name: file.originalName || file.name, content: plainText });
      setErrorMsg('');
    } catch {
      setErrorMsg('Decrypt failed - wrong passphrase or corrupt data');
    } finally {
      setDecryptingId(null);
    }
  };

  if (!isUnlocked) {
    return (
      <div className="max-w-md mx-auto rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-amber-600" />
          <h2 className="font-bold text-sm">Privacy Vault</h2>
        </div>
        <p className="text-xs text-zinc-500">
          Choose your own passphrase (min 8 chars). Ciphertext is stored in IndexedDB on this device; the passphrase is never saved.
        </p>
        <form onSubmit={handleUnlock} className="space-y-3">
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={inputPass}
              onChange={e => setInputPass(e.target.value)}
              placeholder="Enter vault passphrase..."
              className="w-full px-3 py-2 pr-10 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm"
              autoComplete="off"
            />
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400" onClick={() => setShowPassword(s => !s)}>
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {errorMsg && <p className="text-xs text-red-500">{errorMsg}</p>}
          <button type="submit" className="w-full py-2.5 rounded-xl bg-amber-600 text-white text-xs font-bold flex items-center justify-center gap-2">
            <Unlock className="w-4 h-4" /> Unlock Vault
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-emerald-600" />
          <span className="font-bold text-sm">Vault unlocked</span>
          <span className="text-[10px] text-zinc-500">{vaultFiles.length} items</span>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setIsAddingFile(true)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold">
            <Plus className="w-3.5 h-3.5" /> Add note
          </button>
          <button type="button" onClick={handleLock} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs font-semibold">
            <Lock className="w-3.5 h-3.5" /> Lock
          </button>
        </div>
      </div>
      {errorMsg && <p className="text-xs text-red-500">{errorMsg}</p>}
      {isAddingFile && (
        <form onSubmit={handleAddEncrypted} className="rounded-xl border p-4 space-y-2 bg-white dark:bg-zinc-900">
          <input value={newFileName} onChange={e => setNewFileName(e.target.value)} placeholder="Title" className="w-full px-3 py-2 rounded-lg border text-sm" required />
          <textarea value={newFileContent} onChange={e => setNewFileContent(e.target.value)} placeholder="Secret text..." className="w-full px-3 py-2 rounded-lg border text-sm min-h-[100px]" required />
          <input value={newFileTags} onChange={e => setNewFileTags(e.target.value)} placeholder="tags" className="w-full px-3 py-2 rounded-lg border text-sm" />
          <div className="flex gap-2">
            <button type="submit" disabled={encrypting} className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold disabled:opacity-50">
              {encrypting ? 'Encrypting...' : 'Encrypt and save'}
            </button>
            <button type="button" onClick={() => setIsAddingFile(false)} className="px-3 py-2 rounded-lg border text-xs">Cancel</button>
          </div>
        </form>
      )}
      <div className="space-y-2">
        {vaultFiles.length === 0 && <p className="text-sm text-zinc-500 text-center py-8">No vault items yet.</p>}
        {vaultFiles.map(file => (
          <div key={file.id} className="flex items-center justify-between gap-2 rounded-xl border p-3 bg-white dark:bg-zinc-900">
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{file.originalName || file.name}</div>
              <div className="text-[10px] text-zinc-500">{(file.tags || []).join(', ')}</div>
            </div>
            <div className="flex gap-1 shrink-0">
              <button type="button" onClick={() => handleDecrypt(file)} disabled={decryptingId === file.id} className="px-2 py-1 rounded-lg border text-xs">Decrypt</button>
              <button type="button" onClick={() => onDeleteVaultFile(file.id)} className="px-2 py-1 rounded-lg border text-xs text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        ))}
      </div>
      {previewFile && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl max-w-lg w-full p-4 space-y-3">
            <div className="flex justify-between items-center">
              <span className="font-bold text-sm">{previewFile.name}</span>
              <button type="button" onClick={() => setPreviewFile(null)}><X className="w-4 h-4" /></button>
            </div>
            <pre className="text-xs whitespace-pre-wrap max-h-64 overflow-auto p-3 rounded-lg bg-zinc-100 dark:bg-zinc-800">{previewFile.content}</pre>
          </div>
        </div>
      )}
    </div>
  );
};
