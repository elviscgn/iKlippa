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

window.videoClips = [];
window.audioClips = [];
window.aiNodes = [];

const picUrl = (id, w, h) => `https://picsum.photos/id/${id}/${w}/${h}`;
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

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

$("#t-text").onclick = () => {
    isTextActive = !isTextActive;
    $("#t-text").classList.toggle("active");
    $("#canvas-text").classList.toggle("active");
    showToast(
        isTextActive ? "Text Overlay Enabled" : "Text Overlay Disabled",
        "type",
    );
};

// Color grade panel toggle (replaces old CSS filter toggle)
$("#t-effects").onclick = () => {
    const panel = document.getElementById("grade-panel");
    if (panel.style.display === "none" || !panel.style.display) {
        panel.style.display = "block";
        lucide.createIcons({ nodes: [panel] });
    } else {
        panel.style.display = "none";
    }
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
            grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px 16px;color:var(--text-muted);font-size:11px;"><i data-lucide="upload" style="width:24px;height:24px;display:block;margin:0 auto 8px;opacity:0.4;"></i>Drop a video file onto the canvas to begin</div>';
            lucide.createIcons({ nodes: [grid] });
            return;
        }
        data.forEach((item) => {
            const el = document.createElement("div");
            el.className = "media-item";
            if (item.isReal) {
                el.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(13,148,136,0.15),rgba(13,148,136,0.05));"><i data-lucide="film" style="width:28px;height:28px;color:var(--accent-primary);"></i></div><div class="media-label">${item.name}</div>`;
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
                            picId: item.picId,
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
    if (!lane) return 100;
    return lane.getBoundingClientRect().width * window.S.zoom;
}

window.renderRuler = function () {
    const r = $("#tl-ruler");
    r.querySelectorAll(".ruler-tick").forEach((t) => t.remove());
    const tw = getLaneW();
    const dur = window.S.dur;
    if (dur <= 0) return;

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

// ── Clip Drag Logic (with trim handles) ──────────────────────────────────
const TRIM_ZONE = 8;

function applyDragLogic(el, clip, clipArray, tw) {
    el.onmousedown = (e) => {
        e.stopPropagation();
        const rect = el.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        const elWidth = rect.width;

        const isTrimStart = relX < TRIM_ZONE;
        const isTrimEnd = relX > elWidth - TRIM_ZONE;

        // Highlight the clip
        $$(".tl-clip").forEach(c => c.classList.remove("active"));
        el.classList.add("active");

        if (window.S.tool === "split") {
            const clickT = (e.clientX - el.parentElement.getBoundingClientRect().left) / tw * window.S.dur;
            if (clickT > clip.start + 0.1 && clickT < clip.end - 0.1) {
                performSplit(clip, clickT, clipArray);
            }
            return;
        }

        const initialStart = clip.start;
        const initialEnd = clip.end;
        const initialSourceOffset = clip.sourceOffset || 0;

        if (isTrimStart || isTrimEnd) {
            // TRIM DRAG
            let lastRender = 0;

            const move = (e2) => {
                const dx = e2.clientX - e.clientX;
                const dt = (dx / tw) * window.S.dur;

                if (isTrimStart) {
                    const newStart = Math.max(0, Math.min(initialStart + dt, initialEnd - 0.2));
                    const trimDelta = newStart - initialStart;
                    clip.start = newStart;
                    clip.sourceOffset = initialSourceOffset + trimDelta;
                } else {
                    const newEnd = Math.max(initialStart + 0.2, Math.min(initialEnd + dt, window.S.dur + 5));
                    clip.end = newEnd;
                }

                const now = Date.now();
                if (now - lastRender > 33) {
                    window.renderClips();
                    lastRender = now;
                }
            };

            const up = () => {
                document.removeEventListener("mousemove", move);
                document.removeEventListener("mouseup", up);

                // Commit trim to engine
                if (clip.isReal && clip.rustClipId) {
                    trimClip({
                        track: 0,
                        clipId: clip.rustClipId,
                        newStartMs: Math.round(clip.start * 1000),
                        newEndMs: Math.round(clip.end * 1000),
                        newSourceOffsetMs: Math.round((clip.sourceOffset || 0) * 1000),
                    });
                }

                window.S.dur = Math.max(window.S.dur, clip.end);
                window.renderRuler();
                window.renderClips();
                window.updatePlayhead();

                // Seek to show the trimmed frame
                if (window.onPlayheadScrub) {
                    window.onPlayheadScrub(isTrimStart ? clip.start : clip.end);
                }
            };

            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);

        } else {
            // MOVE DRAG
            const move = (e2) => {
                const dx = e2.clientX - e.clientX;
                const dt = (dx / tw) * window.S.dur;
                let newStart = Math.max(0, Math.min(initialStart + dt, window.S.dur - (initialEnd - initialStart)));
                clip.end = newStart + (initialEnd - initialStart);
                clip.start = newStart;
                window.renderClips();
            };

            const up = () => {
                document.removeEventListener("mousemove", move);
                document.removeEventListener("mouseup", up);
            };

            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
        }
    };

    // Visual cursor hint
    el.onmousemove = (e) => {
        const rect = el.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        if (relX < TRIM_ZONE || relX > rect.width - TRIM_ZONE) {
            el.style.cursor = 'col-resize';
        } else {
            el.style.cursor = 'grab';
        }
    };
}

// ── Split Function ──────────────────────────────────────────────────
function performSplit(clip, splitAtSec, clipArray) {
    const i = clipArray.findIndex(c => c.id === clip.id);
    if (i === -1) return;

    const sourceAtSplit = (clip.sourceOffset || 0) + (splitAtSec - clip.start);

    const c1 = {
        ...clip,
        id: 'c' + Date.now(),
        end: splitAtSec,
    };

    const c2 = {
        ...clip,
        id: 'c' + (Date.now() + 1),
        start: splitAtSec,
        sourceOffset: sourceAtSplit,
    };

    clipArray.splice(i, 1, c1, c2);
    showToast('Clip Split', 'scissors');
    window.renderClips();

    // Tell the engine about the split
    if (clip.isReal && clip.rustClipId) {
        splitClip({
            track: 0,
            clipId: clip.rustClipId,
            atMs: Math.round(splitAtSec * 1000),
        }).then(newId => {
            if (newId) {
                c2.rustClipId = newId;
                c1.rustClipId = clip.rustClipId;
            }
        });
    }
}

window.renderClips = function () {
    const laneV1 = $("#lane-v1");
    const laneA1 = $("#lane-a1");
    laneV1.innerHTML = laneA1.innerHTML = "";
    const tw = getLaneW();
    const dur = window.S.dur;
    if (dur <= 0) return;

    if (window.videoClips.length === 0) {
        laneV1.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:10px;opacity:0.5;pointer-events:none;">Drop video here</div>';
    }

    window.videoClips.forEach((clip) => {
        const el = document.createElement("div");
        el.className = "tl-clip";
        const left = (clip.start / dur) * tw;
        const w = ((clip.end - clip.start) / dur) * tw;
        el.style.left = left + "px";
        el.style.width = w + "px";

        if (clip.isReal && clip.thumbnails && clip.thumbnails.length > 0) {
            const count = Math.max(1, Math.floor(w / 60));
            let thumbs = '<div class="tl-clip-thumbs">';
            for (let j = 0; j < count; j++) {
                const idx = Math.min(
                    Math.floor((j / count) * clip.thumbnails.length),
                    clip.thumbnails.length - 1
                );
                thumbs += `<img src="${clip.thumbnails[idx].dataUrl}" draggable="false">`;
            }
            thumbs += "</div>";
            el.innerHTML = thumbs + `<span class="tl-clip-label">${clip.name}</span>`;
            el.style.background = "linear-gradient(180deg, rgba(13,148,136,0.08) 0%, rgba(0,0,0,0.4) 100%)";
        } else if (clip.isReal) {
            el.style.background = "linear-gradient(135deg, rgba(13,148,136,0.12), rgba(6,6,8,0.8))";
            el.innerHTML = `<span class="tl-clip-label" style="display:flex;align-items:center;gap:6px;"><i data-lucide="film" style="width:12px;height:12px;"></i> ${clip.name}</span>`;
        } else if (clip.picId) {
            const count = Math.max(1, Math.floor(w / 60));
            let thumbs = '<div class="tl-clip-thumbs">';
            for (let j = 0; j < count; j++)
                thumbs += `<img src="${picUrl(clip.picId, 100, 60)}" crossorigin="anonymous" draggable="false">`;
            thumbs += "</div>";
            el.innerHTML = thumbs + `<span class="tl-clip-label">${clip.name}</span>`;
        } else {
            el.style.background = "rgba(255,255,255,0.04)";
            el.innerHTML = `<span class="tl-clip-label">${clip.name}</span>`;
        }

        applyDragLogic(el, clip, window.videoClips, tw);
        laneV1.appendChild(el);
    });

    if (window.audioClips.length === 0) {
        laneA1.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:10px;opacity:0.5;pointer-events:none;">Audio track</div>';
    }

    window.audioClips.forEach((clip) => {
        const el = document.createElement("div");
        el.className = "tl-clip tl-clip-audio";
        const left = (clip.start / dur) * tw;
        const w = ((clip.end - clip.start) / dur) * tw;
        el.style.left = left + "px";
        el.style.width = w + "px";
        const bars = Array.from({ length: Math.max(1, Math.floor(w / 4)) }, (_, i) => {
            const h = seededBarHeight(i);
            return `<rect x="${i * 4}" y="${20 - h / 2}" width="2.5" height="${Math.min(h, 38)}" fill="currentColor" opacity="0.8" rx="1"/>`;
        }).join("");
        el.innerHTML = `<div class="waveform"><svg viewBox="0 0 ${Math.max(1, w)} 40" preserveAspectRatio="none" style="width:100%;height:100%;display:block;">${bars}</svg></div><span class="tl-clip-label" style="position:absolute;bottom:6px;left:8px;">${clip.name}</span>`;
        applyDragLogic(el, clip, window.audioClips, tw);
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
    lucide.createIcons({ nodes: [$("#lane-ai"), laneV1] });
};

function seededBarHeight(i) {
    let x = ((i * 2654435761) >>> 0) & 0xFF;
    return 10 + (x % 28);
}

// ── Time Formatting and Playhead Sync ───────────────────────────────
function fmtTime(sec) {
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
    $("#ph-ruler").style.left = px + "px";
    $("#ph-tracks").style.left = 140 + px + "px";
    $("#timecode").textContent = fmtTime(window.S.time);
};

// ── Keyboard Shortcuts ───────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (
        e.target.tagName === 'INPUT' ||
        e.target.tagName === 'TEXTAREA'
    ) return;

    if (e.code === 'Space') {
        e.preventDefault();
        window.togglePlay();
    }

    if (e.code === 'KeyS') {
        e.preventDefault();
        const playheadSec = window.S.time;
        for (const clip of window.videoClips) {
            if (playheadSec >= clip.start && playheadSec <= clip.end) {
                if (playheadSec > clip.start + 0.1 && playheadSec < clip.end - 0.1) {
                    performSplit(clip, playheadSec, window.videoClips);
                }
                break;
            }
        }
    }
});

