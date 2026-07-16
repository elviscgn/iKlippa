import { $, $$, S, us2s } from './state';
import { reRender, hideSnapGuide, showSnapGuide, applySnap, getLaneW } from './timeline';

// ── Undo / Redo ──────────────────────────────────────────────────────────
const MAX_UNDO = 50;
let undoStack: any[] = [];
let redoStack: any[] = [];

declare global {
  interface Window {
    saveSnapshot: () => void;
    undo: () => void;
    redo: () => void;
  }
}

export function saveSnapshot() {
  const IKState = (window as any).IKState;
  if (!IKState) return;
  undoStack.push(IKState.saveState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
}
window.saveSnapshot = saveSnapshot;

function afterUndoRedo() {
  reRender();
}

export function undo() {
  const IKState = (window as any).IKState;
  if (undoStack.length === 0 || !IKState) return;
  redoStack.push(IKState.saveState());
  const prev = undoStack.pop();
  IKState.loadState(prev);
  afterUndoRedo();
}
window.undo = undo;

export function redo() {
  const IKState = (window as any).IKState;
  if (redoStack.length === 0 || !IKState) return;
  undoStack.push(IKState.saveState());
  const next = redoStack.pop();
  IKState.loadState(next);
  afterUndoRedo();
}
window.redo = redo;

export const selectedClipIds = new Set<number | string>();

export function syncActiveClasses() {
  $$('.tl-clip').forEach((c) => {
    const el = c as HTMLElement;
    const id = el.dataset.clipId;
    if (id) {
      // Use == to allow string/number comparison if needed, or parse
      const isSelected = selectedClipIds.has(id) || selectedClipIds.has(parseInt(id));
      el.classList.toggle('active', isSelected);
    }
  });
}

function deactivateSplitTool() {
  S.tool = 'select';
  $$('.tl-tool').forEach((b) => b.classList.remove('active'));
  const selectBtn = document.querySelector('.tl-tool[data-tool="select"]');
  if (selectBtn) selectBtn.classList.add('active');
}

export function applyDragLogic(el: HTMLElement, clip: any, clipArray: any[], tw: number) {
  const IKState = (window as any).IKState;
  el.onmousedown = (e) => {
    if (S.tool === 'split') {
      const rect = el.parentElement!.getBoundingClientRect();
      const clickX = e.clientX - rect.left + el.parentElement!.parentElement!.scrollLeft;
      const t = (clickX / tw) * S.dur;
      const clipStartSec = us2s(clip.timeline_start_us);
      const clipEndSec = us2s(clip.timeline_end_us);
      if (t > clipStartSec + 0.5 && t < clipEndSec - 0.5) {
        saveSnapshot();
        const splitAtUs = Math.round(t * 1_000_000);
        const newId = IKState.splitClip(clip.id, splitAtUs);
        if (newId !== null) {
          window.showToast('Clip Split', 'scissors');
          reRender(newId);
        }
      }
      deactivateSplitTool();
    } else if (S.tool === 'select') {
      if (e.ctrlKey || e.metaKey) {
        if (selectedClipIds.has(clip.id)) selectedClipIds.delete(clip.id);
        else selectedClipIds.add(clip.id);
      } else {
        selectedClipIds.clear();
        selectedClipIds.add(clip.id);
      }
      syncActiveClasses();
      const dur = S.dur;
      if (dur <= 0) return;

      const clipRect = el.getBoundingClientRect();
      const clickXInClip = e.clientX - clipRect.left;
      const trimZone = 8;
      const isLeftTrim = clickXInClip < trimZone;
      const isRightTrim = clickXInClip > clipRect.width - trimZone;

      if (isLeftTrim || isRightTrim) {
        const origStartUs = clip.timeline_start_us;
        const origEndUs = clip.timeline_end_us;
        const origSourceStartUs = clip.source_start_us;
        const speed = clip.speed || 1;
        const minDurUs = 500_000;
        const lane = el.parentElement!;

        const move = (e2: MouseEvent) => {
          const laneRect = lane.getBoundingClientRect();
          const scrollLeft = lane.parentElement ? lane.parentElement.scrollLeft : 0;
          const mx = e2.clientX - laneRect.left + scrollLeft;
          const mouseSec = (mx / tw) * dur;

          if (isLeftTrim) {
            const rawUs = Math.round(mouseSec * 1_000_000);
            const snapped = applySnap(rawUs, clip.id, tw);
            const newStartUs = Math.round(
              Math.max(0, Math.min(snapped !== null ? snapped : rawUs, origEndUs - minDurUs))
            );
            const newEndUs = origEndUs;
            const newSourceStartUs = origSourceStartUs + Math.round((newStartUs - origStartUs) / speed);
            const leftPx = (us2s(newStartUs) / dur) * tw;
            const widthPx = (us2s(newEndUs - newStartUs) / dur) * tw;
            el.style.left = leftPx + 'px';
            el.style.width = widthPx + 'px';
            (el as any)._trimNewStart = newStartUs;
            (el as any)._trimNewSourceStart = Math.max(0, newSourceStartUs);
            if (snapped !== null) showSnapGuide(newStartUs, tw);
            else hideSnapGuide();
          } else {
            const rawUs = Math.round(mouseSec * 1_000_000);
            const snapped = applySnap(rawUs, clip.id, tw);
            const newEndUs = Math.round(
              Math.max(origStartUs + minDurUs, snapped !== null ? snapped : rawUs)
            );
            const widthPx = (us2s(newEndUs - origStartUs) / dur) * tw;
            el.style.width = widthPx + 'px';
            (el as any)._trimNewEnd = newEndUs;
            if (snapped !== null) showSnapGuide(newEndUs, tw);
            else hideSnapGuide();
          }
        };

        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          hideSnapGuide();
          if (!document.body.contains(el)) return;
          if (isLeftTrim && (el as any)._trimNewStart !== undefined) {
            saveSnapshot();
            IKState.trimClip(clip.id, (el as any)._trimNewStart, origEndUs, (el as any)._trimNewSourceStart);
          } else if (isRightTrim && (el as any)._trimNewEnd !== undefined) {
            saveSnapshot();
            IKState.trimClip(clip.id, origStartUs, (el as any)._trimNewEnd, origSourceStartUs);
          }
          delete (el as any)._trimNewStart;
          delete (el as any)._trimNewEnd;
          delete (el as any)._trimNewSourceStart;
          reRender(clip.id);
        };

        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        e.preventDefault();
      } else {
        const moveIds = selectedClipIds.has(clip.id) ? Array.from(selectedClipIds) : [clip.id];
        const initialPositions: Record<string, number> = {};
        const moveEls: Record<string, HTMLElement> = {};
        for (const id of moveIds) {
          const c = IKState.findClip(id);
          if (c) {
            initialPositions[id as string] = c.timeline_start_us;
            const el2 = document.querySelector(`[data-clip-id="${id}"]`) as HTMLElement;
            if (el2) moveEls[id as string] = el2;
          }
        }
        const startX = e.clientX;

        const move = (e2: MouseEvent) => {
          const dx = e2.clientX - startX;
          const dtSec = (dx / tw) * dur;
          for (const id of moveIds) {
            const startUs = initialPositions[id as string]!;
            const rawUs = Math.round((startUs / 1_000_000 + dtSec) * 1_000_000);
            const snapped = applySnap(rawUs, clip.id, tw);
            const newStartUs = Math.max(0, snapped !== null ? snapped : rawUs);
            const newPx = (us2s(newStartUs) / dur) * tw;
            const el2 = moveEls[id as string];
            if (el2) el2.style.left = newPx + 'px';
          }
          if (moveIds.length === 1) {
            const rawUs = Math.round((initialPositions[moveIds[0] as string]! / 1_000_000 + dtSec) * 1_000_000);
            const snapped = applySnap(rawUs, clip.id, tw);
            if (snapped !== null) showSnapGuide(snapped, tw);
            else hideSnapGuide();
          } else {
            hideSnapGuide();
          }
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          hideSnapGuide();
          if (!document.body.contains(el)) return;
          const dx = parseFloat(el.style.left) - (us2s(initialPositions[clip.id]!) / dur) * tw;
          const dtSec = (dx / tw) * dur;
          saveSnapshot();
          for (const id of moveIds) {
            const newStartUs = Math.max(0, Math.round((initialPositions[id as string]! / 1_000_000 + dtSec) * 1_000_000));
            IKState.moveClip(id, newStartUs);
          }
          reRender(clip.id);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        e.preventDefault();
      }
    }
  };
}
