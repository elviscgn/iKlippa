let _nextLutId = 100;
let _loadedLuts: Array<{ id: number; name: string }> = [];

export function initLutPanel(): void {
  const importBtn = document.getElementById('import-lut-btn');
  const lutSelect = document.getElementById('lut-select') as HTMLSelectElement;
  const intensitySlider = document.getElementById('lut-intensity') as HTMLInputElement;
  const intensityVal = document.getElementById('lut-intensity-val');

  importBtn?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cube';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const worker = (window as any).__iklippaWorker;
        if (!worker) {
          console.warn('[LUT] worker not available');
          return;
        }
        const id = _nextLutId++;
        worker.postMessage({ type: 'load_lut', id, data: buf }, [buf]);
        _loadedLuts.push({ id, name: file.name.replace(/\.cube$/i, '') });
        rebuildLutDropdown();
        const status = document.getElementById('lut-status');
        if (status) {
          status.textContent = `Loaded: ${_loadedLuts.map((l) => l.name).join(', ')}`;
          document.getElementById('lut-status-row')!.style.display = 'block';
        }
        (window as any).showToast?.(`LUT "${file.name}" loaded`, 'palette');
      } catch (e) {
        console.warn('[LUT] import failed:', e);
      }
    };
    input.click();
  });

  lutSelect?.addEventListener('change', () => {
    const val = lutSelect.value;
    applyLutToSelectedClip(val ? parseInt(val) : 0);
  });

  intensitySlider?.addEventListener('input', () => {
    if (intensityVal) intensityVal.textContent = intensitySlider.value + '%';
    applyLutToSelectedClip(currentSelectedLutId());
  });
}

function currentSelectedLutId(): number {
  const lutSelect = document.getElementById('lut-select') as HTMLSelectElement;
  const val = lutSelect?.value;
  return val ? parseInt(val) : 0;
}

function getSelectedClipId(): number | null {
  const sel = (window as any).selectedClipIds;
  if (!sel || sel.size === 0) return null;
  return [...sel][0] as number;
}

function applyLutToSelectedClip(lutId: number): void {
  const clipId = getSelectedClipId();
  if (clipId === null) return;
  const IK = (window as any).IKState;
  if (!IK) return;
  const clip = IK.findClip(clipId);
  if (!clip) return;

  const intensitySlider = document.getElementById('lut-intensity') as HTMLInputElement;
  const intensity = intensitySlider ? parseInt(intensitySlider.value) / 100 : 1.0;

  if (lutId === 0) {
    // Remove LUT effect
    clip.effects = (clip.effects || []).filter(
      (e: any) => e.effect_type !== 'lut',
    );
  } else {
    const existing = (clip.effects || []).find((e: any) => e.effect_type === 'lut');
    if (existing) {
      existing.params = { kind: 'LUT', lut_id: lutId, intensity };
      existing.intensity = intensity;
    } else {
      clip.effects = [
        ...(clip.effects || []),
        {
          id: Date.now(),
          effect_type: 'lut',
          params: { kind: 'LUT', lut_id: lutId, intensity },
          intensity,
          enabled: true,
        },
      ];
    }
  }

  const worker = (window as any).__iklippaWorker;
  if (worker) {
    worker.postMessage({ type: 'set_clip_effects', clip_id: clipId, json: JSON.stringify(clip.effects) });
  }
}

function rebuildLutDropdown(): void {
  const lutSelect = document.getElementById('lut-select') as HTMLSelectElement;
  if (!lutSelect) return;
  const current = lutSelect.value;
  lutSelect.innerHTML = '<option value="">None</option>';
  for (const lut of _loadedLuts) {
    const opt = document.createElement('option');
    opt.value = String(lut.id);
    opt.textContent = lut.name;
    lutSelect.appendChild(opt);
  }
  lutSelect.value = current;
}

export function showLutPanel(): void {
  const panel = document.getElementById('lut-panel');
  if (panel) panel.style.display = 'block';
}

export function hideLutPanel(): void {
  const panel = document.getElementById('lut-panel');
  if (panel) panel.style.display = 'none';
}

export function reflectClipEffects(clip: any): void {
  const lutSelect = document.getElementById('lut-select') as HTMLSelectElement;
  const intensitySlider = document.getElementById('lut-intensity') as HTMLInputElement;
  const intensityVal = document.getElementById('lut-intensity-val');
  if (!lutSelect || !intensitySlider) return;

  const lutEffect = (clip?.effects || []).find((e: any) => e.effect_type === 'lut');
  if (lutEffect) {
    lutSelect.value = String(lutEffect.params?.lut_id ?? '');
    const i = Math.round((lutEffect.params?.intensity ?? 1) * 100);
    intensitySlider.value = String(i);
    if (intensityVal) intensityVal.textContent = i + '%';
  } else {
    lutSelect.value = '';
    intensitySlider.value = '100';
    if (intensityVal) intensityVal.textContent = '100%';
  }
  showLutPanel();
}
