import { $, $$, mediaPool } from './state';
import { escapeHtml, showToast, picUrl, isOfflineMode } from './utils';
import {
  downloadStockFile,
  searchStockMusic,
  searchStockVideos,
} from '../api/stock';
import { importFile, registerExternalAudio } from '../engine/engine';

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
  remoteUrl?: string;
  thumbnailUrl?: string;
  provider?: string;
  creator?: string;
  mimeType?: string;
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
    ...(item.remoteUrl ? { remoteUrl: item.remoteUrl } : {}),
    ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
    ...(item.provider ? { provider: item.provider } : {}),
    ...(item.creator ? { creator: item.creator } : {}),
    ...(item.mimeType ? { mimeType: item.mimeType } : {}),
  };
}

const materializedMedia = new Map<string, Promise<MediaDragPayload>>();

function downloadName(payload: MediaDragPayload): string {
  const fallbackExtension = payload.kind === 'audio' ? '.mp3' : '.mp4';
  const cleaned = payload.name
    .replace(/[^\w\s.-]+/g, '')
    .trim()
    .replace(/\s+/g, '_') || `stock_${payload.kind}`;
  return /\.[a-z0-9]{2,5}$/i.test(cleaned) ? cleaned : cleaned + fallbackExtension;
}

export async function materializeMediaPayload(
  payload: MediaDragPayload,
): Promise<MediaDragPayload> {
  if (payload.isReal || !payload.remoteUrl) return payload;

  const cached = materializedMedia.get(payload.remoteUrl);
  if (cached) return cached;

  const task = (async () => {
    showToast(`Downloading ${payload.provider || 'stock'} clip...`, 'download');
    const file = await downloadStockFile(
      payload.remoteUrl!,
      downloadName(payload),
      payload.mimeType || (payload.kind === 'audio' ? 'audio/mpeg' : 'video/mp4'),
    );
    const imported = payload.kind === 'audio'
      ? await registerExternalAudio(file, payload.sourceId)
      : await importFile(file, payload.sourceId);
    const IKState = (window as any).IKState;
    if (IKState && !IKState.isReady?.()) {
      IKState.init(imported.width || 1920, imported.height || 1080);
    }
    return {
      ...payload,
      sourceId: imported.sourceId,
      durationSec: imported.durationMs / 1000,
      isReal: true,
    };
  })();

  materializedMedia.set(payload.remoteUrl, task);
  try {
    return await task;
  } catch (error) {
    materializedMedia.delete(payload.remoteUrl);
    throw error;
  }
}

function setDragData(event: DragEvent, payload: MediaDragPayload) {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'copy';
  const serialized = JSON.stringify(payload);
  event.dataTransfer.setData(MEDIA_DRAG_MIME, serialized);
  event.dataTransfer.setData(MEDIA_DRAG_KIND_MIME[payload.kind], payload.kind);
  event.dataTransfer.setData('text/plain', serialized);
}

async function insertAtPlayhead(sourcePayload: MediaDragPayload) {
  let payload = sourcePayload;
  try {
    payload = await materializeMediaPayload(sourcePayload);
  } catch (error) {
    showToast((error as Error).message || 'Could not download stock media', 'alert-triangle');
    return;
  }
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
  el.ondblclick = () => {
    void insertAtPlayhead(payload);
  };
}

function selectMediaItem(el: HTMLElement) {
  $$('.media-item, .audio-item').forEach((item) => item.classList.remove('selected'));
  el.classList.add('selected');
}

type StockSubType = 'video' | 'music';
type SearchStatus = 'idle' | 'loading' | 'ready' | 'error';

const stockSearchState: Record<StockSubType, {
  status: SearchStatus;
  query: string;
  error: string;
}> = {
  video: { status: 'idle', query: '', error: '' },
  music: { status: 'idle', query: '', error: '' },
};

let stockSearchAbort: AbortController | null = null;
let stockSearchTimer: ReturnType<typeof setTimeout> | null = null;

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function renderMediaState(
  target: HTMLElement,
  icon: string,
  title: string,
  detail: string,
): void {
  target.innerHTML = `
    <div class="media-empty-state">
      <i data-lucide="${escapeHtml(icon)}"></i>
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail)}</span>
    </div>`;
  window.lucide.createIcons({ nodes: [target] });
}

