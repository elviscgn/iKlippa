import { $, $$, S, aiNodes } from './state';
import { showToast, resizeCanvas, toggleOfflineMode } from './utils';
import { calculateTimelineDuration, renderRuler, renderClips, updatePlayhead, applyAiAction } from './timeline';
import { sendGranitePrompt, warmGraniteModel } from '../ai/granite';

let isTextActive = false;
let isEffectActive = false;
let isGraniteBusy = false;

export function initToolbar() {
  const btnText = $('#t-text');
  const chatComposer = $('#chat-composer') as HTMLElement | null;
  if (btnText) {
    btnText.onclick = () => {
      isTextActive = !isTextActive;
      btnText.classList.toggle('active');
      const capOverlay = $('#caption-overlay');
      if (capOverlay) capOverlay.style.display = capOverlay.style.display === 'block' ? 'none' : 'block';
      showToast(isTextActive ? 'Caption Overlay Enabled' : 'Caption Overlay Disabled', 'type');
    };
  }

  const btnEffects = $('#t-effects');
  if (btnEffects) {
    btnEffects.onclick = () => {
      isEffectActive = !isEffectActive;
      btnEffects.classList.toggle('active');
      const gradePanel = $('#grade-panel');
      const copilotBody = $('#copilot-body');
      if (gradePanel && copilotBody) {
        gradePanel.style.display = isEffectActive ? 'flex' : 'none';
        copilotBody.style.display = isEffectActive ? 'none' : 'flex';
      }
      syncChatComposer(chatComposer);
      showToast(isEffectActive ? 'Colour Grade Panel Open' : 'AI Director Restored', 'sparkles');
    };
  }

  const fcbToggle = $('#fcb');
  if (fcbToggle) {
    (window as any).toggleFcb = () => {
      fcbToggle.classList.toggle('collapsed');
    };
  }

  $$('#editor-color-picker .color-swatch').forEach((sw) => {
    (sw as HTMLElement).onclick = () => {
      $$('#editor-color-picker .color-swatch').forEach(
        (s) => ((s as HTMLElement).style.borderColor = 'rgba(255,255,255,0.1)')
      );
      (sw as HTMLElement).style.borderColor = 'white';
      document.documentElement.style.setProperty('--accent-primary', (sw as HTMLElement).dataset.color!);
      document.documentElement.style.setProperty('--accent-hover', (sw as HTMLElement).dataset.color!);
      document.documentElement.style.setProperty('--accent-glow', (sw as HTMLElement).dataset.glow!);
    };
  });

  $$('.ai-tab').forEach((tab) => {
    (tab as HTMLElement).onclick = () => {
      $$('.ai-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      ['tab-chat', 'tab-script', 'tab-brand'].forEach((id) => {
        const el = $('#' + id);
        if (el) el.style.display = 'none';
      });
      const target = $('#' + (tab as HTMLElement).dataset.target!);
      if (target) target.style.display = 'flex';
      syncChatComposer(chatComposer);
    };
  });

  initChat();
  syncChatComposer(chatComposer);
  initAspectRatio();
  initModeToggle();
}

function syncChatComposer(chatComposer: HTMLElement | null) {
  if (!chatComposer) return;
  const activeTab = document.querySelector('.ai-tab.active') as HTMLElement | null;
  chatComposer.style.display = activeTab?.dataset.target === 'tab-chat' && !isEffectActive ? 'flex' : 'none';
}

