"use strict";

lucide.createIcons();

window.S = {
    time: 0,
    dur: 10,
    playing: false,
    rafId: null,
    lastTs: null,
    zoom: 1,
    tool: "select",
    selectedAR: "16/9",
    timelineHeight: 360,
};

window.mediaPool = {
    footage: [],
    audio: [],
    stock: {
        video: [
            { id: "sv1", name: "Neon_Drive.mp4", picId: 83 },
            { id: "sv2", name: "Drone_City.mp4", picId: 103 },
        ],
        image: [
            { id: "si1", name: "Abstract_Texture.jpg", picId: 122 },
            { id: "si2", name: "Modern_Architecture.jpg", picId: 155 },
        ],
        music: [
            { id: "sm1", name: "Epic_Cinematic.mp3", dur: "2:10" },
            { id: "sm2", name: "Corporate_Rhythm.wav", dur: "1:45" },
        ],
    },
};

// FIX #1: Start empty — no fake placeholder clips
// window.videoClips / window.audioClips are now live getters defined in
// state.js that return clips from IKState.project.tracks.
window.aiNodes = [];

const picUrl = (id, w, h) => `https://picsum.photos/id/${id}/${w}/${h}`;
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// µs → seconds helper for timeline display math (UI stays in seconds for
// pixel positioning; the canonical model in state.js uses µs).
const us2s = (us) => us / 1_000_000;

