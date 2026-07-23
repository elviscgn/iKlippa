import { createIcons } from 'lucide';
import { S, $ } from './state';

declare global {
  interface Window {
    lucide: any;
    appMode: {
      offline: boolean;
    };
    showToast: (msg: string, iconStr: string) => void;
    triggerSparkle: (el: HTMLElement) => void;
    resizeCanvas: () => void;
    toggleOfflineMode: () => boolean;
    setOfflineMode: (offline: boolean) => boolean;
  }
}

const OFFLINE_MODE_KEY = 'iklippa.offline-mode';

function readOfflineMode(): boolean {
  try {
    return localStorage.getItem(OFFLINE_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

function syncAppMode(next: boolean): boolean {
  if (typeof window === 'undefined') return next;
  window.appMode = { offline: next };
  try {
    localStorage.setItem(OFFLINE_MODE_KEY, next ? '1' : '0');
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
  }
  window.dispatchEvent(new CustomEvent('ikl:modeChanged', { detail: { offline: next } }));
  return next;
}

export function isOfflineMode(): boolean {
  return typeof window !== 'undefined' ? !!window.appMode?.offline : false;
}

export function setOfflineMode(offline: boolean): boolean {
  return syncAppMode(offline);
}

export function toggleOfflineMode(): boolean {
  return syncAppMode(!isOfflineMode());
}

export const picUrl = (id: number | string, w: number, h: number) => {
  if (!isOfflineMode()) {
    return `https://picsum.photos/id/${id}/${w}/${h}`;
  }

  const seed = String(id).split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const hueA = seed % 360;
  const hueB = (hueA + 42) % 360;
  const safeLabel =
    String(id)
      .replace(/[^a-z0-9]+/gi, ' ')
      .trim()
      .slice(0, 12)
      .toUpperCase() || 'STOCK';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="hsl(${hueA} 58% 20%)" />
          <stop offset="100%" stop-color="hsl(${hueB} 60% 12%)" />
        </linearGradient>
        <radialGradient id="r" cx="30%" cy="20%" r="80%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.18)" />
          <stop offset="100%" stop-color="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      <rect width="${w}" height="${h}" rx="18" fill="url(#g)" />
      <rect width="${w}" height="${h}" rx="18" fill="url(#r)" opacity="0.7" />
      <path d="M0 ${h * 0.78}C${w * 0.18} ${h * 0.68} ${w * 0.28} ${h * 0.92} ${w * 0.55} ${h * 0.82}C${w * 0.72} ${h * 0.75} ${w * 0.84} ${h * 0.62} ${w} ${h * 0.67}V${h}H0Z" fill="rgba(255,255,255,0.08)" />
      <circle cx="${w * 0.8}" cy="${h * 0.24}" r="${Math.max(12, Math.min(w, h) * 0.08)}" fill="rgba(255,255,255,0.12)" />
      <text x="50%" y="52%" fill="rgba(255,255,255,0.92)" font-family="system-ui, sans-serif" font-size="${Math.max(
        12,
        Math.min(w, h) * 0.14,
      )}" font-weight="800" text-anchor="middle" dominant-baseline="middle" letter-spacing="1">${safeLabel}</text>
      <text x="50%" y="67%" fill="rgba(255,255,255,0.58)" font-family="system-ui, sans-serif" font-size="${Math.max(
        8,
        Math.min(w, h) * 0.055,
      )}" font-weight="600" text-anchor="middle" dominant-baseline="middle">LOCAL ASSET</text>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;
};

if (typeof window !== 'undefined') {
  syncAppMode(readOfflineMode());
  window.toggleOfflineMode = toggleOfflineMode;
  window.setOfflineMode = setOfflineMode;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

if (typeof window !== 'undefined') {
  window.lucide = { createIcons };
}

// ── Toast ──────────────────────────────────────────────────────────────
export function showToast(msg: string, iconStr: string) {
  const box = $('#toast-box');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast';
  const safeIcon = /^[a-z0-9-]+$/i.test(iconStr) ? iconStr : 'sparkles';
  const icon = document.createElement('i');
  icon.dataset.lucide = safeIcon;
  const text = document.createElement('span');
  text.textContent = msg;
  t.append(icon, document.createTextNode(' '), text);
  box.appendChild(t);
  window.lucide?.createIcons({ nodes: [t] });
  setTimeout(() => {
    t.classList.add('hide');
    setTimeout(() => t.remove(), 300);
  }, 3000);
}
window.showToast = showToast; // Export to global for now until fully refactored

// ── Sparkle Animation ──────────────────────────────────────────────────
function triggerSparkle(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (let i = 0; i < 8; i++) {
    const p = document.createElement('div');
    p.innerHTML =
      '<svg viewBox="0 0 24 24" fill="var(--accent-primary)" style="width:12px;height:12px;"><path d="M12 2L15 9L22 12L15 15L12 22L9 15L2 12L9 9L12 2Z"/></svg>';
    Object.assign(p.style, {
      position: 'fixed',
      left: cx - 6 + 'px',
      top: cy - 6 + 'px',
      pointerEvents: 'none',
      zIndex: '9999',
      transition: 'all 0.8s cubic-bezier(0.175,0.885,0.32,1.275)',
      opacity: '1',
      transform: 'scale(0.5)',
    });
    document.body.appendChild(p);
    setTimeout(() => {
      const angle = (i / 8) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 40 + Math.random() * 30;
      p.style.transform = `translate(${Math.cos(angle) * dist}px,${Math.sin(angle) * dist}px) scale(1) rotate(${Math.random() * 180}deg)`;
      p.style.opacity = '0';
    }, 10);
    setTimeout(() => p.remove(), 800);
  }
  showToast('Granite AI is listening...', 'sparkles');
}
window.triggerSparkle = triggerSparkle;

// ── Canvas resizing and Aspect Ratio ────────────────────────────────────
export function resizeCanvas() {
  const wrapper = $('#canvas-wrapper');
  const frame = $('#canvas-frame');
  if (!wrapper || !frame) return;
  const [wStr, hStr] = S.selectedAR.split('/');
  const targetRatio = parseFloat(wStr!) / parseFloat(hStr!);
  const wrapperRatio = wrapper.clientWidth / wrapper.clientHeight;
  if (wrapperRatio > targetRatio) {
    frame.style.height = '100%';
    frame.style.width = 'auto';
  } else {
    frame.style.width = '100%';
    frame.style.height = 'auto';
  }
}
window.resizeCanvas = resizeCanvas;
window.addEventListener('resize', resizeCanvas);
