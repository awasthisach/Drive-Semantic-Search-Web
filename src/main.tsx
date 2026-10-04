import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './error-suppress';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import { initDiagnostics, logDiag } from './lib/diagnostics';

/**
 * Permanent cache-bust for GitHub Pages PWA:
 * - vite-plugin-pwa autoUpdate + skipWaiting activates new SW
 * - on controllerchange we reload once so hashed JS/CSS from the new deploy load
 * - periodic update checks catch deploys while the tab stays open
 */
initDiagnostics();

function setupServiceWorkerUpdate() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  // Avoid reload loops if something goes wrong mid-navigation.
  const RELOAD_KEY = 'dssw-reloaded';
  let refreshing = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    if (sessionStorage.getItem(RELOAD_KEY) === '1') {
      sessionStorage.removeItem(RELOAD_KEY);
      return;
    }
    refreshing = true;
    sessionStorage.setItem(RELOAD_KEY, '1');
    logDiag('info', 'sw', 'controllerchange reload');
    window.location.reload();
  });

  // Eagerly look for a waiting worker and tell it to activate.
  void navigator.serviceWorker.ready.then(reg => {
    const askWaiting = () => {
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
    };
    askWaiting();
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          askWaiting();
        }
      });
    });
    // While the app stays open, poll for new deploys (GitHub Pages).
    window.setInterval(() => {
      void reg.update().catch(() => undefined);
    }, 60_000);
  });

  // On focus / visibility, check again (user returns after a deploy).
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    void navigator.serviceWorker.getRegistration().then(reg => reg?.update().catch(() => undefined));
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
}

setupServiceWorkerUpdate();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
