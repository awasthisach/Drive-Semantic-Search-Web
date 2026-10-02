import React from 'react';
import { EMBED_CONFIG } from '../lib/embeddings/config';
import { grantEmbeddingConsent } from '../lib/embeddings/consent';
import { logDiag } from '../lib/diagnostics';

export type EmbeddingConsentModalProps = {
  open: boolean;
  onClose: () => void;
  onAllow: () => void;
  onTextOnly: () => void;
};

export function EmbeddingConsentModal({ open, onClose, onAllow, onTextOnly }: EmbeddingConsentModalProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="embed-consent-title"
    >
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl p-4 space-y-3 text-sm">
        <h2 id="embed-consent-title" className="text-base font-semibold">
          Semantic embeddings (optional)
        </h2>
        <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
          Neural search sends extracted document text (including OCR) from files you index to the embedding worker.
          Drive access tokens are never sent. Vectors stay in this browser (IndexedDB). Without consent, local
          BM25/metadata search still works.
        </p>
        <p className="font-mono text-[11px] break-all text-zinc-500">{EMBED_CONFIG.endpoint}</p>
        <button
          type="button"
          className="w-full px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold"
          onClick={() => {
            grantEmbeddingConsent('selected_corpus');
            logDiag('info', 'embedding.consent', 'granted');
            onAllow();
          }}
        >
          Allow embeddings for indexed files
        </button>
        <button
          type="button"
          className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 text-xs font-semibold"
          onClick={() => {
            logDiag('info', 'embedding.consent', 'text-only this run');
            onTextOnly();
          }}
        >
          Use local text search only
        </button>
        <button
          type="button"
          className="w-full px-3 py-2 rounded-lg text-xs text-zinc-500"
          onClick={() => {
            logDiag('info', 'embedding.consent', 'cancelled');
            onClose();
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
