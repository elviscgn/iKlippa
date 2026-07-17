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
    captureThumbnail,
    setTimeline,
    getProjectJson,
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

// ── Playhead updates: Engine → UI ───────────────────────────────────
window.onPlayheadUpdate = (ms) => {
    window.S.time = ms / 1000;
    window.updatePlayhead();
};

// ── Thumbnail updates: debounced re-render ──────────────────────────
let thumbnailRenderDebounce = null;
window.onThumbnailsUpdated = (thumbnails) => {
    if (!hasRealVideo) return;
    const clips = IKState.getVideoClips();
    if (clips.length > 0 && clips[0].isReal) {
        IKState.setClipMeta(clips[0].id, { thumbnails });
    }
    clearTimeout(thumbnailRenderDebounce);
    thumbnailRenderDebounce = setTimeout(() => {
        window.renderClips();
    }, 600);
};

// ── Import complete: build project model + sync to Rust + verify round-trip
window.onClipImported = async ({ width, height, durationMs, fileName }) => {
    hasRealVideo = true;
    const durationSec = durationMs / 1000;
    const displayName = fileName || "Imported Video";

    // Init project if not already ready
    if (!IKState.isReady()) {
        IKState.init(width, height);
    }

    const sourceId = "imported_" + Date.now();

    // Add to media pool only — user drags onto timeline when ready
    window.mediaPool.footage.push({
        id: sourceId, name: displayName, isReal: true, dur: durationSec.toFixed(1) + "s", thumbDataUrl: null, width, height
    });
    window.renderMedia("footage");
    window.showToast(`Clip loaded (${width}×${height})`, "film");

    // Seek to 0 to show first frame + capture thumbnail for THIS item
    window.S.time = 0;
    window.updatePlayhead();
    await seekTo(0);

    let thumbAttempts = 0;
    const tryCaptureThumb = () => {
        if (thumbAttempts++ > 15) return;
        const thumb = captureThumbnail();
        if (thumb) {
            const entry = window.mediaPool.footage.find(f => f.id === sourceId);
            if (entry) {
                entry.thumbDataUrl = thumb;
                window.renderMedia("footage");
            }
        } else {
            setTimeout(tryCaptureThumb, 150);
        }
    };
    setTimeout(tryCaptureThumb, 150);
};

// ── Trim applied: update duration ──────────────────────────────────
window.onTrimApplied = ({ durationMs }) => {
    window.calculateTimelineDuration();
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
};

// ── Split result: update UI clips ──────────────────────────────────
window.onSplitResult = ({ newClipId, originalClipId, splitAtMs, durationMs }) => {
    window.calculateTimelineDuration();
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
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

// ── Timeline Scrub: Throttled ────────────────────────────────────────
let lastSeekMs = -1;
window.onPlayheadScrub = (timeSec) => {
    const ms = Math.round(timeSec * 1000);
    if (Math.abs(ms - lastSeekMs) < 50) return;
    lastSeekMs = ms;
    seekTo(ms).catch(console.error);
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

    // Update the displayed value
    const valSpan = slider.parentElement.querySelector('.grade-val');
    if (valSpan) {
        const v = parseFloat(slider.value);
        valSpan.textContent = v === 0 ? '0' : v.toFixed(2);
    }

    setColorGrade({ [slider.dataset.grade]: parseFloat(slider.value) });
});

// ── Reset grade ──────────────────────────────────────────────────────
window.resetGrade = function () {
    document.querySelectorAll('[data-grade]').forEach(el => {
        if (el.tagName === 'SELECT') {
            el.value = '0';
        } else {
            el.value = 0;
        }
        const valSpan = el.parentElement.querySelector('.grade-val');
        if (valSpan) valSpan.textContent = '0';
        if (el.dataset.grade === 'lut') {
            setColorGrade({ lut: 0 });
        } else {
            setColorGrade({ [el.dataset.grade]: 0 });
        }
    });
    window.showToast('Grade reset', 'sliders-horizontal');
};

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
canvasWrapper.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
});
canvasWrapper.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropOverlay.style.display = "none";
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
        await importFile(file);
        return;
    }
    const textData = e.dataTransfer.getData("text/plain");
    if (!textData) return;
    try {
        const data = JSON.parse(textData);
        if (data.id && data.name) {
            window.saveSnapshot();
            IKState.addVideoClip("stock_" + data.id, 0, 4_000_000, {
                name: data.name,
                isReal: false,
                picId: data.picId || 0,
            });
            IKState.computeDuration();
            window.calculateTimelineDuration();
            window.renderRuler();
            window.renderClips();
            window.updatePlayhead();
            showToast("Stock added via canvas", "film");
        }
    } catch {}
});

fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) await importFile(file);
});

// ── Engine Initialization ────────────────────────────────────────────
initEngine(canvasEl)
    .then(() => {
        console.log("[iKlippa] Engine ready. Drop a video file to begin.");
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