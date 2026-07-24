import { $, $$, mediaPool } from './state';
import { escapeHtml, showToast, picUrl } from './utils';

export const MEDIA_DRAG_MIME = 'application/x-iklippa-media';
export const MEDIA_DRAG_KIND_MIME = {
  video: 'application/x-iklippa-video',
  audio: 'application/x-iklippa-audio',
} as const;

export type MediaDragKind = keyof typeof MEDIA_DRAG_KIND_MIME;

export interface MediaDragPayload {
  app: 'iklippa';
  kind: MediaDragKind;
  sourceId: string;
  name: string;
  durationSec: number;
  isReal: boolean;
  picId?: number;
}

declare global {
  interface Window {
    renderMedia: (type: 'footage' | 'audio' | 'stock', subType?: 'video' | 'image' | 'music' | null) => void;
  }
}

export function parseMediaDuration(value: unknown, fallbackSec = 4): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return fallbackSec;

  const trimmed = value.trim();
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map(Number);
    if (parts.every(Number.isFinite)) {
      const seconds = parts.reduce((total, part) => total * 60 + part, 0);
      if (seconds > 0) return seconds;
    }
  }

  const seconds = parseFloat(trimmed);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSec;
}

function createDragPayload(item: any, kind: MediaDragKind): MediaDragPayload {
  const isReal = Boolean(item.isReal);
  return {
    app: 'iklippa',
    kind,
    sourceId: isReal ? item.id : `stock_${item.id}`,
    name: item.name,
    durationSec: parseMediaDuration(item.dur, 4),
    isReal,
    ...(item.picId ? { picId: item.picId } : {}),
  };
}

function setDragData(event: DragEvent, payload: MediaDragPayload) {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'copy';
  const serialized = JSON.stringify(payload);
  event.dataTransfer.setData(MEDIA_DRAG_MIME, serialized);
  event.dataTransfer.setData(MEDIA_DRAG_KIND_MIME[payload.kind], payload.kind);
  event.dataTransfer.setData('text/plain', serialized);
}

function insertAtPlayhead(payload: MediaDragPayload) {
  const IKState = (window as any).IKState;
  const S = (window as any).S;
  if (!IKState || !S) return;

  let track =
    payload.kind === 'audio' ? IKState.getAudioTrack?.() : IKState.getVideoTrack?.();
  if (!track) track = IKState.addTrack?.(payload.kind);
  if (!track) {
    showToast(`Add an ${payload.kind} track first`, 'alert-circle');
    return;
  }

  const playheadUs = Math.round((S.time || 0) * 1_000_000);
  const endUs = playheadUs + Math.round(payload.durationSec * 1_000_000);
  (window as any).saveSnapshot?.();
  const clip = IKState.addClip(
    track.id,
    payload.sourceId,
    playheadUs,
    endUs,
    {
      name: payload.name,
      isReal: payload.isReal,
      picId: payload.picId || 0,
    },
  );
  if (!clip) return;

  showToast(
    `${payload.kind === 'audio' ? 'Music' : 'Clip'} added at playhead`,
    payload.kind === 'audio' ? 'music' : 'film',
  );
  window.dispatchEvent(
    new CustomEvent('ikl:reRender', { detail: { activeClipId: clip.id } }),
  );
}

function makeDraggable(el: HTMLElement, item: any, kind: MediaDragKind) {
  const payload = createDragPayload(item, kind);
  el.draggable = true;
  el.dataset.mediaKind = kind;
  el.title = `Drag to an ${kind} track, or double-click to add at the playhead`;
  el.ondragstart = (event) => {
    el.classList.add('dragging');
    setDragData(event, payload);
  };
  el.ondragend = () => {
    el.classList.remove('dragging');
    document
      .querySelectorAll('.track-lane.drop-valid, .track-lane.drop-invalid')
      .forEach((lane) => lane.classList.remove('drop-valid', 'drop-invalid'));
  };
  el.ondblclick = () => insertAtPlayhead(payload);
}

function selectMediaItem(el: HTMLElement) {
  $$('.media-item, .audio-item').forEach((item) => item.classList.remove('selected'));
  el.classList.add('selected');
}

