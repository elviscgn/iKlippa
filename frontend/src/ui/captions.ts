import type { CaptionStyle } from '../state/types';

let overlay: HTMLCanvasElement | null = null;
let octx: CanvasRenderingContext2D | null = null;

export function addCaptionAtPlayhead(): void {
  const IK = (window as any).IKState;
  if (!IK || !IK.isReady()) return;

  // Find or create a caption track
  let captionTrack = (IK.getTracks() || []).find((t: any) => t.track_type === 'caption');
  if (!captionTrack) {
    const newId = IK.addTrack('caption');
    captionTrack = IK.getTrackById(newId);
  }
  if (!captionTrack) return;

  const playheadUs = Math.round((window.S?.time ?? 0) * 1_000_000);
  const clipDurationUs = 3_000_000; // 3 seconds
  const clip = IK.addClip(
    captionTrack.id,
    `caption-${Date.now()}`,
    playheadUs,
    playheadUs + clipDurationUs,
    { name: 'New caption', isReal: false },
  );

  if (clip) {
    clip.caption_text = 'New caption';
    clip.caption_style = {
      font_family: 'Plus Jakarta Sans, sans-serif',
      size: 0,
      colour: [255, 255, 255, 255],
      bg_opacity: 0.3,
      position: 'lowerthird',
    };
  }

  window.dispatchEvent(new CustomEvent('ikl:reRender'));
}

export function initCaptionOverlay(): HTMLCanvasElement | null {
  if (overlay) return overlay;
  const canvas = document.getElementById('caption-overlay') as HTMLCanvasElement | null;
  if (!canvas) return null;
  overlay = canvas;
  octx = canvas.getContext('2d', { alpha: true });
  return canvas;
}

export function syncCaptionCanvas(videoW: number, videoH: number): void {
  const c = overlay || initCaptionOverlay();
  if (!c) return;
  if (c.width !== videoW || c.height !== videoH) {
    c.width = videoW;
    c.height = videoH;
  }
}

export function renderCaptionOverlay(playheadMs: number): void {
  const IK = (window as any).IKState;
  if (!IK || !IK.isReady()) return;
  const c = overlay || initCaptionOverlay();
  if (!c || !octx) return;

  // Keep the caption canvas in sync with the video canvas
  const videoCanvas = document.getElementById('canvas-img') as HTMLCanvasElement | null;
  if (videoCanvas && (c.width !== videoCanvas.width || c.height !== videoCanvas.height)) {
    c.width = videoCanvas.width;
    c.height = videoCanvas.height;
  }

  octx.clearRect(0, 0, c.width, c.height);

  const playheadUs = Math.round(playheadMs * 1000);
  const tracks = IK.getTracks() || [];

  for (const track of tracks) {
    if (track.track_type !== 'caption') continue;
    if (track.locked || !track.visible) continue;

    for (const clip of track.clips || []) {
      if (playheadUs < clip.timeline_start_us || playheadUs >= clip.timeline_end_us) continue;

      const text = clip.caption_text;
      if (!text) continue;

      const style = clip.caption_style;
      drawCaption(text, style, c.width, c.height);
    }
  }
}

function drawCaption(
  text: string,
  style: CaptionStyle | null,
  cw: number,
  ch: number,
): void {
  if (!octx) return;
  const fontFamily = style?.font_family || 'Plus Jakarta Sans, sans-serif';
  const posRaw = style?.position || 'lowerthird';
  // Accept all variants for robustness — Rust serde lowercase → "lowerthird"
  const position =
    posRaw === 'top'
      ? 'top'
      : posRaw.startsWith('lower')
        ? 'lowerthird'
        : 'center';
  const size = style?.size || Math.max(14, cw * 0.04);
  const bgOpacity = style?.bg_opacity ?? 0.3;
  const colour = style?.colour
    ? `rgba(${style.colour[0]}, ${style.colour[1]}, ${style.colour[2]}, ${(style.colour[3] ?? 255) / 255})`
    : '#ffffff';

  octx.save();

  const lines = text.split('\n');
  const lineHeight = size * 1.4;
  const totalHeight = lines.length * lineHeight;
  const maxWidth = cw * 0.85;
  const paddingX = size * 0.5;
  const paddingY = size * 0.35;

  // Measure text and wrap if needed
  octx.font = `700 ${size}px "${fontFamily}"`;
  const wrapped = wrapLines(octx, lines, maxWidth - paddingX * 2);

  const blockH = wrapped.length * lineHeight + paddingY * 2;
  let blockY: number;

  switch (position) {
    case 'top':
      blockY = paddingY;
      break;
    case 'center':
      blockY = (ch - blockH) / 2;
      break;
    case 'lowerthird':
    default:
      blockY = ch - blockH - paddingY * 4;
      break;
  }

  // Background panel
  if (bgOpacity > 0.01) {
    // Measure to get actual block width
    let blockW = 0;
    for (const line of wrapped) {
      const m = octx.measureText(line);
      if (m.width > blockW) blockW = m.width;
    }
    octx.fillStyle = `rgba(0, 0, 0, ${bgOpacity})`;
    const bx = (cw - blockW) / 2 - paddingX;
    octx.fillRect(bx, blockY, blockW + paddingX * 2, blockH);
  }

  // Text
  octx.fillStyle = colour;
  octx.textAlign = 'center';
  octx.textBaseline = 'top';

  for (let i = 0; i < wrapped.length; i++) {
    octx.fillText(wrapped[i]!, cw / 2, blockY + paddingY + i * lineHeight);
  }

  octx.restore();
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  maxWidth: number,
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push('');
      continue;
    }
    const words = line.split(' ');
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        out.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

