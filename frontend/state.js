"use strict";
// state.js — canonical project model (Phase 1 Task 1.2)
//
// Mirrors the Rust `Project` JSON shape from timeline_state.rs. All timestamps
// are microseconds (i64 in Rust, regular JS numbers here — safe up to ~2.5h
// which is well beyond MAX_SAFE_INTEGER at 3.6e12).
//
// Loaded as a classic script BEFORE ui.js so that ui.js can use window.IKState
// and the window.videoClips / window.audioClips getters defined here.
//
// The UI reads clips via window.videoClips / window.audioClips (defined below
// as getters that return live references to the clip arrays inside project).
// Mutations go through IKState.splitClip / moveClip / trimClip / addVideoClip
// etc. so that project stays consistent and can be synced to Rust.

window.IKState = (() => {
    let project = null;
    // Display-only metadata per clip id. NOT sent to Rust — stripped by
    // toRustJson(). Stores { name, isReal, thumbnails, picId }.
    const clipMeta = {};

    // ── µs ↔ seconds helpers ────────────────────────────────────────────
    const usToSec = (us) => us / 1_000_000;
    const secToUs = (s) => Math.round(s * 1_000_000);

    // ── Default sub-objects (must match Rust struct field order) ────────
    function defaultTransform() {
        return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, anchor_x: 0.5, anchor_y: 0.5, blend_mode: "normal" };
    }
    function defaultColour() {
        return { exposure: 0, contrast: 0, saturation: 0, temperature: 0, highlights: 0, shadows: 0, tint: 0, lift: [0, 0, 0], gamma: [0, 0, 0], gain: [0, 0, 0] };
    }
    function makeClip(id, sourceId, startUs, endUs) {
        return {
            id,
            source_id: sourceId,
            group_id: null, // Will be set when added to track
            timeline_start_us: startUs,
            timeline_end_us: endUs,
            source_start_us: 0,
            source_end_us: endUs - startUs,
            speed: 1.0,
            transform: defaultTransform(),
            colour_settings: defaultColour(),
            effects: [],
            caption_text: null,
            caption_style: null,
        };
    }

    // ── Project init ────────────────────────────────────────────────────
    function createEmptyProject(width, height) {
        return {
            id: "proj_0",
            name: "Untitled",
            width: width,
            height: height,
            frame_rate: { num: 30, den: 1 },
            colour_space: "rec709",
            tracks: [
                { id: 0, order: 0, track_type: "video", name: "Video 1", muted: false, locked: false, visible: true, volume: 1.0, pan: 0.0, clips: [] },
                { id: 1, order: 1, track_type: "audio", name: "Audio 1", muted: false, locked: false, visible: true, volume: 1.0, pan: 0.0, clips: [] },
            ],
            duration_us: 0,
            next_clip_id: 1,
            next_track_id: 2,
            next_effect_id: 1,
        };
    }

    function init(width, height) {
        project = createEmptyProject(width || 1920, height || 1080);
        for (const k of Object.keys(clipMeta)) delete clipMeta[k];
    }

    function isReady() { return project !== null; }

    // ── Track accessors ─────────────────────────────────────────────────
    function getVideoTrack() {
        if (!project) return null;
        return project.tracks.find(t => t.track_type === "video") || null;
    }
    function getAudioTrack() {
        if (!project) return null;
        return project.tracks.find(t => t.track_type === "audio") || null;
    }
    function getAllVideoClips() {
        if (!project) return [];
        return project.tracks
            .filter(t => t.track_type === "video")
            .flatMap(t => t.clips.map(c => ({ ...c, track_type: t.track_type })));
    }

    // ── Clip accessors (return live refs from project.tracks) ───────────
    // Display metadata is merged IN-PLACE onto the clip objects so the UI can
    // read clip.name / clip.isReal / clip.thumbnails directly. These fields
    // are stripped by toRustJson() before sending to Rust.
    function _mergeMeta(clip) {
        const meta = clipMeta[clip.id];
        if (meta) {
            clip.name = meta.name;
            clip.isReal = meta.isReal;
            clip.thumbnails = meta.thumbnails;
            clip.picId = meta.picId;
        }
        return clip;
    }

    function getVideoClips() {
        const track = getVideoTrack();
        if (!track) return [];
        track.clips.forEach(_mergeMeta);
        return track.clips;
    }

    function getAudioClips() {
        const track = getAudioTrack();
        if (!track) return [];
        track.clips.forEach(_mergeMeta);
        return track.clips;
    }

    // ── Clip CRUD ───────────────────────────────────────────────────────
    function addVideoClip(sourceId, startUs, endUs, meta, groupId) {
        const track = getVideoTrack();
        if (!track) return null;
        const id = project.next_clip_id++;
        const clip = makeClip(id, sourceId, startUs, endUs);
        clip.group_id = groupId || `group_${id}`;
        track.clips.push(clip);
        track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
        clipMeta[id] = meta || {};
        _mergeMeta(clip);
        computeDuration();
        return clip;
    }

    function addAudioClip(sourceId, startUs, endUs, meta, groupId) {
        const track = getAudioTrack();
        if (!track) return null;
        const id = project.next_clip_id++;
        const clip = makeClip(id, sourceId, startUs, endUs);
        clip.group_id = groupId || `group_${id}`;
        track.clips.push(clip);
        track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
        clipMeta[id] = meta || {};
        _mergeMeta(clip);
        computeDuration();
        return clip;
    }

    function findClip(clipId) {
        if (!project) return null;
        for (const track of project.tracks) {
            const clip = track.clips.find(c => c.id === clipId);
            if (clip) return clip;
        }
        return null;
    }

    function findClipTrack(clipId) {
        if (!project) return null;
        return project.tracks.find(t => t.clips.some(c => c.id === clipId)) || null;
    }

    function removeClip(clipId) {
        const track = findClipTrack(clipId);
        if (!track) return false;
        const before = track.clips.length;
        track.clips = track.clips.filter(c => c.id !== clipId);
        if (track.clips.length < before) {
            delete clipMeta[clipId];
            computeDuration();
            return true;
        }
        return false;
    }

    function splitClip(clipId, splitAtUs) {
        const track = findClipTrack(clipId);
        if (!track) return null;
        const idx = track.clips.findIndex(c => c.id === clipId);
        if (idx < 0) return null;
        const clip = track.clips[idx];
        if (splitAtUs <= clip.timeline_start_us || splitAtUs >= clip.timeline_end_us) return null;

        const leftTimelineUs = splitAtUs - clip.timeline_start_us;
        const leftSourceUs = Math.round(leftTimelineUs / clip.speed);
        const rightSourceStart = clip.source_start_us + leftSourceUs;
        const origEndUs = clip.timeline_end_us;
        const origSourceEnd = clip.source_end_us;

        // Truncate left half
        clip.timeline_end_us = splitAtUs;
        clip.source_end_us = rightSourceStart;

        // Create right half with NEW group ID (independent from left)
        const newId = project.next_clip_id++;
        const right = { ...clip, id: newId, group_id: `group_${newId}`, timeline_start_us: splitAtUs, timeline_end_us: origEndUs, source_start_us: rightSourceStart, source_end_us: origSourceEnd };
        track.clips.splice(idx + 1, 0, right);

        // Copy display meta to the new clip
        const meta = clipMeta[clipId];
        if (meta) {
            clipMeta[newId] = { ...meta, thumbnails: meta.thumbnails ? [...meta.thumbnails] : [] };
            _mergeMeta(right);
        }

        // Split linked clips too (same group_id)
        const linkedIds = getLinkedClipIds(clipId).filter(id => id !== clipId);
        for (const linkedId of linkedIds) {
            splitClip(linkedId, splitAtUs);
        }

        computeDuration();
        return newId;
    }

    function moveClip(clipId, newStartUs) {
        const clip = findClip(clipId);
        if (!clip) return false;
        const dur = clip.timeline_end_us - clip.timeline_start_us;
        const deltaUs = newStartUs - clip.timeline_start_us;
        
        clip.timeline_start_us = newStartUs;
        clip.timeline_end_us = newStartUs + dur;
        const track = findClipTrack(clipId);
        if (track) track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
        
        // Move linked clips too
        const linkedIds = getLinkedClipIds(clipId).filter(id => id !== clipId);
        for (const linkedId of linkedIds) {
            const linkedClip = findClip(linkedId);
            if (linkedClip) {
                linkedClip.timeline_start_us += deltaUs;
                linkedClip.timeline_end_us += deltaUs;
                const linkedTrack = findClipTrack(linkedId);
                if (linkedTrack) linkedTrack.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
            }
        }
        
        computeDuration();
        return true;
    }

    function trimClip(clipId, newStartUs, newEndUs, newSourceStartUs) {
        const clip = findClip(clipId);
        if (!clip) return false;
        if (newEndUs <= newStartUs) return false;
        
        const origStartUs = clip.timeline_start_us;
        const origEndUs = clip.timeline_end_us;
        const deltaStartUs = newStartUs - origStartUs;
        const deltaEndUs = newEndUs - origEndUs;
        
        clip.timeline_start_us = newStartUs;
        clip.timeline_end_us = newEndUs;
        clip.source_start_us = newSourceStartUs;
        const timelineUs = newEndUs - newStartUs;
        clip.source_end_us = newSourceStartUs + Math.round(timelineUs / clip.speed);
        const track = findClipTrack(clipId);
        if (track) track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
        
        // Trim linked clips too
        const linkedIds = getLinkedClipIds(clipId).filter(id => id !== clipId);
        for (const linkedId of linkedIds) {
            const linkedClip = findClip(linkedId);
            if (linkedClip) {
                const linkedNewStart = linkedClip.timeline_start_us + deltaStartUs;
                const linkedNewEnd = linkedClip.timeline_end_us + deltaEndUs;
                const linkedNewSourceStart = linkedClip.source_start_us + Math.round(deltaStartUs / linkedClip.speed);
                trimClip(linkedId, linkedNewStart, linkedNewEnd, linkedNewSourceStart);
            }
        }
        
        computeDuration();
        return true;
    }

    function getLinkedClipIds(clipId) {
        const clip = findClip(clipId);
        if (!clip || !clip.group_id) return [];
        const groupId = clip.group_id;
        const linkedIds = [];
        
        for (const track of project.tracks) {
            for (const c of track.clips) {
                if (c.group_id === groupId && c.id !== clipId) {
                    linkedIds.push(c.id);
                }
            }
        }
        
        return linkedIds;
    }

    function setClipMeta(clipId, metaPatch) {
        const existing = clipMeta[clipId] || {};
        Object.assign(existing, metaPatch);
        clipMeta[clipId] = existing;
        const clip = findClip(clipId);
        if (clip) _mergeMeta(clip);
    }
    function getClipMeta(clipId) {
        return clipMeta[clipId] ? JSON.parse(JSON.stringify(clipMeta[clipId])) : null;
    }

    function computeDuration() {
        if (!project) return 0;
        let max = 0;
        for (const track of project.tracks) {
            for (const clip of track.clips) {
                if (clip.timeline_end_us > max) max = clip.timeline_end_us;
            }
        }
        project.duration_us = max;
        return max;
    }

    function getDurationSec() {
        return project ? usToSec(project.duration_us) : 0;
    }

    function getProject() { return project; }

    // ── Undo/redo state snapshots ─────────────────────────────────────────
    function saveState() {
        return {
            project: JSON.parse(JSON.stringify(project)),
            clipMeta: JSON.parse(JSON.stringify(clipMeta)),
        };
    }
    function loadState(state) {
        project = state.project;
        Object.keys(clipMeta).forEach(k => delete clipMeta[k]);
        Object.assign(clipMeta, state.clipMeta);
    }

    // ── Rust sync helpers ───────────────────────────────────────────────
    // Strip display metadata and serialise to JSON for Rust. The output must
    // match the Rust Project struct shape exactly so that set_timeline →
    // to_json round-trips identical.
    function toRustJson() {
        if (!project) return "{}";
        const clean = JSON.parse(JSON.stringify(project));
        for (const track of clean.tracks) {
            for (const clip of track.clips) {
                delete clip.name;
                delete clip.isReal;
                delete clip.thumbnails;
                delete clip.picId;
            }
        }
        return JSON.stringify(clean);
    }

    function loadFromRustJson(json) {
        project = JSON.parse(json);
        // clipMeta is NOT restored from Rust JSON — that's Task 5's job.
    }

    // ── Deep equality (for round-trip verification) ─────────────────────
    function deepEqual(a, b) {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (a === null || b === null || typeof a !== "object") return false;
        const ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (const k of ka) {
            if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
            if (!deepEqual(a[k], b[k])) return false;
        }
        return true;
    }

    function verifyRoundTrip(rustJson, receivedJson) {
        try {
            return deepEqual(JSON.parse(rustJson), JSON.parse(receivedJson));
        } catch {
            return false;
        }
    }

    // ── Public API ──────────────────────────────────────────────────────
    return {
        init, isReady,
        usToSec, secToUs,
        getVideoClips, getAudioClips,
        addVideoClip, addAudioClip,
        findClip, findClipTrack, removeClip, splitClip, moveClip, trimClip,
        setClipMeta, getClipMeta,
        computeDuration, getDurationSec,
        toRustJson, loadFromRustJson, verifyRoundTrip,
        getProject, getLinkedClipIds,
        saveState, loadState,
    };
})();

// ── window.videoClips / window.audioClips as live getters ────────────────
// These return references to the actual clip arrays inside IKState.project,
// so reads (length, forEach, map, indexing) work transparently. Direct
// mutations (push, splice) should go through IKState functions instead.
Object.defineProperty(window, "videoClips", {
    get: () => window.IKState.getVideoClips(),
    configurable: true,
});
Object.defineProperty(window, "audioClips", {
    get: () => window.IKState.getAudioClips(),
    configurable: true,
});