// ── Media Rendering Logic ──────────────────────────────────────────────
// fallow-ignore-next-line complexity
export async function renderMedia(
  type: 'footage' | 'audio' | 'stock',
  subType: 'video' | 'image' | 'music' | null = null
) {
  const grid = $('#media-grid');
  const list = $('#media-list');
  if (!grid || !list) return;

  grid.innerHTML = '';
  list.innerHTML = '';

  let data: any[] = [];
  if (type === 'footage' || type === 'audio') {
    data = mediaPool[type];
    const subtabs = $('#stock-subtabs');
    if (subtabs) subtabs.style.display = 'none';
  } else if (type === 'stock') {
    const subtabs = $('#stock-subtabs');
    if (subtabs) subtabs.style.display = 'flex';
    data = mediaPool.stock[subType || 'video'];
  }

  if (type === 'audio' || (type === 'stock' && subType === 'music')) {
    grid.style.display = 'none';
    list.style.display = 'flex';
    data.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'audio-item';
      const durStr = item.dur || '?';
      const safeName = escapeHtml(item.name);
      const safeDur = escapeHtml(durStr);
      el.innerHTML = `<div class="audio-icon"><i data-lucide="music"></i></div><div class="audio-info"><h4>${safeName}</h4><p>${safeDur}</p></div><span class="media-drag-cue" aria-hidden="true"><i data-lucide="grip-vertical"></i></span>`;
      makeDraggable(el, item, 'audio');
      el.onclick = () => selectMediaItem(el);
      list.appendChild(el);
    });
  } else {
    grid.style.display = 'grid';
    list.style.display = 'none';
    if (data.length === 0 && type === 'footage') {
      grid.innerHTML =
        '<div style="grid-column:1/-1;text-align:center;padding:32px 16px;color:var(--text-muted);font-size:12px;"><i data-lucide="upload" style="width:28px;height:28px;display:block;margin:0 auto 12px;opacity:0.4;"></i>Drop a video file onto the canvas to begin</div>';
      window.lucide.createIcons({ nodes: [grid] });
      return;
    }
    data.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'media-item';
      const safeName = escapeHtml(item.name);
      if (item.isReal) {
        if (item.thumbDataUrl) {
          el.innerHTML = `<img src="${item.thumbDataUrl}" style="width:100%;height:100%;object-fit:cover;" draggable="false"><div class="media-label">${safeName}</div>`;
        } else {
          el.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(13,148,136,0.15),rgba(13,148,136,0.05));"><i data-lucide="film" style="width:32px;height:32px;color:var(--accent-primary);"></i></div><div class="media-label">${safeName}</div>`;
        }
      } else {
        el.innerHTML = `<img src="${picUrl(item.picId, 320, 200)}" crossorigin="anonymous"><div class="media-label">${safeName}</div>`;
      }
      el.insertAdjacentHTML(
        'beforeend',
        '<span class="media-drag-cue" aria-hidden="true"><i data-lucide="grip-vertical"></i></span>',
      );
      makeDraggable(el, item, 'video');

      const delBtn = document.createElement('button');
      delBtn.className = 'media-del-btn';
      delBtn.innerHTML = '<i data-lucide="x"></i>';
      delBtn.onclick = (e) => {
        e.stopPropagation();
        const pool = type === 'footage' ? mediaPool[type] : mediaPool.stock[subType || 'video'];
        const idx = pool.indexOf(item);
        if (idx !== -1) pool.splice(idx, 1);
        renderMedia(type, subType);
      };
      el.appendChild(delBtn);
      el.onclick = () => selectMediaItem(el);
      grid.appendChild(el);
    });
  }
  window.lucide.createIcons();
}

window.renderMedia = renderMedia;

export function initMediaPoolTabs() {
  $$('.media-tab').forEach((tab) => {
    (tab as HTMLElement).onclick = () => {
      $$('.media-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const type = (tab as HTMLElement).dataset.tab as 'footage' | 'audio' | 'stock';
      if (type === 'stock') {
        $$('.stock-subtab').forEach((s) => s.classList.remove('active'));
        const firstSub = $$('.stock-subtab')[0];
        if (firstSub) firstSub.classList.add('active');
        renderMedia('stock', 'video');
      } else {
        renderMedia(type);
      }
    };
  });

  $$('.stock-subtab').forEach((tab) => {
    (tab as HTMLElement).onclick = () => {
      $$('.stock-subtab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      renderMedia('stock', (tab as HTMLElement).dataset.sub as 'video' | 'image' | 'music');
    };
  });
}