// ── Toast ──────────────────────────────────────────────────────────────
window.showToast = function (msg, iconStr) {
    const box = $("#toast-box");
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<i data-lucide="${iconStr}"></i> <span>${msg}</span>`;
    box.appendChild(t);
    lucide.createIcons({ nodes: [t] });
    setTimeout(() => {
        t.classList.add("hide");
        setTimeout(() => t.remove(), 300);
    }, 3000);
};

// ── Sparkle Animation ──────────────────────────────────────────────────
window.triggerSparkle = function (el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    for (let i = 0; i < 8; i++) {
        const p = document.createElement("div");
        p.innerHTML =
            '<svg viewBox="0 0 24 24" fill="var(--accent-primary)" style="width:12px;height:12px;"><path d="M12 2L15 9L22 12L15 15L12 22L9 15L2 12L9 9L12 2Z"/></svg>';
        Object.assign(p.style, {
            position: "fixed",
            left: cx - 6 + "px",
            top: cy - 6 + "px",
            pointerEvents: "none",
            zIndex: "9999",
            transition: "all 0.8s cubic-bezier(0.175,0.885,0.32,1.275)",
            opacity: "1",
            transform: "scale(0.5)",
        });
        document.body.appendChild(p);
        setTimeout(() => {
            const angle = (i / 8) * Math.PI * 2 + Math.random() * 0.5;
            const dist = 40 + Math.random() * 30;
            p.style.transform = `translate(${Math.cos(angle) * dist}px,${Math.sin(angle) * dist}px) scale(1) rotate(${Math.random() * 180}deg)`;
            p.style.opacity = "0";
        }, 10);
        setTimeout(() => p.remove(), 800);
    }
    showToast("Granite AI is listening...", "sparkles");
};

// ── Toolbar UI Actions ─────────────────────────────────────────────────
let isTextActive = false;
let isEffectActive = false;

$("#t-text").onclick = () => {
    isTextActive = !isTextActive;
    $("#t-text").classList.toggle("active");
    $("#canvas-text").classList.toggle("active");
    showToast(
        isTextActive ? "Text Overlay Enabled" : "Text Overlay Disabled",
        "type",
    );
};

$("#t-effects").onclick = () => {
    isEffectActive = !isEffectActive;
    $("#t-effects").classList.toggle("active");
    $("#canvas-frame").style.filter = isEffectActive
        ? "contrast(1.1) saturate(1.2) sepia(0.1) hue-rotate(-10deg)"
        : "none";
    showToast(
        isEffectActive ? "Cinematic Grade Applied" : "Grade Removed",
        "sparkles",
    );
};

window.toggleFcb = () => {
    $("#fcb").classList.toggle("collapsed");
};

$$("#editor-color-picker .color-swatch").forEach((sw) => {
    sw.onclick = () => {
        $$("#editor-color-picker .color-swatch").forEach(
            (s) => (s.style.borderColor = "rgba(255,255,255,0.1)"),
        );
        sw.style.borderColor = "white";
        document.documentElement.style.setProperty(
            "--accent-primary",
            sw.dataset.color,
        );
        document.documentElement.style.setProperty(
            "--accent-hover",
            sw.dataset.color,
        );
        document.documentElement.style.setProperty(
            "--accent-glow",
            sw.dataset.glow,
        );
    };
});

$$(".ai-tab").forEach((tab) => {
    tab.onclick = () => {
        $$(".ai-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        ["tab-chat", "tab-script", "tab-brand"].forEach(
            (id) => ($("#" + id).style.display = "none"),
        );
        $("#" + tab.dataset.target).style.display = "flex";
    };
});

// ── Chat Autocomplete ─────────────────────────────────────────────────
const cmdInput = $("#ai-cmd");
const acMenu = $("#ac-menu");

cmdInput.addEventListener("input", (e) => {
    const lastWord = e.target.value.split(" ").pop();
    if (lastWord.startsWith("/")) {
        acMenu.innerHTML =
            '<div class="ac-section">Commands</div>' +
            '<div class="ac-item" onclick="insertAC(\'/trim-silence \')"><i data-lucide="scissors"></i> /trim-silence</div>' +
            '<div class="ac-item" onclick="insertAC(\'/sync-audio \')"><i data-lucide="music"></i> /sync-audio</div>' +
            '<div class="ac-item" onclick="insertAC(\'/auto-broll \')"><i data-lucide="sparkles"></i> /auto-broll</div>' +
            '<div class="ac-item" onclick="insertAC(\'/add-captions \')"><i data-lucide="captions"></i> /add-captions</div>';
        lucide.createIcons({ nodes: [acMenu] });
        acMenu.classList.add("active");
    } else if (lastWord.startsWith("@")) {
        // FIX: Build @ mention list from actual clips
        const clipItems = window.videoClips.map(c =>
            `<div class="ac-item" onclick="insertAC('@${c.name.replace(/[^a-zA-Z0-9_]/g, '_')} ')"><i data-lucide="film"></i> @${c.name}</div>`
        ).join("");
        acMenu.innerHTML =
            '<div class="ac-section">Clips</div>' +
            (clipItems || '<div class="ac-item" style="color:var(--text-muted);">No clips yet</div>');
        lucide.createIcons({ nodes: [acMenu] });
        acMenu.classList.add("active");
    } else {
        acMenu.classList.remove("active");
    }
});

window.insertAC = function (text) {
    const words = cmdInput.value.split(" ");
    words.pop();
    cmdInput.value = (words.join(" ") + " " + text).trim() + " ";
    acMenu.classList.remove("active");
    cmdInput.focus();
};

// ── Canvas resizing and Aspect Ratio ────────────────────────────────────
window.resizeCanvas = function () {
    const wrapper = $("#canvas-wrapper");
    const frame = $("#canvas-frame");
    if (!wrapper || !frame) return;
    const [wStr, hStr] = window.S.selectedAR.split("/");
    const targetRatio = parseFloat(wStr) / parseFloat(hStr);
    const wrapperRatio = wrapper.clientWidth / wrapper.clientHeight;
    if (wrapperRatio > targetRatio) {
        frame.style.height = "100%";
        frame.style.width = "auto";
    } else {
        frame.style.width = "100%";
        frame.style.height = "auto";
    }
};
window.addEventListener("resize", window.resizeCanvas);

$("#ar-btn").onclick = (e) => {
    e.stopPropagation();
    $("#ar-menu").classList.toggle("open");
};

window.addEventListener("click", () => $("#ar-menu").classList.remove("open"));

$$(".ar-option").forEach((opt) => {
    opt.onclick = () => {
        $$(".ar-option").forEach((o) => o.classList.remove("active"));
        opt.classList.add("active");
        $("#ar-label").textContent = opt.dataset.label.split(" ")[0];
        $("#ar-icon").setAttribute("data-lucide", opt.dataset.icon);
        window.S.selectedAR = opt.dataset.ar;
        $("#canvas-frame").style.aspectRatio = window.S.selectedAR;
        window.resizeCanvas();
        $("#panel-right").style.width =
            window.S.selectedAR === "9/16" || window.S.selectedAR === "4/5"
                ? "340px"
                : "300px";
        lucide.createIcons({ nodes: [$("#ar-btn")] });
        showToast("Canvas set to " + opt.dataset.label, "monitor");
    };
});

document.addEventListener("keydown", (e) => {
    if (
        e.code === "Space" &&
        e.target.tagName !== "INPUT" &&
        e.target.tagName !== "TEXTAREA"
    ) {
        e.preventDefault();
        window.togglePlay();
    }
});

// ── Media Rendering Logic ──────────────────────────────────────────────
window.renderMedia = function (type, subType = null) {
    const grid = $("#media-grid");
    const list = $("#media-list");
    grid.innerHTML = list.innerHTML = "";
    let data = [];
    if (type === "footage" || type === "audio") {
        data = window.mediaPool[type];
        $("#stock-subtabs").style.display = "none";
    } else if (type === "stock") {
        $("#stock-subtabs").style.display = "flex";
        data = window.mediaPool.stock[subType || "video"];
    }
    if (type === "audio" || (type === "stock" && subType === "music")) {
        grid.style.display = "none";
        list.style.display = "flex";
        data.forEach((item) => {
            const el = document.createElement("div");
            el.className = "audio-item";
            const durStr = item.dur || "?";
            el.innerHTML = `<div class="audio-icon"><i data-lucide="music"></i></div><div class="audio-info"><h4>${item.name}</h4><p>${durStr}</p></div>`;
            list.appendChild(el);
        });
    } else {
        grid.style.display = "grid";
        list.style.display = "none";
        if (data.length === 0 && type === "footage") {
            grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px 16px;color:var(--text-muted);font-size:12px;"><i data-lucide="upload" style="width:28px;height:28px;display:block;margin:0 auto 12px;opacity:0.4;"></i>Drop a video file onto the canvas to begin</div>';
            lucide.createIcons({ nodes: [grid] });
            return;
        }
        data.forEach((item) => {
            const el = document.createElement("div");
            el.className = "media-item";
            if (item.isReal) {
                if (item.thumbDataUrl) {
                    el.innerHTML = `<img src="${item.thumbDataUrl}" style="width:100%;height:100%;object-fit:cover;" draggable="false"><div class="media-label">${item.name}</div>`;
                } else {
                    el.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(13,148,136,0.15),rgba(13,148,136,0.05));"><i data-lucide="film" style="width:32px;height:32px;color:var(--accent-primary);"></i></div><div class="media-label">${item.name}</div>`;
                }
            } else {
                el.innerHTML = `<img src="${picUrl(item.picId, 320, 200)}" crossorigin="anonymous"><div class="media-label">${item.name}</div>`;
            }
            el.draggable = true;
            if (item.isReal) {
                el.ondragstart = (e) =>
                    e.dataTransfer.setData(
                        "text/plain",
                        JSON.stringify({
                            sourceId: item.id,
                            name: item.name,
                            isReal: true,
                            dur: item.dur,
                        }),
                    );
            } else {
                el.ondragstart = (e) =>
                    e.dataTransfer.setData(
                        "text/plain",
                        JSON.stringify({
                            id: "vc_" + Date.now(),
                            name: item.name,
                            picId: item.picId || 0,
                            start: 0,
                            end: 4.0,
                        }),
                    );
            }
            el.onclick = () => {
                $$(".media-item").forEach((m) => m.classList.remove("selected"));
                el.classList.add("selected");
            };
            grid.appendChild(el);
        });
    }
    lucide.createIcons();
};

