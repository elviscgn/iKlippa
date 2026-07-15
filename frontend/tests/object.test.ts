import { describe, it, expect } from 'vitest';
import { deepEqual } from '../src/utils/object';

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
