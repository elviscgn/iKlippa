import { $, $$, mediaPool } from './state';
import { showToast, picUrl } from './utils';

declare global {
  interface Window {
    renderMedia: (type: 'footage' | 'audio' | 'stock', subType?: 'video' | 'image' | 'music' | null) => void;
  }
}

// ── Media Rendering Logic ──────────────────────────────────────────────
export function renderMedia(
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
      el.innerHTML = `<div class="audio-icon"><i data-lucide="music"></i></div><div class="audio-info"><h4>${item.name}</h4><p>${durStr}</p></div>`;
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
          e.dataTransfer?.setData(
            'text/plain',
            JSON.stringify({
              sourceId: item.id,
              name: item.name,
              isReal: true,
              dur: item.dur,
            })
          );
      } else {
        el.ondragstart = (e) =>
          e.dataTransfer?.setData(
            'text/plain',
            JSON.stringify({
              id: 'vc_' + Date.now(),
              name: item.name,
              picId: item.picId || 0,
              start: 0,
              end: 4.0,
            })
          );
      }
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
      el.onclick = () => {
        $$('.media-item').forEach((m) => m.classList.remove('selected'));
        el.classList.add('selected');
      };
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