$$(".media-tab").forEach((tab) => {
    tab.onclick = () => {
        $$(".media-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const type = tab.dataset.tab;
        if (type === "stock") {
            $$(".stock-subtab").forEach((s) => s.classList.remove("active"));
            $$(".stock-subtab")[0].classList.add("active");
            window.renderMedia("stock", "video");
        } else window.renderMedia(type);
    };
});

$$(".stock-subtab").forEach((tab) => {
    tab.onclick = () => {
        $$(".stock-subtab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        window.renderMedia("stock", tab.dataset.sub);
    };
});

// ── Timeline Rules and Rendering ───────────────────────────────────────

// ISSUE 2: Dynamically calculate timeline duration based on clips + buffer
window.calculateTimelineDuration = function () {
    let maxEndSec = 0;
    if (typeof IKState !== 'undefined' && IKState.isReady()) {
        const allClips = [...IKState.getVideoClips(), ...IKState.getAudioClips()];
        for (const clip of allClips) {
            const endSec = us2s(clip.timeline_end_us);
            if (endSec > maxEndSec) maxEndSec = endSec;
        }
    }
    // Add 10s buffer after the last clip, minimum 10s total
    const buffered = Math.max(10, maxEndSec + 10);
    window.S.dur = buffered;
    return buffered;
};

// Auto-zoom to keep ~20px per second minimum for readable ruler ticks
let _laneRefW = 0;
window.autoFitZoom = function () {
    if (window.S.dur <= 0) return;
    if (_laneRefW <= 1) {
        const lane = $("#lane-v1");
        if (!lane) return;
        // Ensure no inline width when measuring the natural flex width
        const prevW = lane.style.width;
        lane.style.width = "";
        _laneRefW = lane.getBoundingClientRect().width;
        lane.style.width = prevW;
    }
    if (_laneRefW <= 0) return;
    const minPxPerSec = 20;
    window.S.zoom = Math.max(0.5, (minPxPerSec * window.S.dur) / _laneRefW);
    const zt = $("#zoom-text");
    if (zt) zt.textContent = Math.round(window.S.zoom * 100) + "%";
};

function getLaneW() {
    if (_laneRefW > 1) return _laneRefW * window.S.zoom;
    const lane = $("#lane-v1");
    if (!lane) return 100;
    return lane.getBoundingClientRect().width * window.S.zoom;
}

window.renderRuler = function () {
    const r = $("#tl-ruler");
    r.querySelectorAll(".ruler-tick").forEach((t) => t.remove());
    const tw = getLaneW();
    r.style.width = tw + "px";
    const dur = window.S.dur;
    if (dur <= 0) return;

    // Adaptive tick interval based on duration & zoom
    let interval;
    if (dur <= 10) interval = window.S.zoom > 1.5 ? 0.5 : 1;
    else if (dur <= 30) interval = window.S.zoom > 1.5 ? 1 : 2;
    else if (dur <= 120) interval = window.S.zoom > 1.5 ? 2 : 5;
    else interval = window.S.zoom > 1.5 ? 5 : 10;

    for (let s = 0; s <= dur; s += interval) {
        const tick = document.createElement("div");
        tick.className = "ruler-tick";
        tick.style.left = (s / dur) * tw + "px";
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        const label = m > 0
            ? `${m}:${String(sec).padStart(2, "0")}`
            : `${sec}s`;
        tick.innerHTML = `<div class="tick-line major"></div><span class="tick-label">${label}</span>`;
        r.appendChild(tick);
    }
};

// ISSUE 5: Split tool auto-releases after one use
function activateSplitTool() {
    window.S.tool = "split";
    $$(".tl-tool").forEach((b) => b.classList.remove("active"));
    const splitBtn = document.querySelector('.tl-tool[data-tool="split"]');
    if (splitBtn) splitBtn.classList.add("active");
}

function deactivateSplitTool() {
    window.S.tool = "select";
    $$(".tl-tool").forEach((b) => b.classList.remove("active"));
    const selectBtn = document.querySelector('.tl-tool[data-tool="select"]');
    if (selectBtn) selectBtn.classList.add("active");
}

// ── Snap Logic ─────────────────────────────────────────────────────────
const SNAP_THRESHOLD_PX = 8;
const selectedClipIds = new Set();

function syncActiveClasses() {
    $$(".tl-clip").forEach((c) => c.classList.toggle("active", selectedClipIds.has(parseInt(c.dataset.clipId))));
}

function reRender(activeClipId) {
    IKState.computeDuration();
    window.calculateTimelineDuration();
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
    if (activeClipId !== undefined) {
        selectedClipIds.clear();
        selectedClipIds.add(activeClipId);
        const el = document.querySelector(`[data-clip-id="${activeClipId}"]`);
        if (el) el.classList.add("active");
    } else if (selectedClipIds.size > 0) {
        const sel = [...selectedClipIds];
        selectedClipIds.clear();
        for (const id of sel) {
            selectedClipIds.add(id);
            const el = document.querySelector(`[data-clip-id="${id}"]`);
            if (el) el.classList.add("active");
        }
    }
}

function getSnapPoints(excludeClipId) {
    const points = new Set();
    points.add(0);
    points.add(Math.round(window.S.time * 1_000_000));
    const allClips = [...window.videoClips, ...window.audioClips];
    for (const c of allClips) {
        if (c.id === excludeClipId) continue;
        points.add(c.timeline_start_us);
        points.add(c.timeline_end_us);
    }
    return Array.from(points);
}

function applySnap(rawUs, excludeClipId, tw) {
    const thresholdUs = Math.round((SNAP_THRESHOLD_PX / tw) * window.S.dur * 1_000_000);
    const points = getSnapPoints(excludeClipId);
    let best = null;
    for (const p of points) {
        if (Math.abs(rawUs - p) <= thresholdUs) {
            if (best === null || Math.abs(rawUs - p) < Math.abs(rawUs - best)) {
                best = p;
            }
        }
    }
    return best;
}

const snapGuide = $("#snap-guide");

function showSnapGuide(timeUs, tw) {
    const px = (us2s(timeUs) / window.S.dur) * tw;
    snapGuide.style.left = (100 + px) + "px";
    snapGuide.classList.add("active");
}

function hideSnapGuide() {
    snapGuide.classList.remove("active");
}

// ── Undo / Redo ──────────────────────────────────────────────────────────
const MAX_UNDO = 50;
let undoStack = [];
let redoStack = [];

window.saveSnapshot = function () {
    undoStack.push(IKState.saveState());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
};

function afterUndoRedo() {
    reRender();
}

window.undo = function () {
    if (undoStack.length === 0) return;
    redoStack.push(IKState.saveState());
    const prev = undoStack.pop();
    IKState.loadState(prev);
    afterUndoRedo();
};

window.redo = function () {
    if (redoStack.length === 0) return;
    undoStack.push(IKState.saveState());
    const next = redoStack.pop();
    IKState.loadState(next);
    afterUndoRedo();
};

function applyDragLogic(el, clip, clipArray, tw) {
    el.onmousedown = (e) => {
        if (window.S.tool === "split") {
            // ISSUE 5: Split once, then auto-release
            const rect = el.parentElement.getBoundingClientRect();
            const clickX =
                e.clientX - rect.left + el.parentElement.parentElement.scrollLeft;
            const t = (clickX / tw) * window.S.dur;
            const clipStartSec = us2s(clip.timeline_start_us);
            const clipEndSec = us2s(clip.timeline_end_us);
            if (t > clipStartSec + 0.5 && t < clipEndSec - 0.5) {
                saveSnapshot();
                const splitAtUs = Math.round(t * 1_000_000);
                const newId = IKState.splitClip(clip.id, splitAtUs);
                if (newId !== null) {
                    showToast("Clip Split", "scissors");
                    reRender(newId);
                }
            }
            deactivateSplitTool();
        } else if (window.S.tool === "select") {
            if (e.ctrlKey || e.metaKey) {
                if (selectedClipIds.has(clip.id)) selectedClipIds.delete(clip.id);
                else selectedClipIds.add(clip.id);
            } else {
                selectedClipIds.clear();
                selectedClipIds.add(clip.id);
            }
            syncActiveClasses();
            const dur = window.S.dur;
            if (dur <= 0) return;

            // ── Detect trim vs move ──────────────────────────────────────
            const clipRect = el.getBoundingClientRect();
            const clickXInClip = e.clientX - clipRect.left;
            const trimZone = 8;
            const isLeftTrim = clickXInClip < trimZone;
            const isRightTrim = clickXInClip > clipRect.width - trimZone;

            if (isLeftTrim || isRightTrim) {
                // ── TRIM MODE (always single clip) ──────────────────────────
                const origStartUs = clip.timeline_start_us;
                const origEndUs = clip.timeline_end_us;
                const origSourceStartUs = clip.source_start_us;
                const speed = clip.speed || 1;
                const minDurUs = 500_000;
                const lane = el.parentElement;

                const move = (e2) => {
                    const laneRect = lane.getBoundingClientRect();
                    const scrollLeft = lane.parentElement ? lane.parentElement.scrollLeft : 0;
                    const mx = e2.clientX - laneRect.left + scrollLeft;
                    const mouseSec = (mx / tw) * dur;

                    if (isLeftTrim) {
                        const rawUs = Math.round(mouseSec * 1_000_000);
                        const snapped = applySnap(rawUs, clip.id, tw);
                        const newStartUs = Math.round(
                            Math.max(0, Math.min(snapped !== null ? snapped : rawUs, origEndUs - minDurUs))
                        );
                        const newEndUs = origEndUs;
                        const newSourceStartUs = origSourceStartUs + Math.round((newStartUs - origStartUs) / speed);
                        const leftPx = (us2s(newStartUs) / dur) * tw;
                        const widthPx = (us2s(newEndUs - newStartUs) / dur) * tw;
                        el.style.left = leftPx + "px";
                        el.style.width = widthPx + "px";
                        el._trimNewStart = newStartUs;
                        el._trimNewSourceStart = Math.max(0, newSourceStartUs);
                        if (snapped !== null) showSnapGuide(newStartUs, tw);
                        else hideSnapGuide();
                    } else {
                        const rawUs = Math.round(mouseSec * 1_000_000);
                        const snapped = applySnap(rawUs, clip.id, tw);
                        const newEndUs = Math.round(
                            Math.max(origStartUs + minDurUs, snapped !== null ? snapped : rawUs)
                        );
                        const widthPx = (us2s(newEndUs - origStartUs) / dur) * tw;
                        el.style.width = widthPx + "px";
                        el._trimNewEnd = newEndUs;
                        if (snapped !== null) showSnapGuide(newEndUs, tw);
                        else hideSnapGuide();
                    }
                };

                const up = () => {
                    document.removeEventListener("mousemove", move);
                    document.removeEventListener("mouseup", up);
                    hideSnapGuide();
                    if (!document.body.contains(el)) return;
                    if (isLeftTrim && el._trimNewStart !== undefined) {
                        saveSnapshot();
                        IKState.trimClip(clip.id, el._trimNewStart, origEndUs, el._trimNewSourceStart);
                    } else if (isRightTrim && el._trimNewEnd !== undefined) {
                        saveSnapshot();
                        IKState.trimClip(clip.id, origStartUs, el._trimNewEnd, origSourceStartUs);
                    }
                    delete el._trimNewStart;
                    delete el._trimNewEnd;
                    delete el._trimNewSourceStart;
                    reRender(clip.id);
                };

                document.addEventListener("mousemove", move);
                document.addEventListener("mouseup", up);
                e.preventDefault();
            } else {
                // ── MOVE MODE (multi-select aware) ──────────────────────────
                const moveIds = selectedClipIds.has(clip.id) ? [...selectedClipIds] : [clip.id];
                const initialPositions = {};
                const moveEls = {};
                for (const id of moveIds) {
                    const c = IKState.findClip(id);
                    if (c) {
                        initialPositions[id] = c.timeline_start_us;
                        const el2 = document.querySelector(`[data-clip-id="${id}"]`);
                        if (el2) moveEls[id] = el2;
                    }
                }
                const startX = e.clientX;

                const move = (e2) => {
                    const dx = e2.clientX - startX;
                    const dtSec = (dx / tw) * dur;
                    for (const id of moveIds) {
                        const startUs = initialPositions[id];
                        const rawUs = Math.round((startUs / 1_000_000 + dtSec) * 1_000_000);
                        const snapped = applySnap(rawUs, clip.id, tw);
                        const newStartUs = Math.max(0, snapped !== null ? snapped : rawUs);
                        const newPx = (us2s(newStartUs) / dur) * tw;
                        const el2 = moveEls[id];
                        if (el2) el2.style.left = newPx + "px";
                    }
                    if (moveIds.length === 1) {
                        const rawUs = Math.round((initialPositions[moveIds[0]] / 1_000_000 + dtSec) * 1_000_000);
                        const snapped = applySnap(rawUs, clip.id, tw);
                        if (snapped !== null) showSnapGuide(snapped, tw);
                        else hideSnapGuide();
                    } else {
                        hideSnapGuide();
                    }
                };
                const up = () => {
                    document.removeEventListener("mousemove", move);
                    document.removeEventListener("mouseup", up);
                    hideSnapGuide();
                    if (!document.body.contains(el)) return;
                    const dx = parseFloat(el.style.left) - (us2s(initialPositions[clip.id]) / dur) * tw;
                    const dtSec = (dx / tw) * dur;
                    saveSnapshot();
                    for (const id of moveIds) {
                        const newStartUs = Math.max(0, Math.round((initialPositions[id] / 1_000_000 + dtSec) * 1_000_000));
                        IKState.moveClip(id, newStartUs);
                    }
                    reRender(clip.id);
                };
                document.addEventListener("mousemove", move);
                document.addEventListener("mouseup", up);
                e.preventDefault();
            }
        }
    };
}

// FIX #4: Deterministic pseudo-random for waveform (no Math.random)
function seededBarHeight(i) {
    // Simple hash-like deterministic value from index
    let x = ((i * 2654435761) >>> 0) & 0xFF;
    return 10 + (x % 28);
}

window.renderClips = function () {
    const laneV1 = $("#lane-v1");
    const laneA1 = $("#lane-a1");
    laneV1.innerHTML = laneA1.innerHTML = "";
    const tw = getLaneW();
    const dur = window.S.dur;
    if (dur <= 0) return;

    // Show empty-state hint when no clips exist
    if (window.videoClips.length === 0) {
        laneV1.innerHTML = '<div class="empty-hint" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px;opacity:0.6;pointer-events:none;">Drop video here</div>';
    }

    // Group clips by group_id to render combined video+audio clips
    const clipGroups = new Map();
    
    // Collect video clips
    window.videoClips.forEach((clip) => {
        const groupId = clip.group_id || `group_${clip.id}`;
        if (!clipGroups.has(groupId)) {
            clipGroups.set(groupId, { video: null, audio: null });
        }
        clipGroups.get(groupId).video = clip;
    });
    
    // Collect audio clips
    window.audioClips.forEach((clip) => {
        const groupId = clip.group_id || `group_${clip.id}`;
        if (!clipGroups.has(groupId)) {
            clipGroups.set(groupId, { video: null, audio: null });
        }
        clipGroups.get(groupId).audio = clip;
    });

    // Render each clip group
    clipGroups.forEach((group, groupId) => {
        const clip = group.video || group.audio;
        if (!clip) return;
        
        const el = document.createElement("div");
        el.className = "tl-clip";
        el.dataset.clipId = clip.id;
        const clipStartSec = us2s(clip.timeline_start_us);
        const clipDurSec = us2s(clip.timeline_end_us) - clipStartSec;
        const left = (clipStartSec / dur) * tw;
        const w = (clipDurSec / dur) * tw;
        el.style.left = left + "px";
        el.style.width = w + "px";

        let content = '';
        
        // Video section only (no audio waveform for video imports)
        if (group.video) {
            const videoClip = group.video;
            if (videoClip.isReal && videoClip.thumbnails && videoClip.thumbnails.length > 0) {
                const count = Math.max(1, Math.floor(w / 60));
                let thumbs = '<div class="tl-clip-thumbs">';
                for (let j = 0; j < count; j++) {
                    const idx = Math.min(
                        Math.floor((j / count) * videoClip.thumbnails.length),
                        videoClip.thumbnails.length - 1
                    );
                    thumbs += `<img src="${videoClip.thumbnails[idx].dataUrl}" draggable="false">`;
                }
                thumbs += "</div>";
                content += `${thumbs}<span class="tl-clip-label">${videoClip.name}</span>`;
            } else if (videoClip.isReal) {
                content += `<span class="tl-clip-label" style="display:flex;align-items:center;gap:6px;"><i data-lucide="film" style="width:12px;height:12px;"></i> ${videoClip.name}</span>`;
            } else if (videoClip.picId) {
                const count = Math.max(1, Math.floor(w / 60));
                let thumbs = '<div class="tl-clip-thumbs">';
                for (let j = 0; j < count; j++)
                    thumbs += `<img src="${picUrl(videoClip.picId, 100, 60)}" crossorigin="anonymous" draggable="false">`;
                thumbs += "</div>";
                content += `${thumbs}<span class="tl-clip-label">${videoClip.name}</span>`;
            } else {
                content += `<span class="tl-clip-label">${videoClip.name}</span>`;
            }
        }
        
        el.innerHTML = content;
        applyDragLogic(el, clip, [clip], tw);
        laneV1.appendChild(el);
    });

    // Audio lane - only for standalone MP3 files (no group_id or unique group)
    const standaloneAudio = window.audioClips.filter(clip => {
        const groupId = clip.group_id;
        // Only show if there's no matching video clip in the same group
        const group = clipGroups.get(groupId);
        return group && !group.video;
    });
    
    if (standaloneAudio.length === 0) {
        laneA1.innerHTML = '<div class="empty-hint" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px;opacity:0.6;pointer-events:none;">Audio track (MP3 only)</div>';
    }
    
    standaloneAudio.forEach((clip) => {
        const el = document.createElement("div");
        el.className = "tl-clip tl-clip-audio";
        el.dataset.clipId = clip.id;
        const clipStartSec = us2s(clip.timeline_start_us);
        const clipDurSec = us2s(clip.timeline_end_us) - clipStartSec;
        const left = (clipStartSec / dur) * tw;
        const w = (clipDurSec / dur) * tw;
        el.style.left = left + "px";
        el.style.width = w + "px";
        const bars = Array.from({ length: Math.max(1, Math.floor(w / 4)) }, (_, i) => {
            const h = seededBarHeight(i);
            return `<rect x="${i * 4}" y="${20 - h / 2}" width="2.5" height="${Math.min(h, 38)}" fill="currentColor" opacity="0.8" rx="1"/>`;
        }).join("");
        el.innerHTML = `<div class="waveform"><svg viewBox="0 0 ${Math.max(1, w)} 40" preserveAspectRatio="none" style="width:100%;height:100%;display:block;">${bars}</svg></div><span class="tl-clip-label" style="position:absolute;bottom:6px;left:8px;">${clip.name}</span>`;
        applyDragLogic(el, clip, standaloneAudio, tw);
        laneA1.appendChild(el);
    });

    $("#lane-ai").innerHTML = "";
    window.aiNodes.forEach((node) => {
        const el = document.createElement("div");
        el.className = "ai-node";
        el.style.left = (node.time / dur) * tw + "px";
        el.innerHTML = `<i data-lucide="${node.icon}"></i> ${node.label}`;
        el.onclick = () => showToast("AI Insight: " + node.label, node.icon);
        $("#lane-ai").appendChild(el);
    });
    lucide.createIcons({ nodes: [$("#lane-ai"), laneV1, laneA1] });

    // Force tracks container to be scrollable via a spacer in normal flow
    // (absolutely positioned clips don't affect scroll dimensions)
    const spacer = (w) => {
        const s = document.createElement("div");
        s.style.cssText = `width:${w}px;height:0;pointer-events:none;`;
        return s;
    };
    laneV1.appendChild(spacer(tw));
    if (laneA1 !== laneV1) laneA1.appendChild(spacer(tw));
    const aiLane = $("#lane-ai");
    if (aiLane) aiLane.appendChild(spacer(tw));
};

$("#lane-v1").ondragover = (e) => e.preventDefault();
$("#lane-v1").ondrop = (e) => {
    e.preventDefault();
    const data = JSON.parse(e.dataTransfer.getData("text/plain"));
    const tw = getLaneW();
    const rect = $("#lane-v1").getBoundingClientRect();
    const t =
        ((e.clientX - rect.left + $("#tl-tracks").scrollLeft) / tw) * window.S.dur;
    const startUs = Math.round(t * 1_000_000);
    saveSnapshot();
    if (data.isReal && data.sourceId) {
        // Real imported video — use its actual duration
        const durSec = parseFloat(data.dur) || 4.0;
        const endUs = Math.round(Math.min(startUs + durSec * 1_000_000, window.S.dur * 1_000_000));
        IKState.addVideoClip(data.sourceId, startUs, endUs, {
            name: data.name,
            isReal: true,
        }, `group_${Date.now()}`);
        showToast("Clip added to timeline", "film");
    } else {
        // Stock clip — 4 seconds
        const endUs = Math.min(Math.round((t + 4.0) * 1_000_000), Math.round(window.S.dur * 1_000_000));
        IKState.addVideoClip("stock_" + data.id, startUs, endUs, {
            name: data.name,
            isReal: false,
            picId: data.picId || 0,
        });
        showToast("Stock Inserted", "film");
    }
    reRender();
};

$("#tl-body").addEventListener(
    "wheel",
    (e) => {
        if (e.ctrlKey || e.metaKey || !e.shiftKey) {
            e.preventDefault();
            window.S.zoom = Math.max(
                0.5,
                Math.min(50, window.S.zoom + (e.deltaY > 0 ? -0.1 : 0.1)),
            );
            $("#zoom-text").textContent = Math.round(window.S.zoom * 100) + "%";
            window.renderRuler();
            window.renderClips();
            window.updatePlayhead();
        }
    },
    { passive: false },
);

// ISSUE 3: Zoom control buttons
$("#zoom-in")?.addEventListener("click", () => {
    window.S.zoom = Math.min(50, window.S.zoom + 0.25);
    $("#zoom-text").textContent = Math.round(window.S.zoom * 100) + "%";
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
});
$("#zoom-out")?.addEventListener("click", () => {
    window.S.zoom = Math.max(0.5, window.S.zoom - 0.25);
    $("#zoom-text").textContent = Math.round(window.S.zoom * 100) + "%";
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
});

// Sync ruler scroll with track scroll
$("#tl-tracks").addEventListener("scroll", () => {
    const rw = document.querySelector(".tl-ruler-wrapper");
    if (rw) rw.scrollLeft = $("#tl-tracks").scrollLeft;
});

// ISSUE 3: Vertical resize handle for timeline
(function initResizeHandle() {
    const handle = $("#tl-resize-handle");
    if (!handle) return;
    const panel = document.querySelector(".panel-timeline");
    if (!panel) return;
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;
    handle.addEventListener("mousedown", (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = panel.offsetHeight;
        document.body.style.cursor = "ns-resize";
        e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
        if (!isResizing) return;
        const dy = e.clientY - startY;
        const newHeight = Math.max(120, Math.min(window.innerHeight * 0.5, startHeight - dy));
        panel.style.height = newHeight + "px";
        window.S.timelineHeight = newHeight;
    });
    document.addEventListener("mouseup", () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = "";
        }
    });
})();

