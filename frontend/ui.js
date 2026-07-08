"use strict";

lucide.createIcons();

window.S = {
    time: 0,
    dur: 24,
    playing: false,
    rafId: null,
    lastTs: null,
    zoom: 1,
    tool: "select",
    selectedAR: "16/9",
};

window.mediaPool = {
    footage: [
        { id: "m1", name: "Ocean_Sunrise.mp4", picId: 29 },
        { id: "m2", name: "Mountain_Peak.mp4", picId: 42 },
        { id: "m3", name: "City_Lights.mp4", picId: 26 },
        { id: "m4", name: "Forest_Path.mp4", picId: 47 },
    ],
    audio: [
        { id: "a1", name: "Amapiano_LogDrum_Drop.mp3", dur: "3:42" },
        { id: "a2", name: "Ambient_LoFi.wav", dur: "2:15" },
    ],
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

window.videoClips = [
    { id: "vc1", name: "Ocean_Sunrise.mp4", start: 0.0, end: 6.2, picId: 29 },
    { id: "vc2", name: "Mountain_Peak.mp4", start: 6.2, end: 14.7, picId: 42 },
    { id: "vc3", name: "City_Lights.mp4", start: 14.7, end: 19.7, picId: 26 },
    { id: "vc4", name: "Forest_Path.mp4", start: 19.7, end: 24.0, picId: 47 },
];

window.audioClips = [
    { id: "ac1", name: "Amapiano_LogDrum_Drop.mp3", start: 0, end: 24.0 },
];

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
        acMenu.innerHTML =
            '<div class="ac-section">Clips</div>' +
            '<div class="ac-item" onclick="insertAC(\'@Ocean_Sunrise \')"><i data-lucide="film"></i> @Ocean_Sunrise</div>' +
            '<div class="ac-item" onclick="insertAC(\'@City_Lights \')"><i data-lucide="film"></i> @City_Lights</div>' +
            '<div class="ac-item" onclick="insertAC(\'@Cyber_Grid_Beat \')"><i data-lucide="music"></i> @Cyber_Grid_Beat</div>';
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
        data.forEach((item) => {
            const el = document.createElement("div");
            el.className = "media-item";
            // ── NEW: Handle real imported items vs placeholder items ──
            if (item.isReal) {
                el.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(13,148,136,0.15),rgba(13,148,136,0.05));"><i data-lucide="film" style="width:28px;height:28px;color:var(--accent-primary);"></i></div><div class="media-label">${item.name}</div>`;
            } else {
                el.innerHTML = `<img src="${picUrl(item.picId, 320, 200)}" crossorigin="anonymous"><div class="media-label">${item.name}</div>`;
            }
            el.draggable = !item.isReal; // Don't allow re-dragging the real clip
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
    return $("#lane-v1").getBoundingClientRect().width * window.S.zoom;
}

window.renderRuler = function () {
    const r = $("#tl-ruler");
    r.querySelectorAll(".ruler-tick").forEach((t) => t.remove());
    const tw = getLaneW();
    const dur = window.S.dur;
    if (dur <= 0) return;
    // ── NEW: Adaptive tick interval based on duration ──
    let interval;
    if (dur <= 10) interval = 0.5;
    else if (dur <= 30) interval = window.S.zoom > 1.5 ? 1 : 2;
    else if (dur <= 120) interval = window.S.zoom > 1.5 ? 2 : 5;
    else interval = window.S.zoom > 1.5 ? 5 : 10;

    for (let s = 0; s <= dur; s += interval) {
        const tick = document.createElement("div");
        tick.className = "ruler-tick";
        tick.style.left = (s / dur) * tw + "px";
        // ── NEW: Better time formatting for ruler labels ──
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
            if (t > clip.start + 0.5 && t < clip.end - 0.5) {
                const i = clipArray.findIndex((c) => c.id === clip.id);
                const c1 = { ...clip, id: "c" + Date.now(), end: t };
                const c2 = { ...clip, id: "c" + (Date.now() + 1), start: t };
                clipArray.splice(i, 1, c1, c2);
                showToast("Clip Split", "scissors");
                window.renderClips();
            }
        } else if (window.S.tool === "select") {
            $$(".tl-clip").forEach((c) => c.classList.remove("active"));
            el.classList.add("active");
            let startX = e.clientX,
                initialStart = clip.start;
            const move = (e2) => {
                const dx = e2.clientX - startX;
                const dt = (dx / tw) * window.S.dur;
                let newStart = Math.max(
                    0,
                    Math.min(initialStart + dt, window.S.dur - (clip.end - clip.start)),
                );
                clip.end = newStart + (clip.end - clip.start);
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
}

window.renderClips = function () {
    const laneV1 = $("#lane-v1");
    const laneA1 = $("#lane-a1");
    laneV1.innerHTML = laneA1.innerHTML = "";
    const tw = getLaneW();
    const dur = window.S.dur;
    if (dur <= 0) return;

    window.videoClips.forEach((clip) => {
        const el = document.createElement("div");
        el.className = "tl-clip";
        const left = (clip.start / dur) * tw;
        const w = ((clip.end - clip.start) / dur) * tw;
        el.style.left = left + "px";
        el.style.width = w + "px";

        // ── NEW: Real clips get canvas-captured thumbnails ──
        if (clip.isReal && clip.thumbnails && clip.thumbnails.length > 0) {
            const count = Math.max(1, Math.floor(w / 60));
            let thumbs = '<div class="tl-clip-thumbs">';
            for (let j = 0; j < count; j++) {
                // Distribute available thumbnails evenly across the strip
                const idx = Math.min(
                    Math.floor((j / count) * clip.thumbnails.length),
                    clip.thumbnails.length - 1
                );
                thumbs += `<img src="${clip.thumbnails[idx].dataUrl}" draggable="false">`;
            }
            thumbs += "</div>";
            el.innerHTML = thumbs + `<span class="tl-clip-label">${clip.name}</span>`;
            // Slightly different styling for real clips
            el.style.background = "linear-gradient(180deg, rgba(13,148,136,0.08) 0%, rgba(0,0,0,0.4) 100%)";
        } else if (clip.isReal) {
            // No thumbnails yet — show gradient placeholder with file icon
            el.style.background = "linear-gradient(135deg, rgba(13,148,136,0.12), rgba(6,6,8,0.8))";
            el.innerHTML = `<span class="tl-clip-label" style="display:flex;align-items:center;gap:6px;"><i data-lucide="film" style="width:12px;height:12px;"></i> ${clip.name}</span>`;
        } else {
            // Original placeholder clip logic with picsum
            const count = Math.max(1, Math.floor(w / 60));
            let thumbs = '<div class="tl-clip-thumbs">';
            for (let j = 0; j < count; j++)
                thumbs += `<img src="${picUrl(clip.picId, 100, 60)}" crossorigin="anonymous" draggable="false">`;
            thumbs += "</div>";
            el.innerHTML = thumbs + `<span class="tl-clip-label">${clip.name}</span>`;
        }

        applyDragLogic(el, clip, window.videoClips, tw);
        laneV1.appendChild(el);
    });

    window.audioClips.forEach((clip) => {
        const el = document.createElement("div");
        el.className = "tl-clip tl-clip-audio";
        const left = (clip.start / dur) * tw;
        const w = ((clip.end - clip.start) / dur) * tw;
        el.style.left = left + "px";
        el.style.width = w + "px";
        const bars = Array.from({ length: Math.floor(w / 4) }, (_, i) => {
            const h = 10 + Math.abs(Math.sin(i * 0.1) * 20) + Math.random() * 8;
            return `<rect x="${i * 4}" y="${20 - h / 2}" width="2.5" height="${Math.min(h, 38)}" fill="currentColor" opacity="0.8" rx="1"/>`;
        }).join("");
        el.innerHTML = `<div class="waveform"><svg viewBox="0 0 ${w} 40" preserveAspectRatio="none" style="width:100%;height:100%;display:block;">${bars}</svg></div><span class="tl-clip-label" style="position:absolute;bottom:6px;left:8px;">${clip.name}</span>`;
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

$("#lane-v1").ondragover = (e) => e.preventDefault();
$("#lane-v1").ondrop = (e) => {
    e.preventDefault();
    const data = JSON.parse(e.dataTransfer.getData("text/plain"));
    const tw = getLaneW();
    const rect = $("#lane-v1").getBoundingClientRect();
    const t =
        ((e.clientX - rect.left + $("#tl-tracks").scrollLeft) / tw) * window.S.dur;
    data.start = t;
    data.end = Math.min(t + 4.0, window.S.dur);
    window.videoClips.push(data);
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
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const f = Math.floor((sec % 1) * 30);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
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

// Standard UI-Fallback Play Control
// NOTE: This gets overridden by app.js when the engine is loaded.
// Kept as fallback for when no video is imported.
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
function handleTimelineScrub(e, el) {
    const rect = el.getBoundingClientRect();
    const x = Math.max(
        0,
        e.clientX - rect.left - 140 + ($("#tl-tracks") ? $("#tl-tracks").scrollLeft : 0),
    );
    const tw = getLaneW();
    const dur = window.S.dur;
    if (dur <= 0) return;
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

// ── NEW: Allow app.js to reset AI action state on new import ──
window.resetAiActions = function () {
    acts = { trim: false, cap: false, sync: false };
};

window.applyAiAction = function (type) {
    // ── NEW: Guard for single-clip real video scenario ──
    if (type === "silence" && !acts.trim) {
        if (window.videoClips.length === 1 && window.videoClips[0].isReal) {
            // Simulate trimming: shorten clip by ~8%
            const clip = window.videoClips[0];
            const originalDur = clip.end - clip.start;
            const trimmedDur = originalDur * 0.92;
            clip.end = clip.start + trimmedDur;
            window.S.dur = trimmedDur;
            window.audioClips.forEach(ac => { if (ac.isReal) ac.end = trimmedDur; });
            window.aiNodes.push({
                time: trimmedDur,
                label: "Silence Trimmed",
                icon: "scissors",
            });
            $("#insight-score").textContent = "93";
            $("#insight-bar").style.width = "93%";
            $("#insight-box").classList.add("optimized");
            appendChat("Trimmed silent segments from the video automatically.");
            showToast("AI Smart Trim Applied", "scissors");
            acts.trim = true;
        } else if (window.videoClips.length >= 4) {
            // Original placeholder clip logic
            window.videoClips[1].start = 6.0;
            window.videoClips[1].end = 14.0;
            window.videoClips[2].start = 14.0;
            window.videoClips[2].end = 18.5;
            window.videoClips[3].start = 18.5;
            window.videoClips[3].end = 22.0;
            window.S.dur = 22.0;
            window.aiNodes.push({ time: 6.0, label: "Gap Trimmed", icon: "scissors" });
            window.aiNodes.push({ time: 14.0, label: "Gap Trimmed", icon: "scissors" });
            $("#insight-score").textContent = "96";
            $("#insight-bar").style.width = "96%";
            $("#insight-box").classList.add("optimized");
            appendChat("Trimmed 3.2s of silent gaps automatically.");
            showToast("AI Smart Trim Applied", "scissors");
            acts.trim = true;
        } else {
            showToast("Not enough clips to trim", "info");
            return;
        }
    } else if (type === "captions" && !acts.cap) {
        window.aiNodes.push({ time: 2.0, label: "Captions Generated", icon: "captions" });
        window.aiNodes.push({ time: Math.min(10.0, window.S.dur * 0.5), label: "Captions Synced", icon: "captions" });
        appendChat("Word-level captions generated and synced.");
        showToast("AI Captions Added", "captions");
        $("#canvas-text").classList.add("active");
        acts.cap = true;
    } else if (type === "sync" && !acts.sync) {
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

// ── Initialization Trigger ─────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
    window.renderMedia("footage");
    window.renderRuler();
    window.renderClips();
    window.updatePlayhead();
    window.resizeCanvas();
    lucide.createIcons();
});