/* Suppress noisy websocket errors and recover once from stale PWA chunks. */
function recoverFromStaleChunk(message) {
  if (!message || !/Loading chunk|dynamically imported module|Importing a module script failed/i.test(message)) {
    return;
  }
  try {
    var key = 'drive-search-chunk-reload-at';
    var previous = Number(sessionStorage.getItem(key) || 0);
    if (Date.now() - previous < 60000) return;
    sessionStorage.setItem(key, String(Date.now()));
    window.location.reload();
  } catch (_) {
    /* Private browsing can deny sessionStorage; never block the app. */
  }
}
window.addEventListener('unhandledrejection', function (event) {
  if (event && event.reason) {
    var msg = String(event.reason.message || event.reason);
    recoverFromStaleChunk(msg);
    if (
      msg.includes('send was called before connect') ||
      msg.includes('failed to connect to websocket')
    ) {
      event.preventDefault();
    }
  }
});
window.addEventListener('error', function (event) {
  if (event && event.message) {
    var msg = String(event.message);
    recoverFromStaleChunk(msg);
    if (
      msg.includes('send was called before connect') ||
      msg.includes('failed to connect to websocket')
    ) {
      event.preventDefault();
    }
  }
});