$$(".tl-tool").forEach((btn) => {
    btn.onclick = () => {
        $$(".tl-tool").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        window.S.tool = btn.dataset.tool;
    };
});

let copiedClipsData = null;

// ADDITIONAL: Keyboard shortcuts
document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyC" && !e.shiftKey) {
        e.preventDefault();
        if (selectedClipIds.size === 0) return;
        const ids = [];
        for (const id of selectedClipIds) ids.push(id, ...IKState.getLinkedClipIds(id));
        copiedClipsData = [...new Set(ids)].map(id => {
            const c = IKState.findClip(id);
            if (!c) return null;
            return { clip: JSON.parse(JSON.stringify(c)), meta: IKState.getClipMeta(id) };
        }).filter(Boolean);
        showToast("Copied " + copiedClipsData.length + " clip(s)", "copy");
    } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyV") {
        e.preventDefault();
        if (!copiedClipsData || copiedClipsData.length === 0) return;
        saveSnapshot();
        const pasteTimeUs = Math.round(window.S.time * 1_000_000);
        let cursorUs = pasteTimeUs;
        const addClip = (c, meta) => {
            const dur = c.timeline_end_us - c.timeline_start_us;
            const isAudio = c.source_id && c.source_id.startsWith("audio_");
            const addFn = isAudio ? IKState.addAudioClip : IKState.addVideoClip;
            const newId = addFn(c.source_id, cursorUs, cursorUs + dur, meta);
            if (newId !== null && c.source_start_us > 0) {
                IKState.trimClip(newId, cursorUs, cursorUs + dur, c.source_start_us);
            }
            cursorUs += dur;
        };
        for (const data of copiedClipsData) addClip(data.clip, data.meta);
        reRender();
        showToast("Pasted " + copiedClipsData.length + " clip(s)", "clipboard-paste");
    } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        e.preventDefault();
        const activeEl = document.querySelector(".tl-clip.active");
        if (!activeEl) return;
        const clipId = parseInt(activeEl.dataset.clipId);
        if (isNaN(clipId)) return;
        const deltaUs = e.shiftKey ? 1_000_000 : Math.round(1_000_000 / 30);
        const dir = e.code === "ArrowLeft" ? -1 : 1;
        const clip = IKState.findClip(clipId);
        if (!clip) return;
        const newStartUs = Math.max(0, clip.timeline_start_us + dir * deltaUs);
        saveSnapshot();
        IKState.moveClip(clipId, newStartUs);
        IKState.computeDuration();
        const tw = getLaneW();
        const dur = window.S.dur;
        const newPx = (us2s(newStartUs) / dur) * tw;
        activeEl.style.left = newPx + "px";
        window.updatePlayhead();
    } else if (e.code === "KeyV" && !(e.ctrlKey || e.metaKey)) {
        deactivateSplitTool();
    } else if (e.code === "KeyS") {
        activateSplitTool();
    } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ" && !e.shiftKey) {
        e.preventDefault();
        window.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ" && e.shiftKey) {
        e.preventDefault();
        window.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyY") {
        e.preventDefault();
        window.redo();
    } else if (e.code === "Delete" || e.code === "Backspace") {
        hideSnapGuide();
        if (selectedClipIds.size === 0) return;
        saveSnapshot();
        const idsToRemove = new Set();
        for (const id of selectedClipIds) {
            idsToRemove.add(id);
            for (const linkedId of IKState.getLinkedClipIds(id)) idsToRemove.add(linkedId);
        }
        for (const id of idsToRemove) IKState.removeClip(id);
        selectedClipIds.clear();
        reRender();
        showToast(idsToRemove.size + " clip(s) deleted", "trash-2");
    }
});

