# iKlippa Performance Benchmark

## Summary

iKlippa maintained real-time 1280x720 playback across four baseline runs and four Chrome 4x CPU slowdown runs.

Across the constrained runs:

- the timeline advanced for the full 12-second test window every time;
- the median rendered frame rate was 43.1 FPS;
- the observed frame-rate range was 30.0 to 60.0 FPS;
- the median dropped-frame rate was 2.1%;
- all four runs produced zero browser errors.

This is evidence that the editor remains usable when JavaScript execution is heavily constrained. It does not model every limitation of physical low-spec hardware.

## Test configuration

| Item | Value |
|---|---|
| Date | 29 July 2026 |
| Browser | Google Chrome, isolated headless profile |
| App server | Vite development server at `http://localhost:8080/` |
| Test media | `frontend/test.mp4` |
| Media format | H.264 MP4 |
| Resolution | 1280x720 |
| Duration | 36.04 seconds |
| Playback sample | 12 seconds |
| Recorded runs | 4 baseline and 4 constrained |

## Profiles

### Baseline

Chrome ran without artificial CPU slowdown.

### Constrained CPU

Chrome DevTools applied a 4x CPU slowdown before the page loaded. This makes JavaScript tasks take roughly four times longer and provides a repeatable stress profile across runs.

CPU throttling does not reproduce every property of a low-cost laptop. It does not reduce available RAM, storage speed, GPU capability, thermal limits, or hardware video-decoder performance.

## Results

Values are the median of four runs. Parentheses show the full observed range.

| Measurement | Baseline | 4x CPU slowdown |
|---|---:|---:|
| Editor ready | 944.6 ms (884.2-965.2) | 1,222.3 ms (884.9-1,312.8) |
| Timeline advance in 12-second window | 12.00 s (12.00-12.02) | 12.07 s (12.00-12.12) |
| Average frame time | 16.67 ms (16.67-33.34) | 25.56 ms (16.66-33.34) |
| Approximate rendered frame rate | 60.0 FPS (30.0-60.0) | 43.1 FPS (30.0-60.0) |
| Dropped frames | 0.05% (0.0-2.8) | 2.1% (0.1-10.8) |
| Average decode-to-output | 43.13 ms (41.89-44.27) | 41.59 ms (40.97-73.76) |
| Performance monitor score | 97/100 (88-97) | 85/100 (67-97) |
| Browser errors | 0 | 0 |

Every constrained run stayed at or above the 30 FPS usability floor. Timeline time also stayed synchronized with wall-clock time in every run.

Headless Chrome sometimes schedules `requestAnimationFrame` at 30 Hz. That happened in one baseline run and two constrained runs, which is why the ranges are included instead of reporting only the best result.

## What the benchmark runs

The benchmark does not use a static mock page. It:

1. starts the Vite application if it is not already running;
2. opens the editor in a fresh Chrome profile;
3. applies the selected CPU slowdown through the Chrome DevTools Protocol;
4. stores a benchmark onboarding brief;
5. imports the bundled H.264 test video through the normal development auto-loader;
6. places the imported source on the real timeline;
7. resets the editor's performance monitor;
8. plays the project for 12 seconds;
9. records frame time, dropped frames, decode latency, timeline progress, and browser errors;
10. repeats each profile in a fresh browser three times by default;
11. reports the median, minimum, and maximum for each measurement.

## Reproduce the test

Requirements:

- Google Chrome, with `CHROME_PATH` set when it is not in the runner's default location;
- Node.js 20 or newer.

From the repository:

```bash
cd frontend
node scripts/benchmark.mjs
```

The script starts `npm run dev` automatically when port `8080` is not already serving the app.

The runner performs three passes per profile by default. Change the count with:

```bash
IKLIPPA_BENCHMARK_RUNS=5 node scripts/benchmark.mjs
```

To use another Chrome executable:

```bash
CHROME_PATH="/path/to/chrome" node scripts/benchmark.mjs
```

To change the playback window:

```bash
IKLIPPA_BENCHMARK_PLAYBACK_MS=20000 node scripts/benchmark.mjs
```

## Important limits

- This run covers one 1280x720 H.264 video clip.
- It measures preview playback, not export speed.
- It does not measure a multi-track composite or an active colour grade.
- Headless Chrome and normal visible Chrome can use different graphics paths.
- The Vite development server and bundled test video make the recorded transfer size unsuitable as a production download-size claim.
- A physical low-spec device test is still required before claiming certified performance on a particular laptop class.

## Next physical-device pass

The final validation should repeat the same workflow on:

- 8 GB RAM;
- a dual-core or entry-level quad-core processor;
- integrated graphics;
- current Chrome (151.0.7922.71/.72) or Edge;
- a 1280x720 H.264 source;
- a 1920x1080 H.264 source;
- one-track and two-track timelines.

The physical test should record editor-ready time, average frame time, dropped-frame rate, audio continuity, seek response, memory use, and export time.
