/** Convert microseconds to seconds. */
export function usToSec(us: number): number {
  return us / 1_000_000;
}

/** Convert seconds to microseconds (rounded). */
export function secToUs(s: number): number {
  return Math.round(s * 1_000_000);
}