// ── Time Formatting and Playhead Sync ───────────────────────────────
function fmtTime(sec) {
    // FIX #6: compact format for sub-hour clips
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const f = Math.floor((sec % 1) * 30);
    if (h > 0) {
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

window.updatePlayhead = function () {
    const tw = getLaneW();
    const dur = window.S.dur;
    if (dur <= 0) return;
    const px = (window.S.time / dur) * tw;
    // Playhead offset = gutter width (80px) + left padding (20px)
    const gutterWidth = 100;
    $("#ph-tracks").style.left = (gutterWidth + px) + "px";
    $("#timecode").textContent = fmtTime(window.S.time);
};

// UI-Fallback Play Control (overridden by app.js when engine loads)
window.togglePlay = function () {
    if (window.S.playing) {
        window.S.playing = false;
        cancelAnimationFrame(window.S.rafId);
        window.S.lastTs = null;
        $$(".icon-play").forEach((i) => i.setAttribute("data-lucide", "play"));
        lucide.createIcons();
    } else {
        if (window.S.time >= window.S.dur) window.S.time = 0;
        window.S.playing = true;
        window.S.lastTs = null;
        $$(".icon-play").forEach((i) => i.setAttribute("data-lucide", "pause"));
        lucide.createIcons();
        window.S.rafId = requestAnimationFrame(function playLoop(ts) {
            if (!window.S.playing) return;
            if (window.S.lastTs) {
                window.S.time += (ts - window.S.lastTs) / 1000;
            }
            if (window.S.time >= window.S.dur) {
                window.S.time = window.S.dur;
                window.togglePlay();
                return;
            }
            window.S.lastTs = ts;
            window.updatePlayhead();
            window.S.rafId = requestAnimationFrame(playLoop);
        });
    }
};

window.skipTime = function (delta) {
    window.S.time = Math.max(0, Math.min(window.S.dur, window.S.time + delta));
    window.updatePlayhead();
    if (window.onPlayheadScrub) window.onPlayheadScrub(window.S.time);
};

// ── Scrub Seek Event Handling ──────────────────────────────────────────
// ISSUE 1: Fixed alignment — gutter is 80px, ruler starts after it
function handleTimelineScrub(e, el) {
    const rect = el.getBoundingClientRect();
    const isRuler = (el.id === "tl-ruler");
    // Ruler starts after gutter + padding, so no offset needed.
    // Tracks include left padding (20px) + gutter (80px), so subtract 100px.
    const headOffset = isRuler ? 0 : 100;
    const x = Math.max(0, e.clientX - rect.left - headOffset);
    const tw = getLaneW();
    const dur = window.S.dur;
    if (dur <= 0 || tw <= 0) return;
    window.S.time = Math.max(0, Math.min((x / tw) * dur, dur));
    window.updatePlayhead();
    if (window.onPlayheadScrub) window.onPlayheadScrub(window.S.time);
}

$("#tl-tracks").addEventListener("mousedown", (e) => {
    if (e.target.closest(".tl-clip") || e.target.closest(".track-gutter")) return;
    handleTimelineScrub(e, $("#tl-tracks"));
});
$("#tl-ruler").onmousedown = (e) => handleTimelineScrub(e, $("#tl-ruler"));

// Playhead knob drag
(function initPlayheadKnob() {
    const knob = document.querySelector(".playhead-knob");
    if (!knob) return;
    knob.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        const tracks = $("#tl-tracks");
        const tw = getLaneW();
        const dur = window.S.dur;
        if (dur <= 0 || tw <= 0) return;
        const onMove = (e2) => {
            const rect = tracks.getBoundingClientRect();
            const x = Math.max(0, e2.clientX - rect.left - 100);
            const t = Math.max(0, Math.min((x / tw) * dur, dur));
            window.S.time = t;
            $("#ph-tracks").style.left = (100 + (t / dur) * tw) + "px";
            if (window.onPlayheadScrub) window.onPlayheadScrub(t);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });
})();

// ── AI Copilot Chat Interface ──────────────────────────────────────────
function appendChat(text, isUser = false) {
    const el = document.createElement("div");
    el.className = "chat-msg " + (isUser ? "user" : "ai");
    el.innerHTML = isUser
        ? text
        : `<div class="msg-sender"><i data-lucide="bot"></i> Granite</div>${text}`;
    $("#chat-log").appendChild(el);
    lucide.createIcons({ nodes: [el] });
    $("#chat-log").parentElement.scrollTop =
        $("#chat-log").parentElement.scrollHeight;
}

window.submitCmd = function () {
    const input = $("#ai-cmd");
    const val = input.value.trim();
    if (!val) return;
    if (val.startsWith("/") || val.includes("@")) {
        appendChat(val, true);
        input.value = "";
        setTimeout(() => {
            if (val.includes("/trim-silence")) window.applyAiAction("silence");
            else if (val.includes("/sync-audio")) window.applyAiAction("sync");
            else if (val.includes("/add-captions")) window.applyAiAction("captions");
            else appendChat("Command processed.");
        }, 600);
        return;
    }
    input.value = "";
    appendChat(val, true);
    setTimeout(() => {
        if (
            val.toLowerCase().includes("silence") ||
            val.toLowerCase().includes("trim")
        )
            window.applyAiAction("silence");
        else if (
            val.toLowerCase().includes("caption") ||
            val.toLowerCase().includes("text")
        )
            window.applyAiAction("captions");
        else if (
            val.toLowerCase().includes("sync") ||
            val.toLowerCase().includes("beat")
        )
            window.applyAiAction("sync");
        else
            appendChat(
                "I can help with that. Try asking me to 'Trim silences', 'Sync to beat', or 'Add captions'.",
            );
    }, 600);
};

$("#ai-cmd").onkeypress = (e) => {
    if (e.key === "Enter") window.submitCmd();
};

let acts = { trim: false, cap: false, sync: false };

window.resetAiActions = function () {
    acts = { trim: false, cap: false, sync: false };
};

window.applyAiAction = function (type) {
    if (type === "silence" && !acts.trim) {
        saveSnapshot();
        if (window.videoClips.length === 1 && window.videoClips[0].isReal) {
            const clip = window.videoClips[0];
            const startUs = clip.timeline_start_us;
            const origDurUs = clip.timeline_end_us - clip.timeline_start_us;
            const trimmedDurUs = Math.round(origDurUs * 0.92);
            IKState.trimClip(clip.id, startUs, startUs + trimmedDurUs, clip.source_start_us);
            const trimmedDurSec = us2s(trimmedDurUs);
            window.aiNodes.push({ time: trimmedDurSec, label: "Silence Trimmed", icon: "scissors" });
            $("#insight-score").textContent = "93";
            $("#insight-bar").style.width = "93%";
            $("#insight-box").classList.add("optimized");
            appendChat("Trimmed silent segments automatically.");
            showToast("AI Smart Trim Applied", "scissors");
            acts.trim = true;
        } else if (window.videoClips.length >= 2) {
            const clips = window.videoClips;
            const firstStartSec = us2s(clips[0].timeline_start_us);
            let cursorUs = clips[0].timeline_end_us;
            for (let i = 1; i < clips.length; i++) {
                const clip = clips[i];
                if (clip.timeline_start_us > cursorUs) {
                    IKState.moveClip(clip.id, cursorUs);
                }
                cursorUs = clip.timeline_end_us;
            }
            IKState.computeDuration();
            window.aiNodes.push({ time: firstStartSec, label: "Gaps Trimmed", icon: "scissors" });
            $("#insight-score").textContent = "96";
            $("#insight-bar").style.width = "96%";
            $("#insight-box").classList.add("optimized");
            appendChat("Trimmed gaps between clips automatically.");
            showToast("AI Smart Trim Applied", "scissors");
            acts.trim = true;
        } else {
            showToast("Import a video first", "info");
            return;
        }
    } else if (type === "captions" && !acts.cap) {
        if (window.videoClips.length === 0) { showToast("Import a video first", "info"); return; }
        window.aiNodes.push({ time: Math.min(2.0, window.S.dur * 0.1), label: "Captions Generated", icon: "captions" });
        window.aiNodes.push({ time: Math.min(10.0, window.S.dur * 0.5), label: "Captions Synced", icon: "captions" });
        appendChat("Word-level captions generated and synced.");
        showToast("AI Captions Added", "captions");
        $("#canvas-text").classList.add("active");
        acts.cap = true;
    } else if (type === "sync" && !acts.sync) {
        if (window.videoClips.length === 0) { showToast("Import a video first", "info"); return; }
        const dur = window.S.dur;
        window.aiNodes.push({ time: dur * 0.25, label: "Beat Match", icon: "zap" });
        window.aiNodes.push({ time: dur * 0.6, label: "Bass Drop", icon: "zap" });
        appendChat("Mapped cuts to beat markers.");
        showToast("Rhythm Sync Complete", "zap");
        acts.sync = true;
    } else {
        showToast("Action already applied!", "check");
        return;
    }
    window.calculateTimelineDuration();
    reRender();
};

// ─ Track Control Icons ──────────────────────────────────────────────
document.addEventListener("click", (e) => {
    const icon = e.target.closest(".track-icons svg");
    if (!icon) return;
    
    const track = icon.closest(".track");
    if (!track) return;
    
    const trackId = track.dataset.trackId;
    const iconType = icon.getAttribute("data-lucide");
    
    if (iconType === "lock") {
        icon.classList.toggle("active");
        const isLocked = icon.classList.contains("active");
        icon.setAttribute("data-lucide", isLocked ? "lock" : "unlock");
        lucide.createIcons({ nodes: [icon] });
        showToast(isLocked ? "Track locked" : "Track unlocked", isLocked ? "lock" : "unlock");
    } else if (iconType === "eye" || iconType === "eye-off") {
        icon.classList.toggle("active");
        const isVisible = !icon.classList.contains("active");
        icon.setAttribute("data-lucide", isVisible ? "eye" : "eye-off");
        lucide.createIcons({ nodes: [icon] });
        showToast(isVisible ? "Track visible" : "Track hidden", isVisible ? "eye" : "eye-off");
    } else if (iconType === "volume-2" || iconType === "volume-x") {
        icon.classList.toggle("active");
        const isMuted = icon.classList.contains("active");
        icon.setAttribute("data-lucide", isMuted ? "volume-x" : "volume-2");
        lucide.createIcons({ nodes: [icon] });
        showToast(isMuted ? "Track muted" : "Track unmuted", isMuted ? "volume-x" : "volume-2");
    }
});

// ── Initialization Trigger ─────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
    window.renderMedia("footage");
    window.calculateTimelineDuration();
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
    window.resizeCanvas();
    lucide.createIcons();
});