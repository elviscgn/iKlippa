// ── Shared utility functions ────────────────────────────────────────────
// Extracted from state.js and engine.js for reuse across modules.

/** Convert microseconds to seconds. */
export function usToSec(us: number): number {
  return us / 1_000_000;
}

/** Convert seconds to microseconds (rounded). */
export function secToUs(s: number): number {
  return Math.round(s * 1_000_000);
}

/**
 * Deep equality check for plain JSON-like objects.
 * Used for round-trip verification (state.js verifyRoundTrip).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const ka = Object.keys(objA);
  const kb = Object.keys(objB);

  if (ka.length !== kb.length) return false;

  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

/**
 * Load a script by URL. Returns a promise that resolves when loaded.
 * Skips if the script is already present.
 */
export function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(s);
  });
}
