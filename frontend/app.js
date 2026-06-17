import {
    initEngine,
    importFile,
    startPlayback,
    pausePlayback,
    togglePlayback,
    seekTo,
    setColorGrade,
    exportVideo,
    addClip,
    perf,
} from "./engine.js";

const canvasEl = document.getElementById("canvas-img");
const dropOverlay = document.getElementById("drop-overlay");
const fileInput = document.getElementById("file-input");
const statusBadge = document.querySelector(".status-badge");
const scoreValue = document.getElementById("score-value");

window.mediaFiles = new Map(); // fileId -> { name, picId }

window.onEngineStatus = (msg) => {
    statusBadge.innerHTML = `<i data-lucide="zap"></i> ${msg}`;
    lucide.createIcons({ nodes: [statusBadge] });
    window.showToast(msg, "zap");
};

window.onPlayheadUpdate = (ms) => {
    window.S.time = ms / 1000;
    window.updatePlayhead();
};

window.onClipImported = ({ width, height, durationMs }) => {
    window.S.dur = durationMs / 1000;
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
    window.showToast(`Clip loaded (${width}×${height})`, "film");
};

// ── FIXED: Bridge UI Timeline to Engine ───────────────────────────────
window.addClipToTimeline = function (fileId, track, startSec, endSec, sourceStartSec, sourceEndSec) {
    addClip(fileId, track, startSec, endSec, sourceStartSec, sourceEndSec);
    const fileData = window.mediaFiles.get(fileId);

    // 🧹 Clear placeholder/dummy clips on first real import
    if (window.videoClips.length > 0 && window.videoClips[0].id.startsWith('vc')) {
        window.videoClips = [];
    }
    if (window.audioClips.length > 0 && window.audioClips[0].id.startsWith('ac')) {
        window.audioClips = [];
    }

    // 🎯 Push to the array that ui.js actually renders
    window.videoClips.push({
        id: "clip_" + Date.now() + Math.random().toString(36).substr(2, 5),
        fileId,
        track,
        start: startSec,
        end: endSec,
        sourceStart: sourceStartSec,
        sourceEnd: sourceEndSec,
        name: fileData.name,
        picId: fileData.picId || 29, // Random thumbnail from picsum
    });

    window.renderClips();
};

window.togglePlay = function () {
    const nowPlaying = togglePlayback();
    document.querySelectorAll(".icon-play").forEach((i) =>
        i.setAttribute("data-lucide", nowPlaying ? "pause" : "play")
    );
    lucide.createIcons();
    window.S.playing = nowPlaying;
};

window.onPlaybackPaused = () => {
    window.S.playing = false;
    document.querySelectorAll(".icon-play").forEach((i) => i.setAttribute("data-lucide", "play"));
    lucide.createIcons();
};

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

window.handleExport = async function () {
    await exportVideo((progress) => {
        const pct = Math.round(progress * 100);
        statusBadge.innerHTML = `<i data-lucide="loader"></i> Exporting… ${pct}%`;
        lucide.createIcons({ nodes: [statusBadge] });
    });
};

document.addEventListener("input", (e) => {
    const slider = e.target.closest("[data-grade]");
    if (!slider) return;
    setColorGrade({ [slider.dataset.grade]: parseFloat(slider.value) });
});

setInterval(() => {
    if (!window.S.playing) return;
    const { composite } = perf.score();
    if (composite === 0) return;
    scoreValue.textContent = composite;
    scoreValue.className = "score-value " + (composite >= 70 ? "good" : composite >= 40 ? "ok" : "bad");
}, 2000);

const canvasWrapper = document.getElementById("canvas-wrapper");
canvasWrapper.addEventListener("dragenter", () => { dropOverlay.style.display = "flex"; });
canvasWrapper.addEventListener("dragleave", (e) => {
    if (!canvasWrapper.contains(e.relatedTarget)) dropOverlay.style.display = "none";
});
canvasWrapper.addEventListener("dragover", (e) => e.preventDefault());

// ── UPDATED DROP HANDLER ────────────────────────────────────────────
canvasWrapper.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropOverlay.style.display = "none";
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
        const result = await importFile(file);
        const fileId = result.fileId;

        // Store metadata for UI rendering
        window.mediaFiles.set(fileId, {
            name: file.name,
            picId: Math.floor(Math.random() * 100) + 10
        });

        // Add to timeline at Track 0, spanning the full duration
        window.addClipToTimeline(
            fileId,
            0,
            0,
            result.durationMs / 1000,
            0,
            result.durationMs / 1000
        );
    }
});

fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) {
        const result = await importFile(file);
        window.mediaFiles.set(result.fileId, { name: file.name, picId: Math.floor(Math.random() * 100) + 10 });
        window.addClipToTimeline(result.fileId, 0, 0, result.durationMs / 1000, 0, result.durationMs / 1000);
    }
});

initEngine(canvasEl)
    .then(() => {
        console.log("[iKlippa] Engine ready. Drop a video file to begin.");
        statusBadge.innerHTML = '<i data-lucide="cloud-lightning"></i> Engine ready';
        lucide.createIcons({ nodes: [statusBadge] });
    })
    .catch((err) => {
        console.error("[iKlippa] WASM load failed: ", err);
        statusBadge.innerHTML = '<i data-lucide="alert-triangle"></i> WASM load failed';
        lucide.createIcons({ nodes: [statusBadge] });
    });