function initChat() {
  const cmdInput = $('#ai-cmd') as HTMLInputElement | null;
  const cmdSend = $('#ai-cmd-send') as HTMLButtonElement | null;
  const miniInput = $('#chat-mini-cmd') as HTMLInputElement | null;
  const miniSend = $('#chat-mini-send') as HTMLButtonElement | null;
  const acMenu = $('#ac-menu');

  if (!cmdInput && !miniInput) return;

  let warmupAttempted = false;
  const warmGranite = () => {
    if (warmupAttempted) return;
    warmupAttempted = true;
    void warmGraniteModel().catch(() => {
      // Lazy fallback still works on submit.
      warmupAttempted = false;
    });
  };

  const composerInputs = [cmdInput, miniInput].filter(Boolean) as HTMLInputElement[];
  const composerButtons = [cmdSend, miniSend].filter(Boolean) as HTMLButtonElement[];

  const setGraniteBusy = (busy: boolean) => {
    isGraniteBusy = busy;
    for (const input of composerInputs) input.disabled = busy;
    for (const button of composerButtons) button.disabled = busy;
  };

  const runLocalCommand = (val: string) => {
    const command = val.toLowerCase();
    setTimeout(() => {
      if (command.includes('/trim-silence')) {
        applyAiAction('silence');
        appendChat('Trimmed the silences locally.');
      } else if (command.includes('/sync-audio')) {
        applyAiAction('sync');
        appendChat('Matched the cut timing to the beat.');
      } else if (command.includes('/add-captions')) {
        applyAiAction('captions');
        appendChat('Generated captions on the timeline.');
      } else if (command.includes('/auto-broll')) {
        appendChat('Auto b-roll is not wired yet, but I can still help plan it.');
      } else {
        appendChat('Try /trim-silence, /sync-audio, or /add-captions.');
      }
    }, 300);
  };

  const submitPrompt = (sourceInput: HTMLInputElement) => {
    const val = sourceInput.value.trim();
    if (!val || isGraniteBusy) return;

    appendChat(val, true);
    sourceInput.value = '';
    acMenu?.classList.remove('active');

    if (val.startsWith('/')) {
      runLocalCommand(val);
      return;
    }

    const aiBody = appendChat('Loading Granite locally...', false);
    setGraniteBusy(true);
    void sendGranitePrompt(val, {
      onChunk: (chunk) => {
        if (aiBody.textContent === 'Loading Granite locally...') {
          aiBody.textContent = '';
        }
        aiBody.textContent += chunk;
        scrollChatToBottom();
      },
    })
      .then((response) => {
        aiBody.textContent = response || 'Granite did not return a response.';
        scrollChatToBottom();
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        aiBody.textContent = message;
        showToast(message, 'alert-triangle');
      })
      .finally(() => {
        setGraniteBusy(false);
        sourceInput.focus();
      });
  };

  if (cmdInput && acMenu) {
    cmdInput.addEventListener('focus', warmGranite);

    cmdInput.addEventListener('input', (e) => {
      const lastWord = (e.target as HTMLInputElement).value.split(' ').pop() || '';
      if (lastWord.startsWith('/')) {
        acMenu.innerHTML =
          '<div class="ac-section">Commands</div>' +
          '<div class="ac-item" onclick="insertAC(\'/trim-silence \')"><i data-lucide="scissors"></i> /trim-silence</div>' +
          '<div class="ac-item" onclick="insertAC(\'/sync-audio \')"><i data-lucide="music"></i> /sync-audio</div>' +
          '<div class="ac-item" onclick="insertAC(\'/auto-broll \')"><i data-lucide="sparkles"></i> /auto-broll</div>' +
          '<div class="ac-item" onclick="insertAC(\'/add-captions \')"><i data-lucide="captions"></i> /add-captions</div>';
        window.lucide.createIcons({ nodes: [acMenu] });
        acMenu.classList.add('active');
      } else if (lastWord.startsWith('@')) {
        const clipItems = (window as any).IKState.getVideoClips().map((c: any) =>
          `<div class="ac-item" onclick="insertAC('@${c.name.replace(/[^a-zA-Z0-9_]/g, '_')} ')"><i data-lucide="film"></i> @${c.name}</div>`,
        ).join('');
        acMenu.innerHTML =
          '<div class="ac-section">Clips</div>' +
          (clipItems || '<div class="ac-item" style="color:var(--text-muted);">No clips yet</div>');
        window.lucide.createIcons({ nodes: [acMenu] });
        acMenu.classList.add('active');
      } else {
        acMenu.classList.remove('active');
      }
    });

    (window as any).insertAC = function (text: string) {
      const words = cmdInput.value.split(' ');
      words.pop();
      cmdInput.value = (words.join(' ') + ' ' + text).trim() + ' ';
      acMenu.classList.remove('active');
      cmdInput.focus();
    };

    (window as any).submitCmd = function () {
      submitPrompt(cmdInput);
    };

    cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitPrompt(cmdInput);
      }
    });
  }

  if (miniInput) {
    miniInput.addEventListener('focus', warmGranite);
    miniInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      submitPrompt(miniInput);
    });
  }

  if (miniSend && miniInput) {
    miniSend.addEventListener('click', (e) => {
      e.preventDefault();
      submitPrompt(miniInput);
    });
  }
}