// ── Scrub Seek Event Handling ──────────────────────────────────────────
let lastScrubMs = -1;
function handleTimelineScrub(e, el) {
    const rect = el.getBoundingClientRect();
    const isRuler = (el.id === "tl-ruler");
    const headOffset = isRuler ? 0 : 140;
    const x = Math.max(0, e.clientX - rect.left - headOffset);
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

// ── Timeline Zoom ──────────────────────────────────────────────────
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

// ── AI Copilot Chat Interface ──────────────────────────────────────────
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
            const clip = window.videoClips[0];
            const originalDur = clip.end - clip.start;
            const trimmedDur = originalDur * 0.92;
            clip.end = clip.start + trimmedDur;
            window.S.dur = trimmedDur;
            window.audioClips.forEach(ac => { if (ac.isReal) ac.end = trimmedDur; });
            window.aiNodes.push({ time: trimmedDur, label: "Silence Trimmed", icon: "scissors" });
            $("#insight-score").textContent = "93";
            $("#insight-bar").style.width = "93%";
            $("#insight-box").classList.add("optimized");
            appendChat("Trimmed silent segments automatically.");
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

// ── UI Fallback Play Control ──────────────────────────────────────────
// This is overridden by app.js when the engine loads.
// If the engine hasn't loaded, this provides basic timeline animation.
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

// ── Canvas Resizing ──────────────────────────────────────────────────
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

// ── AR Selector ──────────────────────────────────────────────────────
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
        lucide.createIcons({ nodes: [$("#ar-btn")] });
        showToast("Canvas set to " + opt.dataset.label, "monitor");
    };
});

// ── Initialization ─────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
    window.renderMedia("footage");
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
    window.resizeCanvas();
    lucide.createIcons();
});