async function runStockSearch(subType: StockSubType, rawQuery: string): Promise<void> {
  const query = rawQuery.trim() || (subType === 'music' ? 'chill' : 'nature');
  if (isOfflineMode()) {
    stockSearchState[subType] = {
      status: 'error',
      query,
      error: 'Switch to Online mode to search Pexels and Jamendo.',
    };
    await renderMedia('stock', subType);
    return;
  }

  stockSearchAbort?.abort();
  stockSearchAbort = new AbortController();
  stockSearchState[subType] = { status: 'loading', query, error: '' };
  await renderMedia('stock', subType);

  try {
    if (subType === 'video') {
      const results = await searchStockVideos(query, stockSearchAbort.signal);
      mediaPool.stock.video = results.map((item) => ({
        id: `pexels_${item.id}`,
        name: item.name,
        dur: formatDuration(item.duration),
        thumbnailUrl: item.thumbnail_url,
        remoteUrl: item.video_url,
        provider: item.provider,
        creator: item.creator,
        pageUrl: item.page_url,
        mimeType: 'video/mp4',
        width: item.width || undefined,
        height: item.height || undefined,
      }));
    } else {
      const results = await searchStockMusic(query, stockSearchAbort.signal);
      mediaPool.stock.music = results.map((item) => ({
        id: `jamendo_${item.id}`,
        name: item.name,
        dur: formatDuration(item.duration),
        thumbnailUrl: item.thumbnail_url,
        remoteUrl: item.audio_url,
        provider: item.provider,
        creator: item.creator,
        pageUrl: item.page_url,
        mimeType: 'audio/mpeg',
      }));
    }
    stockSearchState[subType] = { status: 'ready', query, error: '' };
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    stockSearchState[subType] = {
      status: 'error',
      query,
      error: (error as Error).message || 'Stock search failed.',
    };
  }
  await renderMedia('stock', subType);
}

function activeStockSubType(): StockSubType {
  const active = document.querySelector('.stock-subtab.active') as HTMLElement | null;
  return active?.dataset.sub === 'music' ? 'music' : 'video';
}

