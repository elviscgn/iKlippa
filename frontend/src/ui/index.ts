import { S, mediaPool, aiNodes } from './state';
import './utils';
import { initMediaPoolTabs } from './mediaPool';
import { initToolbar } from './toolbar';
import { initTimelineUI, calculateTimelineDuration, renderRuler, renderClips, updatePlayhead } from './timeline';
import { initPlayback } from './playback';
import { initKeyboardShortcuts } from './keyboard';
import { resizeCanvas } from './utils';
import { initCaptionOverlay, initCaptionEditor } from './captions';
import { initLutPanel } from './lut';

// Expose state and mediaPool globally to avoid breaking app.js / main.ts expectations
declare global {
  interface Window {
    S: typeof S;
    mediaPool: typeof mediaPool;
    aiNodes: typeof aiNodes;
  }
}

window.S = S;
window.mediaPool = mediaPool;
window.aiNodes = aiNodes;

function initUI() {
  initMediaPoolTabs();
  initToolbar();
  initTimelineUI();
  initPlayback();
  initKeyboardShortcuts();
  initCaptionOverlay();
  initCaptionEditor();
  initLutPanel();

  window.renderMedia('footage');
  calculateTimelineDuration();
  renderRuler();
  renderClips();
  updatePlayhead();
  resizeCanvas();

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// ── Initialization Trigger ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initUI();
});
