/** Local-only diagnostics ring. No telemetry. Tokens/keys redacted. */

export type DiagLevel = 'info' | 'warn' | 'error';

export type DiagEvent = {
  ts: string;
  level: DiagLevel;
  source: string;
  message: string;
};

const MAX = 120;
const LS_KEY = 'drive-semantic-diag-v1';
const ring: DiagEvent[] = [];
let inited = false;

function redact(s: string): string {
  return s
    .replace(/ya29\.[A-Za-z0-9._~\-]+/g, '[token]')
    .replace(/AIza[A-Za-z0-9_\-]+/g, '[key]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '[email]')
    .slice(0, 500);
}

function persist(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(ring.slice(-MAX)));
  } catch {
    /* quota / private mode */
  }
}

function hydrate(): void {
  if (ring.length) return;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as DiagEvent[];
    if (Array.isArray(parsed)) {
      for (const e of parsed.slice(-MAX)) {
        if (e && e.ts && e.message) ring.push(e);
      }
    }
  } catch {
    /* ignore */
  }
}

export function logDiag(level: DiagLevel, source: string, message: string): void {
  hydrate();
  ring.push({
    ts: new Date().toISOString(),
    level,
    source: redact(source),
    message: redact(String(message || '')),
  });
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
  persist();
}

export function getDiagnostics(): DiagEvent[] {
  hydrate();
  return ring.slice();
}

export function clearDiagnostics(): void {
  ring.length = 0;
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

function runtimeSnapshot(): Record<string, unknown> {
  const snap: Record<string, unknown> = {
    href: typeof location !== 'undefined' ? location.href : '',
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    visibility: typeof document !== 'undefined' ? document.visibilityState : null,
    userAgent: typeof navigator !== 'undefined' ? String(navigator.userAgent || '').slice(0, 180) : '',
  };
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      snap.swController = Boolean(navigator.serviceWorker.controller);
    }
  } catch {
    /* ignore */
  }
  try {
    const cursor = sessionStorage.getItem('content-index-cursor');
    if (cursor) snap.indexCursor = cursor.slice(0, 80);
  } catch {
    /* ignore */
  }
  return snap;
}

export function exportDiagnosticsJson(): string {
  hydrate();
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      note: 'Local-only. Tokens/emails redacted. No file bodies.',
      runtime: runtimeSnapshot(),
      eventCount: ring.length,
      events: getDiagnostics(),
    },
    null,
    2
  );
}

export function downloadDiagnostics(): void {
  const blob = new Blob([exportDiagnosticsJson()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'drive-semantic-diagnostics.json';
  a.click();
  URL.revokeObjectURL(url);
}

/** Must be called once at app boot so window errors and later logDiag persist. */
export function initDiagnostics(): void {
  if (inited || typeof window === 'undefined') return;
  inited = true;
  hydrate();
  logDiag('info', 'diagnostics', `init events=${ring.length}`);
  window.addEventListener('error', ev => {
    logDiag('error', 'window.error', ev.message || 'error');
  });
  window.addEventListener('unhandledrejection', ev => {
    const reason = ev.reason;
    const msg = reason instanceof Error ? reason.message : String(reason || 'rejection');
    logDiag('error', 'unhandledrejection', msg);
  });
}
