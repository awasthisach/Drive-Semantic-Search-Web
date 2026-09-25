import React, { useState } from 'react';
import {
  Folder,
  FolderPlus,
  FolderInput,
  X,
  Check,
  HardDrive,
  CheckCircle2,
} from 'lucide-react';
import { DriveFile, FolderItem } from '../types';

interface MoveToFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedFiles: DriveFile[];
  folders: FolderItem[];
  allFiles: DriveFile[];
  onConfirmMove: (targetFolderId: string | undefined) => void;
  onCreateFolder: (folder: FolderItem) => void;
}

const COLOR_MAP: Record<string, { bg: string; text: string; border: string }> = {
  emerald: { bg: 'bg-emerald-500/10 dark:bg-emerald-500/20', text: 'text-emerald-600 dark:text-emerald-400', border: 'border-emerald-500/30' },
  blue: { bg: 'bg-blue-500/10 dark:bg-blue-500/20', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-500/30' },
  purple: { bg: 'bg-purple-500/10 dark:bg-purple-500/20', text: 'text-purple-600 dark:text-purple-400', border: 'border-purple-500/30' },
  amber: { bg: 'bg-amber-500/10 dark:bg-amber-500/20', text: 'text-amber-600 dark:text-amber-400', border: 'border-amber-500/30' },
  rose: { bg: 'bg-rose-500/10 dark:bg-rose-500/20', text: 'text-rose-600 dark:text-rose-400', border: 'border-rose-500/30' },
  zinc: { bg: 'bg-zinc-500/10 dark:bg-zinc-500/20', text: 'text-zinc-600 dark:text-zinc-400', border: 'border-zinc-500/30' },
};

export const MoveToFolderModal: React.FC<MoveToFolderModalProps> = ({
  isOpen,
  onClose,
  selectedFiles,
  folders,
  allFiles,
  onConfirmMove,
  onCreateFolder,
}) => {
  const [selectedFolderId, setSelectedFolderId] = useState<string | 'root'>('root');
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderColor, setNewFolderColor] = useState('blue');

  if (!isOpen) return null;

  const handleCreateNewFolder = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newFolderName.trim();
    if (!trimmed) return;

    const newFolder: FolderItem = {
      id: `folder-${Date.now()}`,
      name: trimmed,
      color: newFolderColor,
      description: 'Custom folder',
      createdAt: new Date().toISOString(),
    };

    onCreateFolder(newFolder);
    setSelectedFolderId(newFolder.id);
    setNewFolderName('');
    setShowCreateFolder(false);
  };

  const handleMove = () => {
    if (!selectedFiles.length) return;
    const target = selectedFolderId === 'root' ? undefined : selectedFolderId;
    onConfirmMove(target);
  };
  const selectedFolderLabel = selectedFolderId === 'root'
    ? 'Main Drive (Root / Unfiled)'
    : folders.find(folder => folder.id === selectedFolderId)?.name || 'Selected folder';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        id="move-to-folder-modal"
        className="w-full max-w-lg bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-900/40">
              <FolderInput className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                Move {selectedFiles.length} {selectedFiles.length === 1 ? 'File' : 'Files'}
              </h3>
              <p className="text-xs text-zinc-500">Select target folder or create a new one</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition min-h-[40px] min-w-[40px] flex items-center justify-center"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Selected Files Preview Chips */}
        <div className="px-5 py-3 bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-100 dark:border-zinc-800 overflow-x-auto no-scrollbar flex items-center gap-2">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider shrink-0">
            Selected:
          </span>
          {selectedFiles.slice(0, 5).map(file => (
            <span
              key={file.id}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-800 dark:text-zinc-200 truncate max-w-[160px]"
              title={file.name}
            >
              <span className="truncate">{file.name}</span>
            </span>
          ))}
          {selectedFiles.length > 5 && (
            <span className="text-xs font-semibold text-zinc-500 shrink-0">
              +{selectedFiles.length - 5} more
            </span>
          )}
        </div>

        {/* Folder List */}
        <div className="p-5 overflow-y-auto space-y-2.5 flex-1">
          {/* Root Directory Option */}
          <div
            onClick={() => setSelectedFolderId('root')}
            className={`flex items-center justify-between p-3.5 rounded-2xl border cursor-pointer transition ${
              selectedFolderId === 'root'
                ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-500 shadow-xs ring-1 ring-blue-500'
                : 'bg-white dark:bg-zinc-900/80 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                <HardDrive className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-xs sm:text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Main Drive (Root / Unfiled)
                </h4>
                <p className="text-[11px] text-zinc-500">Not assigned to any specific subfolder</p>
              </div>
            </div>
            {selectedFolderId === 'root' && (
              <div className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center">
                <Check className="w-3.5 h-3.5" />
              </div>
            )}
          </div>

          {/* Existing Folders */}
          {folders.map(folder => {
            const count = allFiles.filter(f => f.folderId === folder.id).length;
            const isSelected = selectedFolderId === folder.id;
            const colorScheme = COLOR_MAP[folder.color] || COLOR_MAP.blue;

            return (
              <div
                key={folder.id}
                onClick={() => setSelectedFolderId(folder.id)}
                className={`flex items-center justify-between p-3.5 rounded-2xl border cursor-pointer transition ${
                  isSelected
                    ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-500 shadow-xs ring-1 ring-blue-500'
                    : 'bg-white dark:bg-zinc-900/80 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`p-2.5 rounded-xl ${colorScheme.bg} ${colorScheme.text} border ${colorScheme.border} shrink-0`}>
                    <Folder className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-xs sm:text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                      {folder.name}
                    </h4>
                    <p className="text-[11px] text-zinc-500 truncate">
                      {count} {count === 1 ? 'file' : 'files'}
                      {folder.description ? ` • ${folder.description}` : ''}
                    </p>
                  </div>
                </div>
                {isSelected && (
                  <div className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0">
                    <Check className="w-3.5 h-3.5" />
                  </div>
                )}
              </div>
            );
          })}

          {/* Create New Folder Inline Toggle */}
          {!showCreateFolder ? (
            <button
              type="button"
              onClick={() => setShowCreateFolder(true)}
              className="w-full py-3 px-4 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 hover:border-blue-500 dark:hover:border-blue-500 text-zinc-600 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400 font-medium text-xs flex items-center justify-center gap-2 transition min-h-[44px]"
            >
              <FolderPlus className="w-4 h-4" />
              <span>+ Create New Folder (नया फ़ोल्डर बनाएँ)</span>
            </button>
          ) : (
            <form onSubmit={handleCreateNewFolder} className="p-3.5 rounded-2xl border border-blue-200 dark:border-blue-900/50 bg-blue-50/50 dark:bg-blue-950/20 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
                  New Folder Details
                </span>
                <button
                  type="button"
                  onClick={() => setShowCreateFolder(false)}
                  className="text-xs text-zinc-400 hover:text-zinc-600"
                >
                  Cancel
                </button>
              </div>

              <input
                type="text"
                placeholder="Folder name (e.g. Marketing, Invoices, Photos)..."
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                autoFocus
                className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[38px]"
              />

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-zinc-500">Color:</span>
                  {(['blue', 'emerald', 'purple', 'amber', 'rose'] as const).map(color => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewFolderColor(color)}
                      className={`w-5 h-5 rounded-full transition ${
                        color === 'blue'
                          ? 'bg-blue-500'
                          : color === 'emerald'
                          ? 'bg-emerald-500'
                          : color === 'purple'
                          ? 'bg-purple-500'
                          : color === 'amber'
                          ? 'bg-amber-500'
                          : 'bg-rose-500'
                      } ${newFolderColor === color ? 'ring-2 ring-offset-2 ring-zinc-900 dark:ring-white scale-110' : 'opacity-70 hover:opacity-100'}`}
                      aria-label={`Select ${color} color`}
                    />
                  ))}
                </div>

                <button
                  type="submit"
                  disabled={!newFolderName.trim()}
                  className="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold transition min-h-[36px]"
                >
                  Create & Select
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 sm:p-5 border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 space-y-3">
          <div className="flex items-center gap-2 text-[11px] text-zinc-500" role="status">
            <FolderInput className="w-3.5 h-3.5 text-blue-600 shrink-0" />
            <span>Destination: <strong className="text-zinc-800 dark:text-zinc-200">{selectedFolderLabel}</strong></span>
          </div>
          <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition min-h-[40px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleMove}
            disabled={!selectedFiles.length}
            className="px-5 py-2 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg transition flex items-center gap-2 min-h-[40px]"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>
              Move {selectedFiles.length} {selectedFiles.length === 1 ? 'Item' : 'Items'} Here
            </span>
          </button>
          </div>
        </div>
      </div>
    </div>
  );
};
