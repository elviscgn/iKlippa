# How We Used IBM Bob

This document records how the iKlippa team used IBM Bob while building the project. It focuses on the work Bob helped with and the results that can be checked in the repository.

Bob was used as a development partner. The team chose the product direction, reviewed the plans, tested the editor in a real browser, and decided which suggestions to keep.

## What we asked Bob to help with

The project combines browser media APIs, TypeScript, Rust, WebAssembly, Go, Python, and local AI. Changes often affected several parts of the system at once.

We used Bob for five main jobs:

1. understanding the existing codebase;
2. planning changes before editing;
3. implementing work across related files;
4. debugging browser video and audio problems;
5. running tests and checking the result.

## How we worked with Bob

### Understand

We first used Bob to trace the code rather than immediately change it. Important questions included:

- How does a timestamp move from the UI to the decoder?
- Which code owns timeline time and which code owns source time?
- What happens when a clip is split, moved, or trimmed?
- Which work belongs on the main thread and which work belongs in a worker?
- Where should provider keys and model calls live?

This helped the team map the boundary between the editor UI, the media engine, the Rust/WASM module, and the backend services.

The result is documented in:

- [`frontend/architecture.md`](../frontend/architecture.md)
- [`frontend/plan.md`](../frontend/plan.md)
- [`backend/README.md`](../backend/README.md)

### Plan

For larger work, we asked Bob to break the goal into ordered tasks with dependencies and checks.

The frontend plan covered:

- the Rust timeline model;
- multi-track compositing;
- per-clip colour grading;
- captions;
- project persistence;
- the audio mixer;
- export;
- undo and redo;
- testing.

The plan gave the team a shared sequence and made it easier to check whether a feature was actually complete.

### Build

Bob helped the team work across the TypeScript, Rust, Go, and Python parts of the repository.

The main areas were:

- the WebCodecs decode worker;
- timeline and source-time mapping;
- Rust/WASM state and frame processing;
- the multi-track editor;
- the Go API gateway;
- the Python analysis and stock-provider service;
- the Granite integration.

The final backend is a Go service using Gin. It proxies Granite chat and provider requests so credentials do not need to be exposed to the browser. The Python FastAPI service handles script analysis, Pexels search, Jamendo search, and the XGBoost model.

The first backend draft changed during development. Older notes referred to Node and Express, but that is not the implementation in this repository.

### Debug

Browser video editing has strict state rules. Bob was especially useful when an error crossed several asynchronous systems.

#### VideoDecoder keyframe errors

Rapid seeks and decoder resets produced this browser error:

```text
A key frame is required after configure() or flush().
```

Bob helped trace the problem through the seek path. The worker now resets and reseeds the decoder from a valid keyframe, rejects stale seek work, and keeps message handling serial.

#### Audio falling behind or breaking up

The UI was sending synchronization work faster than the worker could finish it. Old requests built up, so decoded audio reached the main thread too late.

The current design:

- serializes worker operations;
- replaces stale sync requests with the newest one;
- limits audio decode-ahead;
- clears old scheduled audio after pause and seek;
- resynchronizes audio when playback starts again.

#### Wrong or black thumbnails

Thumbnail capture originally reused the wrong source frame and sometimes took a frame from the beginning of a clip. Bob helped the team separate thumbnail capture from the preview canvas and keep frame caches tied to their source.

The editor now asks for a middle frame and captures it without repainting the main preview.

#### Backend HTML parsed as JSON

When the frontend was opened as a raw HTML file, API calls returned an HTML page instead of JSON. Bob helped trace this to the missing Vite proxy.

The development flow now uses `npm run dev` at `http://localhost:8080/`. Vite proxies `/api` to the Go gateway on port `8081` and serves the worker and WASM assets correctly.

### Verify

Bob was used to run the test suite and production build after changes. The team also tested the browser workflow with real video and audio files.

At the time of this update, the frontend verification result is:

```text
35 test files passed
391 tests passed
TypeScript build passed
Vite production build passed
Go backend tests passed
```

The tests include:

- decoder and worker messages;
- timeline state and time mapping;
- audio scheduling;
- thumbnails;
- drag and drop;
- onboarding persistence;
- command parsing and `@clip` targeting;
- local silence and beat measurements;
- Smart Trim and Beat Sync timeline changes;
- cut scoring;
- Granite runtime selection;
- offline readiness;
- stock provider failures.

See [`frontend/qa-report.md`](../frontend/qa-report.md) for the earlier engine QA record. The current automated suite has grown since that report was written.

## How Bob supported the AI-native editor

The important product decision was to avoid treating AI as a separate text generator.

Bob helped the team reason about a system with three connected layers:

1. **Context:** onboarding, brand rules, timeline state, selected clips, playhead position, captions, and recent edits.
2. **Analysis:** Granite reasoning plus local silence, beat, gap, and pacing measurements.
3. **Action:** deterministic commands that target clips and apply undoable timeline changes.

This structure keeps the model informed while keeping the editor state predictable.

Examples in the current product include:

- `@clip` mentions resolving to real timeline clips;
- Smart Trim turning decoded PCM measurements into ripple cuts;
- Beat Sync aligning clips to locally detected beats and drops;
- Auto B-Roll using project keywords to search Pexels and insert footage;
- Granite reading the same project context in online and on-device modes.

## IBM Bob and IBM Granite have different roles

IBM Bob was the tool used to help build and debug iKlippa.

IBM Granite is part of the product:

- Granite Code 3B runs through Ollama for the online local-development path;
- Granite 4.0 350M runs inside the browser when Offline mode is prepared;
- both paths receive structured context from the current edit.

Keeping these roles separate makes the architecture easier to explain and the IBM technology use easier to verify.

## What the team learned

### Give Bob the goal and the relevant context

Bob was most useful when it could inspect the files involved in a problem. Short, targeted tasks produced better results than pasting large, unrelated logs.

### Plan cross-file changes first

Media bugs often involve the UI, worker, decoder, timeline state, and tests. A written plan helped the team avoid fixing one layer while breaking another.

### Treat generated code as a starting point

The team reviewed Bob's changes, tested them in the browser, and kept the final decision. This was important for WebCodecs because a solution can look correct while still breaking under rapid seeking or repeated playback.

### Make the result measurable

Tests, build checks, visible error handling, and a reproducible local setup made Bob's work easier to review and made the final prototype more reliable.

## Evidence in the repository

| Area | Evidence |
|---|---|
| Architecture understanding | [`frontend/architecture.md`](../frontend/architecture.md) |
| Implementation plan | [`frontend/plan.md`](../frontend/plan.md) |
| Engine QA | [`frontend/qa-report.md`](../frontend/qa-report.md) |
| Browser engine | `frontend/src/engine` and `frontend/rust-engine` |
| AI context and local model | `frontend/src/ai` |
| Editing commands | `frontend/src/commands` |
| Offline support | `frontend/src/offline` and `frontend/src/media` |
| API gateway | `backend/main.go` |
| ML and provider services | `ml/app.py` and `ml/scripts` |
| Automated verification | `frontend/tests` |

## Summary

IBM Bob helped the team move from an ambitious browser-editor idea to an implemented and tested system. Its strongest contribution was not a single generated file. It helped the team understand a complex codebase, plan work across several languages, debug asynchronous media problems, and verify the result.

The team remained responsible for the product decisions, technical review, browser testing, and final implementation.
