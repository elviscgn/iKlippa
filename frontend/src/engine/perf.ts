// ── PerformanceMonitor ──────────────────────────────────────────────────
// Extracted from engine.js and fully typed.

import type { PerfScore } from './types';

export class PerformanceMonitor {
  private _frameTimes: number[] = [];
  private _gradeTimes: number[] = [];
  private _decodeTimes: number[] = [];
  private _droppedFrames = 0;
  private _totalFrames = 0;
  private _lastRaf: number | null = null;
  private _pendingDecodes = new Map<number, number>();

  constructor() {
    this.reset();
  }

  reset(): void {
    this._frameTimes = [];
    this._gradeTimes = [];
    this._decodeTimes = [];
    this._droppedFrames = 0;
    this._totalFrames = 0;
    this._lastRaf = null;
    this._pendingDecodes = new Map();
  }

  recordRaf(ts: number): void {
    if (this._lastRaf !== null) {
      const dt = ts - this._lastRaf;
      this._frameTimes.push(dt);
      const avgFrameMs =
        this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
      const targetMs =
        this._frameTimes.length > 10 && avgFrameMs > 25 ? 33.33 : 16.67;
      if (dt > targetMs * 1.25) this._droppedFrames++;
      this._totalFrames++;
      if (this._frameTimes.length > 120) this._frameTimes.shift();
    }
    this._lastRaf = ts;
  }

  recordDecodeSubmit(tsMs: number): void {
    this._pendingDecodes.set(tsMs, performance.now());
  }

  recordFrameArrival(tsMs: number, gradeMs: number): void {
    const submitTime = this._pendingDecodes.get(tsMs);
    if (submitTime !== undefined) {
      this._decodeTimes.push(performance.now() - submitTime);
      this._pendingDecodes.delete(tsMs);
      if (this._decodeTimes.length > 60) this._decodeTimes.shift();
    }
    this._gradeTimes.push(gradeMs);
    if (this._gradeTimes.length > 120) this._gradeTimes.shift();
  }

  score(): PerfScore {
    const avg = (arr: number[]): number =>
      arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const avgFrameMs = avg(this._frameTimes);
    const avgGradeMs = avg(this._gradeTimes);
    const avgDecodeMs = avg(this._decodeTimes);
    const dropRate =
      this._totalFrames > 0 ? this._droppedFrames / this._totalFrames : 0;
    const targetMs = avgFrameMs > 25 ? 33.33 : 16.67;

    const smoothness = Math.max(
      0,
      Math.min(100, 100 - (Math.abs(avgFrameMs - targetMs) / targetMs) * 100),
    );
    const gradePerf = Math.max(
      0,
      Math.min(100, 100 - (avgGradeMs / 4) * 100),
    );
    const decodePerf = Math.max(
      0,
      Math.min(100, 100 - ((avgDecodeMs - 33) / 67) * 100),
    );
    const dropScore = Math.max(
      0,
      Math.min(100, (1 - dropRate * 10) * 100),
    );
    const composite = Math.round(
      smoothness * 0.4 + dropScore * 0.3 + decodePerf * 0.2 + gradePerf * 0.1,
    );

    return {
      composite,
      smoothness: Math.round(smoothness),
      gradePerf: Math.round(gradePerf),
      decodePerf: Math.round(decodePerf),
      dropScore: Math.round(dropScore),
      avgFrameMs: avgFrameMs.toFixed(2),
      avgGradeMs: avgGradeMs.toFixed(2),
      avgDecodeMs: avgDecodeMs.toFixed(2),
      dropRatePct: (dropRate * 100).toFixed(1),
      totalFrames: this._totalFrames,
      targetFps: Math.round(1000 / targetMs),
    };
  }

  report(): number {
    const s = this.score();
    console.group(
      '%ciKlippa Performance Report',
      'color:#0d9488;font-weight:700;font-size:14px',
    );
    console.log(
      `%c🎯 Composite Score: ${s.composite} / 100 (${s.targetFps} FPS Target)`,
      `font-size:16px;font-weight:800;color:${s.composite >= 70 ? '#10b981' : s.composite >= 40 ? '#f59e0b' : '#ef4444'}`,
    );
    console.table({
      Smoothness: `${s.smoothness}/100 (avg ${s.avgFrameMs} ms/frame)`,
      'Grade Perf': `${s.gradePerf}/100 (avg ${s.avgGradeMs} ms/grade)`,
      'Decode Perf': `${s.decodePerf}/100 (avg ${s.avgDecodeMs} ms decode→output)`,
      'Drop Score': `${s.dropScore}/100 (${s.dropRatePct}% frames dropped)`,
      'Total Frames': s.totalFrames,
    });
    console.groupEnd();
    return s.composite;
  }
}
