// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { initKeyboardShortcuts, handleCopy, handlePaste, handleNudge, handleToolSwitch, handleUndoRedo, handleDelete } from '../src/ui/keyboard';
import { initToolbar } from '../src/ui/toolbar';

test('UI init functions should not throw', () => {
  document.body.innerHTML = '<div class="tl-tool" data-tool="select"></div><div id="toolbar"></div>';
  // Mock window objects required by the init scripts
  (window as any).IKState = {
    findClip: () => null,
    saveState: () => {},
    loadState: () => {},
  };
  (window as any).showToast = () => {};

  expect(() => initKeyboardShortcuts()).not.toThrow();
  expect(() => initToolbar()).not.toThrow();
  
  // Call handlers to test coverage
  const fakeEvent = new KeyboardEvent('keydown', { code: 'KeyC', ctrlKey: true });
  expect(() => handleCopy(fakeEvent, (window as any).IKState)).not.toThrow();
  expect(() => handlePaste(fakeEvent, (window as any).IKState)).not.toThrow();
  expect(() => handleNudge(fakeEvent, (window as any).IKState)).not.toThrow();
  expect(() => handleToolSwitch(fakeEvent)).not.toThrow();
  expect(() => handleUndoRedo(fakeEvent)).not.toThrow();
  expect(() => handleDelete(fakeEvent, (window as any).IKState)).not.toThrow();
});
