/** Optional IndexedDB polyfill for contentIndex integration tests. */
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('fake-indexeddb/auto');
} catch {
  // not installed or not needed for pure unit tests
}
