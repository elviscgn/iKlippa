const SHELL_CACHE = 'iklippa-shell-v1';

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

export function registerAppShell(): Promise<ServiceWorkerRegistration | null> {
  if (registrationPromise) return registrationPromise;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    return Promise.resolve(null);
  }

  registrationPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then(async (registration) => {
      await navigator.serviceWorker.ready;
      return registration;
    })
    .catch((error) => {
      registrationPromise = null;
      console.warn('[iKlippa:offline] App shell registration failed:', error);
      return null;
    });
  return registrationPromise;
}

export async function isAppShellCached(): Promise<boolean> {
  if (!('caches' in window)) return false;
  const cache = await caches.open(SHELL_CACHE);
  const [root, index] = await Promise.all([
    cache.match('/'),
    cache.match('/index.html'),
  ]);
  return Boolean(root || index);
}