function scrollChatToBottom() {
  const log = $('#chat-log') as HTMLElement | null;
  if (log) {
    log.scrollTop = log.scrollHeight;
    return;
  }
  const scrollRoot = $('#copilot-body') as HTMLElement | null;
  if (scrollRoot) {
    scrollRoot.scrollTop = scrollRoot.scrollHeight;
  }
}

function appendChat(text: string, isUser = false) {
  const el = document.createElement('div');
  el.className = 'chat-msg ' + (isUser ? 'user' : 'ai');
  const sender = document.createElement('div');
  sender.className = 'msg-sender';
  if (isUser) {
    sender.textContent = 'You';
  } else {
    const icon = document.createElement('i');
    icon.dataset.lucide = 'bot';
    sender.append(icon, document.createTextNode(' Granite'));
  }
  const body = document.createElement('div');
  body.className = 'chat-body';
  body.textContent = text;
  if (!isUser) {
    el.appendChild(sender);
  }
  el.appendChild(body);
  const log = $('#chat-log');
  if (log) {
    log.appendChild(el);
    window.lucide?.createIcons({ nodes: [el] });
    scrollChatToBottom();
  }
  return body;
}

function initAspectRatio() {
  const arBtn = $('#ar-btn');
  if (!arBtn) return;

  arBtn.onclick = (e) => {
    e.stopPropagation();
    $('#ar-menu')?.classList.toggle('open');
  };

  window.addEventListener('click', () => $('#ar-menu')?.classList.remove('open'));

  $$('.ar-option').forEach((opt) => {
    (opt as HTMLElement).onclick = () => {
      $$('.ar-option').forEach((o) => o.classList.remove('active'));
      opt.classList.add('active');
      const label = $('#ar-label');
      if (label) label.textContent = (opt as HTMLElement).dataset.label!.split(' ')[0]!;
      const icon = $('#ar-icon');
      if (icon) icon.setAttribute('data-lucide', (opt as HTMLElement).dataset.icon!);
      S.selectedAR = (opt as HTMLElement).dataset.ar!;
      const frame = $('#canvas-frame');
      if (frame) frame.style.aspectRatio = S.selectedAR;
      resizeCanvas();
      const panelRight = $('#panel-right');
      if (panelRight) {
        panelRight.style.width =
          S.selectedAR === '9/16' || S.selectedAR === '4/5' ? '340px' : '300px';
      }
      window.lucide.createIcons({ nodes: [arBtn] });
      showToast('Canvas set to ' + (opt as HTMLElement).dataset.label, 'monitor');
    };
  });
}

function initModeToggle() {
  const btn = $('#mode-toggle');
  const label = $('#mode-label');
  const icon = $('#mode-icon');
  if (!btn || !label || !icon) return;

  const refreshActiveView = () => {
    const activeMediaTab = document.querySelector('.media-tab.active') as HTMLElement | null;
    if (!activeMediaTab) return;
    const activeType = activeMediaTab.dataset.tab as 'footage' | 'audio' | 'stock' | undefined;
    if (activeType === 'stock') {
      const activeSub = document.querySelector('.stock-subtab.active') as HTMLElement | null;
      window.renderMedia('stock', (activeSub?.dataset.sub as 'video' | 'image' | 'music') || 'video');
    } else if (activeType) {
      window.renderMedia(activeType);
    }
    window.renderClips();
  };

  const sync = () => {
    const offline = !!window.appMode?.offline;
    btn.classList.toggle('active', offline);
    btn.setAttribute('aria-pressed', offline ? 'true' : 'false');
    label.textContent = offline ? 'Offline' : 'Online';
    icon.setAttribute('data-lucide', offline ? 'cloud-off' : 'cloud');
    window.lucide?.createIcons({ nodes: [btn] });
  };

  btn.onclick = () => {
    toggleOfflineMode();
    sync();
    showToast(window.appMode?.offline ? 'Offline mode enabled' : 'Online mode enabled', window.appMode?.offline ? 'cloud-off' : 'cloud');
    refreshActiveView();
  };

  window.addEventListener('ikl:modeChanged', () => {
    sync();
    refreshActiveView();
  });

  sync();
}
