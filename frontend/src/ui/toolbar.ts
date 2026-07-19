import { $, $$, S, aiNodes } from './state';
import { showToast, resizeCanvas } from './utils';
import { calculateTimelineDuration, renderRuler, renderClips, updatePlayhead, applyAiAction } from './timeline';

let isTextActive = false;
let isEffectActive = false;

export function initToolbar() {
  const btnText = $('#t-text');
  if (btnText) {
    btnText.onclick = () => {
      isTextActive = !isTextActive;
      btnText.classList.toggle('active');
      $('#canvas-text')?.classList.toggle('active');
      showToast(isTextActive ? 'Text Overlay Enabled' : 'Text Overlay Disabled', 'type');
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
    };
  });

  initChat();
  initAspectRatio();
}

function initChat() {
  const cmdInput = $('#ai-cmd') as HTMLInputElement;
  const acMenu = $('#ac-menu');

  if (!cmdInput || !acMenu) return;

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
        `<div class="ac-item" onclick="insertAC('@${c.name.replace(/[^a-zA-Z0-9_]/g, '_')} ')"><i data-lucide="film"></i> @${c.name}</div>`
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
    const val = cmdInput.value.trim();
    if (!val) return;
    if (val.startsWith('/') || val.includes('@')) {
      appendChat(val, true);
      cmdInput.value = '';
      setTimeout(() => {
        if (val.includes('/trim-silence')) applyAiAction('silence');
        else if (val.includes('/sync-audio')) applyAiAction('sync');
        else if (val.includes('/add-captions')) applyAiAction('captions');
        else appendChat('Command processed.');
      }, 600);
      return;
    }
    cmdInput.value = '';
    appendChat(val, true);
    setTimeout(() => {
      if (val.toLowerCase().includes('silence') || val.toLowerCase().includes('trim'))
        applyAiAction('silence');
      else if (val.toLowerCase().includes('caption') || val.toLowerCase().includes('text'))
        applyAiAction('captions');
      else if (val.toLowerCase().includes('sync') || val.toLowerCase().includes('beat'))
        applyAiAction('sync');
      else
        appendChat("I can help with that. Try asking me to 'Trim silences', 'Sync to beat', or 'Add captions'.");
    }, 600);
  };

  cmdInput.onkeypress = (e) => {
    if (e.key === 'Enter') (window as any).submitCmd();
  };
}

function appendChat(text: string, isUser = false) {
  const el = document.createElement('div');
  el.className = 'chat-msg ' + (isUser ? 'user' : 'ai');
  el.innerHTML = isUser
    ? text
    : `<div class="msg-sender"><i data-lucide="bot"></i> Granite</div>${text}`;
  const log = $('#chat-log');
  if (log) {
    log.appendChild(el);
    window.lucide.createIcons({ nodes: [el] });
    if (log.parentElement) {
      log.parentElement.scrollTop = log.parentElement.scrollHeight;
    }
  }
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
