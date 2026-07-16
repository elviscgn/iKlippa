import { describe, it, expect } from 'vitest';
import { usToSec, secToUs } from '../src/utils/time';

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
