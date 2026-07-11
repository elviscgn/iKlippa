import {
    initEngine,
    importFile,
    startPlayback,
    pausePlayback,
    togglePlayback,
    seekTo,
    setColorGrade,
    exportVideo,
    perf,
    getThumbnails,
    getCurrentFileName,
} from "./engine.js";

const canvasEl = document.getElementById("canvas-img");
const dropOverlay = document.getElementById("drop-overlay");
const fileInput = document.getElementById("file-input");
const statusBadge = document.querySelector(".status-badge");
const scoreValue = document.getElementById("score-value");

let hasRealVideo = false;

// ── Engine Status to UI ──────────────────────────────────────────────
window.onEngineStatus = (msg) => {
    statusBadge.innerHTML = `<i data-lucide="zap"></i> ${msg}`;
    lucide.createIcons({ nodes: [statusBadge] });
    window.showToast(msg, "zap");
};

// ── Playhead updates: Engine → UI Timeline ──────────────────────────
window.onPlayheadUpdate = (ms) => {
    window.S.time = ms / 1000;
    window.updatePlayhead();
};

// ── Thumbnail updates: debounced re-render ──────────────────────────
let thumbnailRenderDebounce = null;
window.onThumbnailsUpdated = (thumbnails) => {
    if (!hasRealVideo) return;
    if (window.videoClips.length > 0 && window.videoClips[0].isReal) {
        window.videoClips[0].thumbnails = thumbnails;
    }
    clearTimeout(thumbnailRenderDebounce);
    thumbnailRenderDebounce = setTimeout(() => {
        window.renderClips();
    }, 600);
};

// ── Import complete: Replace empty clips with real video ────────────
window.onClipImported = ({ clipId, width, height, durationMs, fileName }) => {
    hasRealVideo = true;
    const durationSec = durationMs / 1000;
    window.S.dur = durationSec;

    const displayName = fileName || "Imported Video";

    window.videoClips = [{
        id: "real_v1",
        name: displayName,
        start: 0,
        end: durationSec,
        isReal: true,
        thumbnails: getThumbnails ? getThumbnails() : [],
    }];

    window.audioClips = [{
        id: "real_a1",
        name: displayName.replace(/\.[^.]+$/, ""),
        start: 0,
        end: durationSec,
        isReal: true,
    }];

    // Reset AI state for new clip
    window.aiNodes = [];
    if (window.resetAiActions) window.resetAiActions();

    // Add to media pool
    window.mediaPool.footage = [
        { id: "imported_real", name: displayName, isReal: true, dur: durationSec.toFixed(1) + "s" },
    ];

    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
    window.renderMedia("footage");
    window.showToast(`Clip loaded (${width}×${height})`, "film");

    // FIX #3: Removed the rapid 5-point seek scan — it raced with the
    // worker's seek queue. Thumbnails now build naturally during playback
    // and scrubbing, which is how professional NLEs work anyway.
};

// ── Connect Playback Control to Engine ───────────────────────────────
window.togglePlay = function () {
    const nowPlaying = togglePlayback();
    document
        .querySelectorAll(".icon-play")
        .forEach((i) =>
            i.setAttribute("data-lucide", nowPlaying ? "pause" : "play"),
        );
    lucide.createIcons();
    window.S.playing = nowPlaying;
};

// ── Pause Callback ──────────────────────────────────────────────────
window.onPlaybackPaused = () => {
    window.S.playing = false;
    document
        .querySelectorAll(".icon-play")
        .forEach((i) => i.setAttribute("data-lucide", "play"));
    lucide.createIcons();
};

// ── Timeline Scrub: Debounced ────────────────────────────────────────
let scrubDebounce = null;
let lastScrubMs = -1;

window.onPlayheadScrub = (timeSec) => {
    const ms = Math.round(timeSec * 1000);
    if (Math.abs(ms - lastScrubMs) < 50) return;
    lastScrubMs = ms;

    clearTimeout(scrubDebounce);
    scrubDebounce = setTimeout(() => {
        seekTo(ms).catch(console.error);
    }, 80);
};

// ── Video Export Trigger ─────────────────────────────────────────────
window.handleExport = async function () {
    await exportVideo((progress) => {
        const pct = Math.round(progress * 100);
        statusBadge.innerHTML = `<i data-lucide="loader"></i> Exporting… ${pct}%`;
        lucide.createIcons({ nodes: [statusBadge] });
    });
};

// ── Color grading sliders ────────────────────────────────────────────
document.addEventListener("input", (e) => {
    const slider = e.target.closest("[data-grade]");
    if (!slider) return;
    setColorGrade({ [slider.dataset.grade]: parseFloat(slider.value) });
});

// ── Score Badge Performance Loop ─────────────────────────────────────
setInterval(() => {
    if (!window.S.playing) return;
    const { composite } = perf.score();
    if (composite === 0) return;
    scoreValue.textContent = composite;
    scoreValue.className =
        "score-value " +
        (composite >= 70 ? "good" : composite >= 40 ? "ok" : "bad");
}, 2000);

// ── Drag & Drop ──────────────────────────────────────────────────────
const canvasWrapper = document.getElementById("canvas-wrapper");
canvasWrapper.addEventListener("dragenter", () => {
    dropOverlay.style.display = "flex";
});
canvasWrapper.addEventListener("dragleave", (e) => {
    if (!canvasWrapper.contains(e.relatedTarget)) {
        dropOverlay.style.display = "none";
    }
});
canvasWrapper.addEventListener("dragover", (e) => e.preventDefault());
canvasWrapper.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropOverlay.style.display = "none";
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) await importFile(file);
});

fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) await importFile(file);
});

// ── Engine Initialization ────────────────────────────────────────────
initEngine(canvasEl)
    .then(() => {
        console.log("[iKlippa] Engine ready. Drop a video file to begin.");
        console.log(
            "[iKlippa] Run iklippaScore() in the console at any time for a benchmark report.",
        );
        statusBadge.innerHTML =
            '<i data-lucide="cloud-lightning"></i> Engine ready';
        lucide.createIcons({ nodes: [statusBadge] });
    })
    .catch((err) => {
        console.error("[iKlippa] WASM load failed:", err);
        statusBadge.innerHTML =
            '<i data-lucide="alert-triangle"></i> WASM load failed';
        lucide.createIcons({ nodes: [statusBadge] });
    });