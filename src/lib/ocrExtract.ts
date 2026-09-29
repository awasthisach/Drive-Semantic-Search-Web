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

function loadScript(src: string): Promise<void> {
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
  });
}

async function ensureOcr(): Promise<void> {
  if (!window.Tesseract) await loadScript(`https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`);
  if (!window.pdfjsLib) await loadScript(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`);
  if (!window.Tesseract || !window.pdfjsLib) throw new Error('OCR engine unavailable');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;
}

async function createWorker(): Promise<any> {
  await ensureOcr();
  return window.Tesseract.createWorker('eng+hin', 1, {
    workerPath: TESS_WORKER_PATH,
    corePath: TESS_CORE_PATH,
    langPath: TESS_LANG_PATH,
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('OCR canvas conversion failed')), 'image/png', 1));
}

export async function ocrImage(buffer: ArrayBuffer): Promise<string> {
  const worker = await createWorker();
  try {
    const { data } = await worker.recognize(new Blob([buffer]));
    return String(data?.text || '').trim();
  } finally {
    await worker.terminate();
  }
}

export async function ocrPdf(buffer: ArrayBuffer): Promise<string> {
  await ensureOcr();
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const worker = await createWorker();
  const pages: string[] = [];
  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, Math.max(1, 1800 / base.width));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error(`OCR canvas unavailable for PDF page ${pageNo}`);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const { data } = await worker.recognize(await canvasToBlob(canvas));
      const text = String(data?.text || '').trim();
      if (text) pages.push(`[Page ${pageNo}]\n${text}`);
      canvas.width = 1;
      canvas.height = 1;
      page.cleanup?.();
    }
    return pages.join('\n\n').trim();
  } finally {
    await worker.terminate();
    pdf.cleanup?.();
    pdf.destroy?.();
  }
}
