import type { CaptionStyle } from '../state/types';

let overlay: HTMLCanvasElement | null = null;
let octx: CanvasRenderingContext2D | null = null;

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
