"use strict";

lucide.createIcons();

window.S = {
    time: 0,
    dur: 10,          // FIX #5: sensible default, not 24
    playing: false,
    rafId: null,
    lastTs: null,
    zoom: 1,
    tool: "select",
    selectedAR: "16/9",
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
                el.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(13,148,136,0.15),rgba(13,148,136,0.05));"><i data-lucide="film" style="width:32px;height:32px;color:var(--accent-primary);"></i></div><div class="media-label">${item.name}</div>`;
            } else {
                el.innerHTML = `<img src="${picUrl(item.picId, 320, 200)}" crossorigin="anonymous"><div class="media-label">${item.name}</div>`;
            }
            el.draggable = !item.isReal;
            if (!item.isReal) {
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
function getLaneW() {
    const lane = $("#lane-v1");
    if (!lane) return 100;   // FIX #5: safe fallback
    return lane.getBoundingClientRect().width * window.S.zoom;
}

window.renderRuler = function () {
    const r = $("#tl-ruler");
    r.querySelectorAll(".ruler-tick").forEach((t) => t.remove());
    const tw = getLaneW();
    const dur = window.S.dur;
    if (dur <= 0) return;    // FIX #5: guard

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

function applyDragLogic(el, clip, clipArray, tw) {
    el.onmousedown = (e) => {
        if (window.S.tool === "split") {
            const rect = el.parentElement.getBoundingClientRect();
            const clickX =
                e.clientX - rect.left + el.parentElement.parentElement.scrollLeft;
            const t = (clickX / tw) * window.S.dur;
            const clipStartSec = us2s(clip.timeline_start_us);
            const clipEndSec = us2s(clip.timeline_end_us);
            if (t > clipStartSec + 0.5 && t < clipEndSec - 0.5) {
                const splitAtUs = Math.round(t * 1_000_000);
                const newId = IKState.splitClip(clip.id, splitAtUs);
                if (newId !== null) {
                    showToast("Clip Split", "scissors");
                    window.renderClips();
                }
            }
        } else if (window.S.tool === "select") {
            $$(".tl-clip").forEach((c) => c.classList.remove("active"));
            el.classList.add("active");
            let startX = e.clientX;
            let initialStartUs = clip.timeline_start_us;
            let durationUs = clip.timeline_end_us - clip.timeline_start_us;
            const move = (e2) => {
                const dx = e2.clientX - startX;
                const dtSec = (dx / tw) * window.S.dur;
                let newStartSec = Math.max(0, initialStartUs / 1_000_000 + dtSec);
                let newStartUs = Math.round(newStartSec * 1_000_000);
                
                // Use IKState.moveClip to handle linked clips
                IKState.moveClip(clip.id, newStartUs);
                
                // Extend timeline duration if clip moves past current end
                const newEndSec = us2s(clip.timeline_end_us);
                if (newEndSec > window.S.dur) {
                    window.S.dur = newEndSec;
                }
                
                window.renderClips();
                window.renderRuler();
            };
            const up = () => {
                document.removeEventListener("mousemove", move);
                document.removeEventListener("mouseup", up);
                // Commit to state on pointer-up (duration/project already
                // updated since clip is a live ref; just recompute duration).
                IKState.computeDuration();
            };
            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
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
    const endUs = Math.min(Math.round((t + 4.0) * 1_000_000), Math.round(window.S.dur * 1_000_000));
    IKState.addVideoClip("stock_" + data.id, startUs, endUs, {
        name: data.name,
        isReal: false,
        picId: data.picId || 0,
    });
    showToast("Stock Inserted", "film");
    window.renderClips();
};

$("#tl-body").addEventListener(
    "wheel",
    (e) => {
        if (e.ctrlKey || e.metaKey || !e.shiftKey) {
            e.preventDefault();
            window.S.zoom = Math.max(
                0.5,
                Math.min(4, window.S.zoom + (e.deltaY > 0 ? -0.1 : 0.1)),
            );
            $("#zoom-text").textContent = Math.round(window.S.zoom * 100) + "% Zoom";
            window.renderRuler();
            window.renderClips();
            window.updatePlayhead();
        }
    },
    { passive: false },
);

$$(".tl-tool").forEach((btn) => {
    btn.onclick = () => {
        $$(".tl-tool").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        window.S.tool = btn.dataset.tool;
    };
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
    if (dur <= 0) return;    // FIX #5
    const px = (window.S.time / dur) * tw;
    $("#ph-tracks").style.left = (80 + px) + "px";
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
// FIX #2: Ruler already has margin-left:140px, so don't subtract 140 again
function handleTimelineScrub(e, el) {
    const rect = el.getBoundingClientRect();
    const isRuler = (el.id === "tl-ruler");
    const headOffset = isRuler ? 0 : 140;
    const x = Math.max(
        0,
        e.clientX - rect.left - headOffset,
    );
    const tw = getLaneW();
    const dur = window.S.dur;
    if (dur <= 0 || tw <= 0) return;
    window.S.time = Math.max(0, Math.min((x / tw) * dur, dur));
    window.updatePlayhead();
    if (window.onPlayheadScrub) window.onPlayheadScrub(window.S.time);
}

$("#tl-tracks").addEventListener("mousedown", (e) => {
    if (e.target.closest(".tl-clip") || e.target.closest(".track-head")) return;
    handleTimelineScrub(e, $("#tl-tracks"));
});
$("#tl-ruler").onmousedown = (e) => handleTimelineScrub(e, $("#tl-ruler"));

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
        if (window.videoClips.length === 1 && window.videoClips[0].isReal) {
            // Real video: simulate trim by shortening ~8%
            const clip = window.videoClips[0];
            const startUs = clip.timeline_start_us;
            const origDurUs = clip.timeline_end_us - clip.timeline_start_us;
            const trimmedDurUs = Math.round(origDurUs * 0.92);
            IKState.trimClip(clip.id, startUs, startUs + trimmedDurUs, clip.source_start_us);
            const trimmedDurSec = us2s(trimmedDurUs);
            window.S.dur = trimmedDurSec;
            // Trim audio clips to match
            window.audioClips.forEach(ac => {
                if (ac.isReal) IKState.trimClip(ac.id, ac.timeline_start_us, ac.timeline_start_us + trimmedDurUs, ac.source_start_us);
            });
            window.aiNodes.push({ time: trimmedDurSec, label: "Silence Trimmed", icon: "scissors" });
            $("#insight-score").textContent = "93";
            $("#insight-bar").style.width = "93%";
            $("#insight-box").classList.add("optimized");
            appendChat("Trimmed silent segments automatically.");
            showToast("AI Smart Trim Applied", "scissors");
            acts.trim = true;
        } else if (window.videoClips.length >= 2) {
            // Multiple clips: tighten gaps by moving clips to close gaps
            const clips = window.videoClips;
            const firstStartSec = us2s(clips[0].timeline_start_us);
            let cursorUs = clips[0].timeline_end_us;
            for (let i = 1; i < clips.length; i++) {
                const clip = clips[i];
                if (clip.timeline_start_us > cursorUs) {
                    // Use IKState.moveClip to handle linked clips
                    IKState.moveClip(clip.id, cursorUs);
                }
                cursorUs = clip.timeline_end_us;
            }
            IKState.computeDuration();
            window.S.dur = us2s(cursorUs);
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
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
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
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
    window.resizeCanvas();
    lucide.createIcons();
});