function updateSearchPlaceholder(type: string, subType?: StockSubType): void {
  const input = document.getElementById('media-search') as HTMLInputElement | null;
  if (!input) return;
  if (type === 'stock') {
    input.placeholder = subType === 'music'
      ? 'Search Jamendo music...'
      : 'Search Pexels videos...';
  } else {
    input.placeholder = type === 'audio' ? 'Filter project audio...' : 'Filter project media...';
  }
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
    if (isOfflineMode()) {
      const isMusic = subType === 'music';
      grid.style.display = isMusic ? 'none' : 'grid';
      list.style.display = isMusic ? 'flex' : 'none';
      renderMediaState(
        isMusic ? list : grid,
        'cloud-off',
        'Stock library is online',
        'Switch to Online mode to search Pexels and Jamendo.',
      );
      return;
    }
  }

  const query = type === 'stock'
    ? ''
    : ((document.getElementById('media-search') as HTMLInputElement | null)?.value || '')
      .trim()
      .toLowerCase();
  if (query) {
    data = data.filter((item) => String(item.name || '').toLowerCase().includes(query));
  }

  if (type === 'audio' || (type === 'stock' && subType === 'music')) {
    grid.style.display = 'none';
    list.style.display = 'flex';
    if (type === 'stock') {
      const state = stockSearchState.music;
      if (state.status === 'loading') {
        renderMediaState(list, 'loader-circle', 'Searching Jamendo', `Finding "${state.query}" tracks...`);
        return;
      }
      if (state.status === 'error') {
        renderMediaState(list, 'wifi-off', 'Music search unavailable', state.error);
        return;
      }
      if (state.status === 'ready' && data.length === 0) {
        renderMediaState(list, 'music', 'No tracks found', 'Try a broader mood or genre.');
        return;
      }
    }
    data.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'audio-item';
      const durStr = item.dur || '?';
      const safeName = escapeHtml(item.name);
      const safeDur = escapeHtml(durStr);
      const byline = item.creator
        ? `${escapeHtml(item.provider)} · ${escapeHtml(item.creator)}`
        : escapeHtml(item.provider || safeDur);
      el.innerHTML = `<div class="audio-icon"><i data-lucide="music"></i></div><div class="audio-info"><h4>${safeName}</h4><p>${safeDur}${item.provider ? ` · ${byline}` : ''}</p></div><span class="media-drag-cue" aria-hidden="true"><i data-lucide="grip-vertical"></i></span>`;
      makeDraggable(el, item, 'audio');
      el.onclick = () => selectMediaItem(el);
      list.appendChild(el);
    });
  } else {
    grid.style.display = 'grid';
    list.style.display = 'none';
    if (type === 'stock') {
      const state = stockSearchState.video;
      if (state.status === 'loading') {
        renderMediaState(grid, 'loader-circle', 'Searching Pexels', `Finding "${state.query}" clips...`);
        return;
      }
      if (state.status === 'error') {
        renderMediaState(grid, 'wifi-off', 'Video search unavailable', state.error);
        return;
      }
      if (state.status === 'ready' && data.length === 0) {
        renderMediaState(grid, 'film', 'No videos found', 'Try a broader subject or location.');
        return;
      }
    }
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
      } else if (item.thumbnailUrl) {
        el.innerHTML = `<img src="${escapeHtml(item.thumbnailUrl)}" crossorigin="anonymous" draggable="false"><div class="media-label">${safeName}<small>${escapeHtml(item.provider || '')}${item.creator ? ` · ${escapeHtml(item.creator)}` : ''}</small></div>`;
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
  const searchInput = document.getElementById('media-search') as HTMLInputElement | null;
  const searchActiveStock = () => {
    const activeTab = document.querySelector('.media-tab.active') as HTMLElement | null;
    if (activeTab?.dataset.tab !== 'stock') return;
    const subType = activeStockSubType();
    void runStockSearch(subType, searchInput?.value || (subType === 'music' ? 'chill' : 'nature'));
  };

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (stockSearchTimer) clearTimeout(stockSearchTimer);
      const activeTab = document.querySelector('.media-tab.active') as HTMLElement | null;
      if (activeTab?.dataset.tab === 'stock') {
        stockSearchTimer = setTimeout(searchActiveStock, 450);
      } else if (activeTab?.dataset.tab) {
        void renderMedia(activeTab.dataset.tab as 'footage' | 'audio');
      }
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (stockSearchTimer) clearTimeout(stockSearchTimer);
      searchActiveStock();
    });
  }

  $$('.media-tab').forEach((tab) => {
    (tab as HTMLElement).onclick = () => {
      $$('.media-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const type = (tab as HTMLElement).dataset.tab as 'footage' | 'audio' | 'stock';
      if (type === 'stock') {
        $$('.stock-subtab').forEach((s) => s.classList.remove('active'));
        const firstSub = $$('.stock-subtab')[0];
        if (firstSub) firstSub.classList.add('active');
        updateSearchPlaceholder('stock', 'video');
        renderMedia('stock', 'video');
        if (searchInput && stockSearchState.video.status === 'idle') {
          if (!searchInput.value.trim()) searchInput.value = 'nature';
          void runStockSearch('video', searchInput.value);
        }
      } else {
        updateSearchPlaceholder(type);
        renderMedia(type);
      }
    };
  });

  $$('.stock-subtab').forEach((tab) => {
    (tab as HTMLElement).onclick = () => {
      $$('.stock-subtab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const subType = (tab as HTMLElement).dataset.sub === 'music' ? 'music' : 'video';
      updateSearchPlaceholder('stock', subType);
      renderMedia('stock', subType);
      if (searchInput && stockSearchState[subType].status === 'idle') {
        if (!searchInput.value.trim()) {
          searchInput.value = subType === 'music' ? 'chill' : 'nature';
        }
        void runStockSearch(subType, searchInput.value);
      }
    };
  });
}
