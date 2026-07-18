import { S, $ } from './state';

declare global {
  interface Window {
    lucide: any;
    showToast: (msg: string, iconStr: string) => void;
    triggerSparkle: (el: HTMLElement) => void;
    resizeCanvas: () => void;
  }
}

export const picUrl = (id: number | string, w: number, h: number) =>
  `https://picsum.photos/id/${id}/${w}/${h}`;

// ── Toast ──────────────────────────────────────────────────────────────
export function showToast(msg: string, iconStr: string) {
  const box = $('#toast-box');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<i data-lucide="${iconStr}"></i> <span>${msg}</span>`;
  box.appendChild(t);
  window.lucide.createIcons({ nodes: [t] });
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
