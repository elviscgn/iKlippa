import { $, $$, S, us2s } from './state';
import { selectedClipIds, saveSnapshot, undo, redo } from './dragDrop';
import { reRender, getLaneW, updatePlayhead, hideSnapGuide } from './timeline';
import { showToast } from './utils';

let copiedClipsData: any[] | null = null;

export function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
    const IKState = (window as any).IKState;
    if (!IKState) return;

    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC' && !e.shiftKey) {
      e.preventDefault();
      if (selectedClipIds.size === 0) return;
      const ids: (string | number)[] = [];
      for (const id of selectedClipIds) ids.push(id, ...IKState.getLinkedClipIds(id));
      copiedClipsData = [...new Set(ids)].map((id) => {
        const c = IKState.findClip(id);
        if (!c) return null;
        return { clip: JSON.parse(JSON.stringify(c)), meta: IKState.getClipMeta(id) };
      }).filter(Boolean);
      showToast('Copied ' + copiedClipsData.length + ' clip(s)', 'copy');
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
      e.preventDefault();
      if (!copiedClipsData || copiedClipsData.length === 0) return;
      saveSnapshot();
      const pasteTimeUs = Math.round(S.time * 1_000_000);
      let cursorUs = pasteTimeUs;
      const addClip = (c: any, meta: any) => {
        const dur = c.timeline_end_us - c.timeline_start_us;
        const isAudio = c.source_id && c.source_id.startsWith('audio_');
        const addFn = isAudio ? IKState.addAudioClip : IKState.addVideoClip;
        const newId = addFn(c.source_id, cursorUs, cursorUs + dur, meta);
        if (newId !== null && c.source_start_us > 0) {
          IKState.trimClip(newId, cursorUs, cursorUs + dur, c.source_start_us);
        }
        cursorUs += dur;
      };
      for (const data of copiedClipsData) addClip(data.clip, data.meta);
      reRender();
      showToast('Pasted ' + copiedClipsData.length + ' clip(s)', 'clipboard-paste');
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      const activeEl = document.querySelector('.tl-clip.active') as HTMLElement;
      if (!activeEl) return;
      const clipId = parseInt(activeEl.dataset.clipId!);
      if (isNaN(clipId)) return;
      const deltaUs = e.shiftKey ? 1_000_000 : Math.round(1_000_000 / 30);
      const dir = e.code === 'ArrowLeft' ? -1 : 1;
      const clip = IKState.findClip(clipId);
      if (!clip) return;
      const newStartUs = Math.max(0, clip.timeline_start_us + dir * deltaUs);
      saveSnapshot();
      IKState.moveClip(clipId, newStartUs);
      IKState.computeDuration();
      const tw = getLaneW();
      const dur = S.dur;
      const newPx = (us2s(newStartUs) / dur) * tw;
      activeEl.style.left = newPx + 'px';
      updatePlayhead();
    } else if (e.code === 'KeyV' && !(e.ctrlKey || e.metaKey)) {
      S.tool = 'select';
      $$('.tl-tool').forEach((b) => (b as HTMLElement).classList.remove('active'));
      const selectBtn = document.querySelector('.tl-tool[data-tool="select"]');
      if (selectBtn) selectBtn.classList.add('active');
    } else if (e.code === 'KeyS') {
      S.tool = 'split';
      $$('.tl-tool').forEach((b) => (b as HTMLElement).classList.remove('active'));
      const splitBtn = document.querySelector('.tl-tool[data-tool="split"]');
      if (splitBtn) splitBtn.classList.add('active');
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && e.shiftKey) {
      e.preventDefault();
      redo();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
      e.preventDefault();
      redo();
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      hideSnapGuide();
      if (selectedClipIds.size === 0) return;
      saveSnapshot();
      const idsToRemove = new Set<string | number>();
      for (const id of selectedClipIds) {
        idsToRemove.add(id);
        for (const linkedId of IKState.getLinkedClipIds(id)) idsToRemove.add(linkedId);
      }
      for (const id of idsToRemove) IKState.removeClip(id);
      selectedClipIds.clear();
      reRender();
      showToast(idsToRemove.size + ' clip(s) deleted', 'trash-2');
    }
  });
}
