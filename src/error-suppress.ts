/* Suppress noisy websocket errors and recover once from stale PWA chunks. */
function recoverFromStaleChunk(message: unknown) {
  if (!message || !/Loading chunk|dynamically imported module|Importing a module script failed/i.test(String(message))) {
    return;
  }
  try {
    const key = 'drive-search-chunk-reload-at';
    const previous = Number(sessionStorage.getItem(key) || 0);
    if (Date.now() - previous < 60_000) return;
    sessionStorage.setItem(key, String(Date.now()));
    const url = new URL(window.location.href);
    url.searchParams.set('_chunk_reload', String(Date.now()));
    window.location.replace(url.href);
  } catch {
    /* Private browsing can deny sessionStorage; never block the app. */
  }
}

window.addEventListener('unhandledrejection', (event) => {
  if (!event?.reason) return;
  const message = String(event.reason.message || event.reason);
  recoverFromStaleChunk(message);
  if (message.includes('send was called before connect') || message.includes('failed to connect to websocket')) {
    event.preventDefault();
  }
});

window.addEventListener('error', (event) => {
  if (!event?.message) return;
  const message = String(event.message);
  recoverFromStaleChunk(message);
  if (message.includes('send was called before connect') || message.includes('failed to connect to websocket')) {
    event.preventDefault();
  }
});
