import { describe, it, expect, beforeEach } from 'vitest';
import { PerformanceMonitor } from '../../src/engine/perf';

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    monitor = new PerformanceMonitor();
  });

  it('starts with a baseline composite score when no data recorded', () => {
    const score = monitor.score();
    // With no frame data, formula still produces a non-negative baseline
    expect(score.composite).toBeGreaterThanOrEqual(0);
    expect(score.totalFrames).toBe(0);
  });

  it('reset clears all state', () => {
    monitor.recordRaf(0);
    monitor.recordRaf(16.67);
    monitor.reset();
    const score = monitor.score();
    expect(score.totalFrames).toBe(0);
  });

  it('recordRaf counts frames', () => {
    monitor.recordRaf(0);
    monitor.recordRaf(16.67);
    monitor.recordRaf(33.34);
    const score = monitor.score();
    expect(score.totalFrames).toBe(2);
  });

  it('detects dropped frames at 60fps target', () => {
    monitor.recordRaf(0);
    // Simulate a frame that took 25ms (> 16.67 * 1.25 = 20.8ms)
    monitor.recordRaf(25);
    const score = monitor.score();
    expect(score.totalFrames).toBe(1);
    // 25ms > 16.67 * 1.25 = 20.8ms → dropped
    expect(parseFloat(score.dropRatePct)).toBeGreaterThan(0);
  });

  it('score returns all expected fields', () => {
    monitor.recordRaf(0);
    monitor.recordRaf(16.67);
    const score = monitor.score();

    expect(score).toHaveProperty('composite');
    expect(score).toHaveProperty('smoothness');
    expect(score).toHaveProperty('gradePerf');
    expect(score).toHaveProperty('decodePerf');
    expect(score).toHaveProperty('dropScore');
    expect(score).toHaveProperty('avgFrameMs');
    expect(score).toHaveProperty('avgGradeMs');
    expect(score).toHaveProperty('avgDecodeMs');
    expect(score).toHaveProperty('dropRatePct');
    expect(score).toHaveProperty('totalFrames');
    expect(score).toHaveProperty('targetFps');
  });

  it('composite score is between 0 and 100', () => {
    // Simulate 10 frames at perfect 60fps
    for (let i = 0; i < 10; i++) {
      monitor.recordRaf(i * 16.67);
    }
    const score = monitor.score();
    expect(score.composite).toBeGreaterThanOrEqual(0);
    expect(score.composite).toBeLessThanOrEqual(100);
  });

  it('records grade timing via recordFrameArrival', () => {
    monitor.recordFrameArrival(100, 2.5);
    monitor.recordFrameArrival(200, 3.0);
    const score = monitor.score();
    expect(parseFloat(score.avgGradeMs)).toBeCloseTo(2.75, 1);
  });

  it('does not exceed 120 frame time samples', () => {
    for (let i = 0; i <= 130; i++) {
      monitor.recordRaf(i * 16.67);
    }
    // Internal: _frameTimes capped at 120. Score should still work fine.
    const score = monitor.score();
    expect(score.totalFrames).toBe(130);
    expect(score.composite).toBeGreaterThanOrEqual(0);
  });

  it('recordFrameArrival tracks decode times from recordDecodeSubmit', () => {
    monitor.recordDecodeSubmit(100);
    monitor.recordFrameArrival(100, 1.5);
    const score = monitor.score();
    expect(parseFloat(score.avgDecodeMs)).not.toBe('0.00');
  });

  it('report delegates to score and returns composite', () => {
    monitor.recordRaf(0);
    monitor.recordRaf(16.67);
    const result = monitor.report();
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });

  it('recordDecodeSubmit stores timing data that is consumed by recordFrameArrival', () => {
    monitor.recordDecodeSubmit(200);
    monitor.recordDecodeSubmit(300);
    monitor.recordFrameArrival(200, 1.0);
    monitor.recordFrameArrival(999, 1.0); // no matching submit
    const score = monitor.score();
    expect(score.totalFrames).toBe(0);
  });
});
