/* Suppress noisy non-app websocket errors (e.g. extension tooling) */
window.addEventListener('unhandledrejection', function (event) {
  if (event && event.reason) {
    var msg = String(event.reason.message || event.reason);
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
    if (
      msg.includes('send was called before connect') ||
      msg.includes('failed to connect to websocket')
    ) {
      event.preventDefault();
    }
  }
});
