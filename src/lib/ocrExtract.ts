/* Browser-local PDF.js text extraction with selective Tesseract OCR fallback. */

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

export const PDF_FULL_OCR_MAX_PAGES = 10;
export const PDF_EDGE_OCR_PAGES = 5;
export const PDF_EXTRA_MIDDLE_OCR_PAGES = 5;
export const PDF_EXTRACTION_POLICY_VERSION = 'pdf-page-sampled-v1';

export type PdfOcrMode = 'sample' | 'expanded';
export type PdfOcrPolicy = 'all-pages' | 'first-last-5' | 'first-last-5-plus-middle';

export interface PdfOcrCoverage {
  totalPages: number;
  policy: PdfOcrPolicy;
  /** Page numbers included in the semantic profile under the active policy. */
  sampledPages: number[];
  /** Pages where OCR was actually attempted because native text was sparse. */
  attemptedOcrPages: number[];
  /** Attempted pages from which OCR returned non-empty text. */
  successfulOcrPages: number[];
  /** Pages omitted by the current bounded content-sampling policy. */
  deferredPageCount: number;
  /** Pages with sufficient selectable text, included without OCR. */
  nativeTextPageCount: number;
}

export interface PdfTextExtraction {
  text: string;
  coverage: PdfOcrCoverage;
}

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

async function ensurePdfJs(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!window.pdfjsLib) {
    await loadScript(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`, signal);
  }
  throwIfAborted(signal);
  if (!window.pdfjsLib) throw new Error('PDF.js unavailable');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;
}

async function ensureOcr(signal?: AbortSignal): Promise<void> {
  await ensurePdfJs(signal);
  if (!window.Tesseract) {
    await loadScript(`https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`, signal);
  }
  throwIfAborted(signal);
  if (!window.Tesseract) throw new Error('OCR engine unavailable');
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
    canvas.toBlob(blob => {
      if (signal?.aborted) {
        reject(new OcrAbortedError());
        return;
      }
      blob ? resolve(blob) : reject(new Error('OCR canvas conversion failed'));
    }, 'image/png', 1);
  });
}

/**
 * Select every page for short PDFs; for long PDFs select only the first and
 * last five. An explicit expanded check adds up to five evenly-spaced interior
 * pages, keeping the initial sample cheap and making the higher-recall step
 * deliberate and bounded.
 */
export function selectPdfOcrPages(totalPages: number, mode: PdfOcrMode = 'sample'): number[] {
  const count = Math.max(0, Math.floor(totalPages));
  if (!count) return [];
  if (count <= PDF_FULL_OCR_MAX_PAGES) {
    return Array.from({ length: count }, (_, index) => index + 1);
  }

  const selected = new Set<number>();
  for (let page = 1; page <= PDF_EDGE_OCR_PAGES; page++) selected.add(page);
  for (let page = Math.max(PDF_EDGE_OCR_PAGES + 1, count - PDF_EDGE_OCR_PAGES + 1); page <= count; page++) {
    selected.add(page);
  }

  if (mode === 'expanded') {
    const firstInterior = PDF_EDGE_OCR_PAGES + 1;
    const lastInterior = count - PDF_EDGE_OCR_PAGES;
    const interiorCount = Math.max(0, lastInterior - firstInterior + 1);
    const extraCount = Math.min(PDF_EXTRA_MIDDLE_OCR_PAGES, interiorCount);
    for (let index = 1; index <= extraCount; index++) {
      const offset = Math.round(index * (interiorCount + 1) / (extraCount + 1)) - 1;
      selected.add(firstInterior + offset);
    }
  }
  return [...selected].sort((a, b) => a - b);
}

/** Sparse text layers (e.g., page numbers or a short header only) need OCR. */
export function shouldOcrPdfPage(nativeText: string): boolean {
  const cleaned = (nativeText || '').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word));
  return cleaned.length < 45 || words.length < 6;
}

function extractTextItems(content: any): string {
  const items = Array.isArray(content?.items) ? content.items : [];
  return items
    .map((item: any) => typeof item?.str === 'string' ? item.str : '')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeSparseNativeAndOcr(nativeText: string, ocrText: string): string {
  if (!nativeText) return ocrText;
  if (!ocrText) return nativeText;
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const nativeKey = normalize(nativeText);
  const ocrKey = normalize(ocrText);
  if (nativeKey && (ocrKey.includes(nativeKey) || nativeKey.includes(ocrKey))) {
    return ocrText.length >= nativeText.length ? ocrText : nativeText;
  }
  return `${nativeText}\n${ocrText}`;
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

export async function extractPdfTextWithOcr(
  buffer: ArrayBuffer,
  opts?: { signal?: AbortSignal; mode?: PdfOcrMode }
): Promise<PdfTextExtraction> {
  const signal = opts?.signal;
  const mode = opts?.mode ?? 'sample';
  await ensurePdfJs(signal);
  throwIfAborted(signal);
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const totalPages = Number(pdf.numPages) || 0;
  const sampledPages = selectPdfOcrPages(totalPages, mode);
  const attemptedOcrPages: number[] = [];
  const successfulOcrPages: number[] = [];
  const pageText: string[] = [];
  let nativeTextPageCount = 0;
  let worker: any = null;

  try {
    for (const pageNo of sampledPages) {
      throwIfAborted(signal);
      const page = await pdf.getPage(pageNo);
      let text = '';
      try {
        const nativeText = extractTextItems(await page.getTextContent());
        const needsOcr = shouldOcrPdfPage(nativeText);
        if (!needsOcr) nativeTextPageCount++;
        text = nativeText;

        if (needsOcr) {
          attemptedOcrPages.push(pageNo);
          worker ||= await createWorker(signal);
          throwIfAborted(signal);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(2, Math.max(1, 1800 / base.width));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          try {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error(`OCR canvas unavailable for PDF page ${pageNo}`);
            await page.render({ canvasContext: ctx, viewport }).promise;
            throwIfAborted(signal);
            const { data } = await worker.recognize(await canvasToBlob(canvas, signal));
            throwIfAborted(signal);
            const ocrText = String(data?.text || '').trim();
            if (ocrText) successfulOcrPages.push(pageNo);
            text = mergeSparseNativeAndOcr(nativeText, ocrText);
          } finally {
            canvas.width = 1;
            canvas.height = 1;
          }
        }
      } finally {
        page.cleanup?.();
      }
      if (text) pageText.push(`[Page ${pageNo}]\n${text}`);
    }

    const policy: PdfOcrPolicy = totalPages <= PDF_FULL_OCR_MAX_PAGES
      ? 'all-pages'
      : mode === 'expanded'
        ? 'first-last-5-plus-middle'
        : 'first-last-5';
    return {
      text: pageText.join('\n\n').trim(),
      coverage: {
        totalPages,
        policy,
        sampledPages,
        attemptedOcrPages,
        successfulOcrPages,
        deferredPageCount: Math.max(0, totalPages - sampledPages.length),
        nativeTextPageCount,
      },
    };
  } finally {
    if (worker) await worker.terminate().catch(() => undefined);
    pdf.cleanup?.();
    pdf.destroy?.();
  }
}

/** Backward-compatible text-only helper used by older callers. */
export async function ocrPdf(buffer: ArrayBuffer, signal?: AbortSignal): Promise<string> {
  return (await extractPdfTextWithOcr(buffer, { signal })).text;
}
