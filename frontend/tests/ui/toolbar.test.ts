// @vitest-environment jsdom
/**
 * Tests for src/ui/toolbar.ts:
 *   - initToolbar (text, effects, color-picker, ai-tabs, aspect-ratio)
 *   - appendChat (via submitCmd)
 *   - initChat (autocomplete, insertAC, submitCmd with AI commands)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/ui/state', () => ({
  S: {
    time: 0, dur: 10, zoom: 1, tool: 'select', selectedAR: '16/9',
    playing: false, rafId: null, lastTs: null, timelineHeight: 360,
  },
  $: (s: string) => document.querySelector(s) as HTMLElement | null,
  $$: (s: string) => document.querySelectorAll(s),
  us2s: (us: number) => us / 1_000_000,
  mediaPool: { footage: [], audio: [], stock: { video: [], image: [], music: [] } },
  aiNodes: [],
}));

vi.mock('../../src/ui/utils', () => ({
  showToast: vi.fn(),
  resizeCanvas: vi.fn(),
  picUrl: vi.fn(),
}));

vi.mock('../../src/ui/timeline', () => ({
  calculateTimelineDuration: vi.fn().mockReturnValue(10),
  renderRuler: vi.fn(),
  renderClips: vi.fn(),
  updatePlayhead: vi.fn(),
  applyAiAction: vi.fn(),
}));

const FIXTURE = `
  <button id="t-text"></button>
  <button id="t-effects"></button>
  <div id="canvas-text"></div>
  <div id="canvas-frame" style="filter:none;aspect-ratio:16/9;"></div>
  <div id="fcb" class="collapsed"></div>
  <div id="editor-color-picker">
    <div class="color-swatch" data-color="#ff0000" data-glow="#ff000055" style="border-color:rgba(255,255,255,0.1)"></div>
    <div class="color-swatch" data-color="#00ff00" data-glow="#00ff0055" style="border-color:rgba(255,255,255,0.1)"></div>
  </div>
  <button class="ai-tab active" data-target="tab-chat">Chat</button>
  <button class="ai-tab" data-target="tab-script">Script</button>
  <div id="tab-chat" style="display:flex;"></div>
  <div id="tab-script" style="display:none;"></div>
  <div id="tab-brand" style="display:none;"></div>
  <div id="copilot-body" style="display:flex;"></div>
  <div id="grade-panel" style="display:none;"></div>
  <button id="ar-btn"></button>
  <div id="ar-menu"></div>
  <div id="ar-label">16:9</div>
  <i id="ar-icon" data-lucide="monitor"></i>
  <div class="ar-option active" data-ar="16/9" data-label="16:9 Landscape" data-icon="monitor"></div>
  <div class="ar-option" data-ar="9/16" data-label="9:16 Portrait" data-icon="smartphone"></div>
  <div id="panel-right" style="width:300px;"></div>
  <input id="ai-cmd" type="text" value="" />
  <div id="ac-menu"></div>
  <div style="overflow-y:scroll;height:200px;">
    <div id="chat-log"></div>
  </div>
  <div id="toast-box"></div>
`;

describe('initToolbar – text button', () => {
  let initToolbar: () => void;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/toolbar');
    initToolbar = mod.initToolbar;
    initToolbar();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('toggles active class on t-text button', () => {
    const btn = document.getElementById('t-text')!;
    expect(btn.classList.contains('active')).toBe(false);
    btn.click();
    expect(btn.classList.contains('active')).toBe(true);
    btn.click();
    expect(btn.classList.contains('active')).toBe(false);
  });

  it('toggles canvas-text active class', () => {
    const btn = document.getElementById('t-text')!;
    const ct = document.getElementById('canvas-text')!;
    btn.click();
    expect(ct.classList.contains('active')).toBe(true);
    btn.click();
    expect(ct.classList.contains('active')).toBe(false);
  });
});

describe('initToolbar – effects button', () => {
  let initToolbar: () => void;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/toolbar');
    initToolbar = mod.initToolbar;
    initToolbar();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('toggles grade panel visibility', () => {
    const btn = document.getElementById('t-effects')!;
    const gradePanel = document.getElementById('grade-panel')!;
    expect(gradePanel.style.display).toBe('none');
    btn.click();
    expect(gradePanel.style.display).toBe('flex');
    btn.click();
    expect(gradePanel.style.display).toBe('none');
  });
});

describe('initToolbar – color swatch', () => {
  let initToolbar: () => void;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/toolbar');
    initToolbar = mod.initToolbar;
    initToolbar();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('clicking color swatch updates CSS variables', () => {
    const swatches = document.querySelectorAll('.color-swatch');
    (swatches[0] as HTMLElement).click();
    const accentPrimary = document.documentElement.style.getPropertyValue('--accent-primary');
    expect(accentPrimary).toBe('#ff0000');
  });

  it('clicking swatch sets its border-color to white', () => {
    const swatch = document.querySelector('.color-swatch') as HTMLElement;
    swatch.click();
    expect(swatch.style.borderColor).toBe('white');
  });
});

describe('initToolbar – ai-tabs', () => {
  let initToolbar: () => void;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/toolbar');
    initToolbar = mod.initToolbar;
    initToolbar();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('clicking ai-tab activates it and shows target panel', () => {
    const scriptTab = document.querySelector('.ai-tab[data-target="tab-script"]') as HTMLElement;
    scriptTab.click();
    expect(scriptTab.classList.contains('active')).toBe(true);
    expect(document.getElementById('tab-script')!.style.display).toBe('flex');
    expect(document.getElementById('tab-chat')!.style.display).toBe('none');
  });
});

describe('initToolbar – aspect ratio', () => {
  let initToolbar: () => void;
  let S: any;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/toolbar');
    initToolbar = mod.initToolbar;
    initToolbar();
    const state = await import('../../src/ui/state');
    S = (state as any).S;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('clicking ar-btn toggles ar-menu open class', () => {
    const arBtn = document.getElementById('ar-btn')!;
    const arMenu = document.getElementById('ar-menu')!;
    arBtn.click();
    expect(arMenu.classList.contains('open')).toBe(true);
    // click on window removes open
    window.dispatchEvent(new Event('click'));
    expect(arMenu.classList.contains('open')).toBe(false);
  });

  it('clicking ar-option sets selectedAR and updates label', () => {
    const portraitOpt = document.querySelector('.ar-option[data-ar="9/16"]') as HTMLElement;
    portraitOpt.click();
    expect(S.selectedAR).toBe('9/16');
    expect(document.getElementById('ar-label')!.textContent).toBe('9:16');
  });

  it('sets panel-right width to 340px for portrait AR', () => {
    const portraitOpt = document.querySelector('.ar-option[data-ar="9/16"]') as HTMLElement;
    portraitOpt.click();
    expect(document.getElementById('panel-right')!.style.width).toBe('340px');
  });
});

describe('initChat – autocomplete and submitCmd', () => {
  let initToolbar: () => void;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    // Set up IKState on real window
    (window as any).IKState = {
      getVideoClips: () => [{ name: 'MyClip.mp4' }],
    };
    const mod = await import('../../src/ui/toolbar');
    initToolbar = mod.initToolbar;
    initToolbar();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).IKState;
    delete (window as any).submitCmd;
    delete (window as any).insertAC;
    vi.resetModules();
  });

  it('shows autocomplete menu on "/" input', () => {
    const input = document.getElementById('ai-cmd') as HTMLInputElement;
    input.value = '/';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.getElementById('ac-menu')!.classList.contains('active')).toBe(true);
  });

  it('hides autocomplete menu on normal word', () => {
    const input = document.getElementById('ai-cmd') as HTMLInputElement;
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.getElementById('ac-menu')!.classList.contains('active')).toBe(false);
  });

  it('shows @clip autocomplete', () => {
    const input = document.getElementById('ai-cmd') as HTMLInputElement;
    input.value = '@';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.getElementById('ac-menu')!.classList.contains('active')).toBe(true);
    expect(document.getElementById('ac-menu')!.innerHTML).toContain('MyClip');
  });

  it('submitCmd dispatches AI action for trim-silence command', async () => {
    vi.useFakeTimers();
    const { applyAiAction } = await import('../../src/ui/timeline');
    const input = document.getElementById('ai-cmd') as HTMLInputElement;
    input.value = '/trim-silence';
    (window as any).submitCmd();
    vi.advanceTimersByTime(700);
    expect(applyAiAction).toHaveBeenCalledWith('silence');
    vi.useRealTimers();
  });

  it('submitCmd dispatches AI action for sync-audio command', async () => {
    vi.useFakeTimers();
    const { applyAiAction } = await import('../../src/ui/timeline');
    const input = document.getElementById('ai-cmd') as HTMLInputElement;
    input.value = '/sync-audio';
    (window as any).submitCmd();
    vi.advanceTimersByTime(700);
    expect(applyAiAction).toHaveBeenCalledWith('sync');
    vi.useRealTimers();
  });

  it('submitCmd dispatches AI action for add-captions command', async () => {
    vi.useFakeTimers();
    const { applyAiAction } = await import('../../src/ui/timeline');
    const input = document.getElementById('ai-cmd') as HTMLInputElement;
    input.value = '/add-captions';
    (window as any).submitCmd();
    vi.advanceTimersByTime(700);
    expect(applyAiAction).toHaveBeenCalledWith('captions');
    vi.useRealTimers();
  });

  it('submitCmd with AI chat (not slash command) adds chat msg', () => {
    vi.useFakeTimers();
    const input = document.getElementById('ai-cmd') as HTMLInputElement;
    input.value = 'hello world';
    (window as any).submitCmd();
    const chatLog = document.getElementById('chat-log')!;
    expect(chatLog.children.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('insertAC replaces last word in input', () => {
    const input = document.getElementById('ai-cmd') as HTMLInputElement;
    input.value = 'trim /';
    (window as any).insertAC('/trim-silence ');
    expect(input.value).toContain('/trim-silence');
  });

  it('empty submitCmd does nothing', () => {
    const input = document.getElementById('ai-cmd') as HTMLInputElement;
    input.value = '';
    expect(() => (window as any).submitCmd()).not.toThrow();
  });

  it('submitCmd with @ mention works', async () => {
    vi.useFakeTimers();
    const input = document.getElementById('ai-cmd') as HTMLInputElement;
    input.value = '@MyClip.mp4 ';
    (window as any).submitCmd();
    vi.advanceTimersByTime(700);
    const chatLog = document.getElementById('chat-log')!;
    expect(chatLog.children.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
