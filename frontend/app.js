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
} from "./engine.js";

const canvasEl = document.getElementById("canvas-img");
const dropOverlay = document.getElementById("drop-overlay");
const fileInput = document.getElementById("file-input");
const statusBadge = document.querySelector(".status-badge");
const scoreValue = document.getElementById("score-value");

// ── Engine Status to UI ──────────────────────────────────────────────
window.onEngineStatus = (msg) => {
    statusBadge.innerHTML = `<i data-lucide="zap"></i> ${msg}`;
    lucide.createIcons({ nodes: [statusBadge] });
    window.showToast(msg, "zap");
};

// ── Playhead updates: Engine to UI Timeline ──────────────────────────
window.onPlayheadUpdate = (ms) => {
    window.S.time = ms / 1000;
    window.updatePlayhead();
};

// ── Import complete: Update UI Duration ──────────────────────────────
window.onClipImported = ({ clipId, width, height, durationMs }) => {
    window.S.dur = durationMs / 1000;
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
    window.showToast(`Clip loaded (${width}×${height})`, "film");
};

// ── Connect Playback Control to Engine ───────────────────────────────
window.togglePlay = function () {
    const nowPlaying = togglePlayback(); // engine.js determines status
    document
        .querySelectorAll(".icon-play")
        .forEach((i) =>
            i.setAttribute("data-lucide", nowPlaying ? "pause" : "play"),
        );
    lucide.createIcons();
    window.S.playing = nowPlaying;
};

// ── Pause Callback (such as end of timeline) ──────────────────────────
window.onPlaybackPaused = () => {
    window.S.playing = false;
    document
        .querySelectorAll(".icon-play")
        .forEach((i) => i.setAttribute("data-lucide", "play"));
    lucide.createIcons();
};

// ── Timeline Scrub: Handle and Debounce ────────────────────────────────
let scrubDebounce = null;
let lastScrubMs = -1;

window.onPlayheadScrub = (timeSec) => {
    const ms = Math.round(timeSec * 1000);
    if (Math.abs(ms - lastScrubMs) < 50) return; // avoid sub-50ms noise
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

// ── Color grading sliders connection ──────────────────────────────────
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

// ── Drag & Drop Event Handling ────────────────────────────────────────
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

// File picker configuration
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