// ── Caption Editor Panel ──────────────────────────────────────────────────

let _editingClipId: number | null = null;

function getClip(id: number): any | null {
  const IK = (window as any).IKState;
  if (!IK) return null;
  const tracks = IK.getTracks() || [];
  for (const t of tracks) {
    for (const c of t.clips || []) {
      if (c.id === id) return c;
    }
  }
  return null;
}

function findCaptionTrack(): any | null {
  const IK = (window as any).IKState;
  if (!IK) return null;
  return (IK.getTracks() || []).find((t: any) => t.track_type === 'caption');
}

export function openCaptionEditor(clipId: number): void {
  const clip = getClip(clipId);
  if (!clip) return;

  _editingClipId = clipId;

  const panel = document.getElementById('caption-editor');
  if (!panel) return;
  panel.style.display = 'block';

  const textInput = document.getElementById('caption-text-input') as HTMLTextAreaElement;
  if (textInput) textInput.value = clip.caption_text || '';

  const style = clip.caption_style || {};
  const posSel = document.getElementById('caption-position') as HTMLSelectElement;
  if (posSel) posSel.value = style.position || 'lowerthird';

  const sizeSlider = document.getElementById('caption-size') as HTMLInputElement;
  const sizeVal = document.getElementById('caption-size-val');
  const size = style.size || 4;
  if (sizeSlider) sizeSlider.value = String(size);
  if (sizeVal) sizeVal.textContent = size + '%';

  const colourIn = document.getElementById('caption-colour') as HTMLInputElement;
  if (colourIn && style.colour) {
    const r = style.colour[0]?.toString(16).padStart(2, '0') ?? 'ff';
    const g = style.colour[1]?.toString(16).padStart(2, '0') ?? 'ff';
    const b = style.colour[2]?.toString(16).padStart(2, '0') ?? 'ff';
    colourIn.value = '#' + r + g + b;
  }

  const bgSlider = document.getElementById('caption-bg-opacity') as HTMLInputElement;
  if (bgSlider) bgSlider.value = String(Math.round((style.bg_opacity ?? 0.3) * 100));
}

function closeCaptionEditor(): void {
  _editingClipId = null;
  const panel = document.getElementById('caption-editor');
  if (panel) panel.style.display = 'none';
}

function applyCaptionChanges(): void {
  if (_editingClipId === null) return;
  const clip = getClip(_editingClipId);
  if (!clip) return;

  const textInput = document.getElementById('caption-text-input') as HTMLTextAreaElement;
  if (textInput) clip.caption_text = textInput.value;

  if (!clip.caption_style) {
    clip.caption_style = {
      font_family: 'Plus Jakarta Sans, sans-serif',
      size: 4,
      colour: [255, 255, 255, 255],
      bg_opacity: 0.3,
      position: 'lowerthird',
    };
  }

  const posSel = document.getElementById('caption-position') as HTMLSelectElement;
  if (posSel) clip.caption_style.position = posSel.value;

  const sizeSlider = document.getElementById('caption-size') as HTMLInputElement;
  const sizeVal = document.getElementById('caption-size-val');
  if (sizeSlider) {
    clip.caption_style.size = parseFloat(sizeSlider.value);
    if (sizeVal) sizeVal.textContent = sizeSlider.value + '%';
  }

  const colourIn = document.getElementById('caption-colour') as HTMLInputElement;
  if (colourIn) {
    const hex = colourIn.value;
    clip.caption_style.colour = [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
      255,
    ];
  }

  const bgSlider = document.getElementById('caption-bg-opacity') as HTMLInputElement;
  if (bgSlider) clip.caption_style.bg_opacity = parseInt(bgSlider.value) / 100;

  window.dispatchEvent(new CustomEvent('ikl:reRender'));
}

function deleteCaption(): void {
  if (_editingClipId === null) return;
  const IK = (window as any).IKState;
  if (!IK) return;
  IK.removeClip(_editingClipId);
  _editingClipId = null;
  closeCaptionEditor();
  window.dispatchEvent(new CustomEvent('ikl:reRender'));
}

export function initCaptionEditor(): void {
  document.addEventListener('dblclick', (e) => {
    const clipEl = (e.target as Element).closest('.tl-clip-caption');
    if (!clipEl) return;
    const clipId = parseInt((clipEl as HTMLElement).dataset.clipId!);
    if (!isNaN(clipId)) openCaptionEditor(clipId);
  });

  document.getElementById('caption-text-input')?.addEventListener('input', applyCaptionChanges);
  document.getElementById('caption-position')?.addEventListener('change', applyCaptionChanges);
  document.getElementById('caption-size')?.addEventListener('input', applyCaptionChanges);
  document.getElementById('caption-colour')?.addEventListener('input', applyCaptionChanges);
  document.getElementById('caption-bg-opacity')?.addEventListener('input', applyCaptionChanges);
  document.getElementById('caption-close')?.addEventListener('click', closeCaptionEditor);
  document.getElementById('caption-delete')?.addEventListener('click', deleteCaption);
}
