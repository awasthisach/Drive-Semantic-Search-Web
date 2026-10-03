/* Browser-local OCR using PDF.js + Tesseract.js loaded only when OCR is needed. */

declare global {
  interface Window {
    Tesseract?: any;
    pdfjsLib?: any;
  }
}

const TESSERACT_VERSION = '5.1.1';
const PDFJS_VERSION = '3.11.174';
const TESS_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';
const TESS_WORKER_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`;
const TESS_CORE_PATH = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@4.0.4/tesseract-core.wasm.js';
const PDFJS_WORKER_PATH = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;

/** Max pages to OCR for semantic indexing (first N + last N) */
const MAX_OCR_PAGES_FIRST = 5;
const MAX_OCR_PAGES_LAST = 5;

/** Thrown when the caller aborts extraction (Cancel / timeout). */
export class OcrAbortedError extends Error {
  constructor(message = 'OCR aborted') {
    super(message);
    this.name = 'OcrAbortedError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OcrAbortedError();
}

function loadScript(src: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-ocr-src="${src}"]`);
    if (existing) {
      if ((existing as any).__loaded) resolve();
      else {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      }
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.ocrSrc = src;
    script.onload = () => { (script as any).__loaded = true; resolve(); };
    script.onerror = () => reject(new Error(`Failed to load OCR dependency: ${src}`));
    document.head.appendChild(script);
    if (signal) {
      const onAbort = () => reject(new OcrAbortedError());
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function ensureOcr(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!window.Tesseract) await loadScript(`https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`, signal);
  throwIfAborted(signal);
  if (!window.pdfjsLib) await loadScript(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`, signal);
  throwIfAborted(signal);
  if (!window.Tesseract || !window.pdfjsLib) throw new Error('OCR engine unavailable');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;
}

async function createWorker(signal?: AbortSignal): Promise<any> {
  await ensureOcr(signal);
  throwIfAborted(signal);
  return window.Tesseract.createWorker('eng+hin', 1, {
    workerPath: TESS_WORKER_PATH,
    corePath: TESS_CORE_PATH,
    langPath: TESS_LANG_PATH,
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => {
      if (signal?.aborted) {
        reject(new OcrAbortedError());
        return;
      }
      b ? resolve(b) : reject(new Error('OCR canvas conversion failed'));
    }, 'image/png', 1);
  });
}

export async function ocrImage(buffer: ArrayBuffer, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const worker = await createWorker(signal);
  try {
    throwIfAborted(signal);
    const { data } = await worker.recognize(new Blob([buffer]));
    throwIfAborted(signal);
    return String(data?.text || '').trim();
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

/**
 * OCR only first 5 + last 5 pages of a PDF for semantic indexing.
 * This prevents hang on large scanned PDFs while still capturing key content.
 */
export async function ocrPdf(buffer: ArrayBuffer, signal?: AbortSignal): Promise<string> {
  await ensureOcr(signal);
  throwIfAborted(signal);

  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const totalPages = pdf.numPages;

  // Decide which pages to OCR
  const pagesToProcess = new Set<number>();

  // First N pages
  for (let i = 1; i <= Math.min(MAX_OCR_PAGES_FIRST, totalPages); i++) {
    pagesToProcess.add(i);
  }

  // Last N pages (avoid duplicate if PDF is short)
  for (let i = Math.max(1, totalPages - MAX_OCR_PAGES_LAST + 1); i <= totalPages; i++) {
    pagesToProcess.add(i);
  }

  const sortedPages = Array.from(pagesToProcess).sort((a, b) => a - b);

  const worker = await createWorker(signal);
  const pages: string[] = [];

  try {
    for (const pageNo of sortedPages) {
      throwIfAborted(signal);

      const page = await pdf.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(1.5, Math.max(1, 1400 / base.width)); // slightly lower scale for speed
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error(`OCR canvas unavailable for PDF page ${pageNo}`);

      await page.render({ canvasContext: ctx, viewport }).promise;
      throwIfAborted(signal);

      const blob = await canvasToBlob(canvas, signal);
      const { data } = await worker.recognize(blob);
      throwIfAborted(signal);

      const text = String(data?.text || '').trim();
      if (text) {
        pages.push(`[Page ${pageNo}/${totalPages}]\n${text}`);
      }

      // Cleanup
      canvas.width = 1;
      canvas.height = 1;
      page.cleanup?.();
    }

    return pages.join('\n\n').trim();
  } finally {
    await worker.terminate().catch(() => undefined);
    pdf.cleanup?.();
    pdf.destroy?.();
  }
}
