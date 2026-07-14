import { describe, it, expect } from 'vitest';
import { usToSec, secToUs, deepEqual } from '../src/utils/helpers';

describe('usToSec', () => {
  it('converts 0 µs to 0 seconds', () => {
    expect(usToSec(0)).toBe(0);
  });

  it('converts 1,000,000 µs to 1 second', () => {
    expect(usToSec(1_000_000)).toBe(1);
  });

  it('converts 500,000 µs to 0.5 seconds', () => {
    expect(usToSec(500_000)).toBe(0.5);
  });

  it('handles large values', () => {
    expect(usToSec(3_600_000_000)).toBe(3600);
  });
});

describe('secToUs', () => {
  it('converts 0 seconds to 0 µs', () => {
    expect(secToUs(0)).toBe(0);
  });

  it('converts 1 second to 1,000,000 µs', () => {
    expect(secToUs(1)).toBe(1_000_000);
  });

  it('rounds fractional results', () => {
    expect(secToUs(0.3333)).toBe(333300);
  });

  it('handles negative values', () => {
    expect(secToUs(-1)).toBe(-1_000_000);
  });
});

describe('deepEqual', () => {
  it('returns true for identical primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
  });

  it('returns false for different primitives', () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'b')).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(true, false)).toBe(false);
  });

  it('compares flat objects', () => {
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
  });

  it('compares nested objects', () => {
    expect(
      deepEqual({ a: { b: { c: 3 } } }, { a: { b: { c: 3 } } }),
    ).toBe(true);
    expect(
      deepEqual({ a: { b: { c: 3 } } }, { a: { b: { c: 4 } } }),
    ).toBe(false);
  });

  it('compares arrays', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('handles mixed null and object', () => {
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
  });

  it('handles different key counts', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});
