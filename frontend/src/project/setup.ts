export interface ProjectSetup {
  version: 1;
  script: string;
  brandName: string;
  guidelines: string;
  paletteId: string;
  primaryColor: string;
  accentHover: string;
  accentGlow: string;
  captionFont: string;
  keywords: string[];
  tone: string;
  pacing: string;
  createdAt: number;
}

declare global {
  interface Window {
    iklippaProjectSetup?: ProjectSetup | null;
    openProjectOnboarding?: () => void;
  }
}

const STORAGE_KEY = 'iklippa.project-setup.v1';

const PALETTES = [
  {
    id: 'township-teal',
    name: 'Township Teal',
    description: 'Clear, energetic and documentary-ready.',
    primary: '#0d9488',
    hover: '#14b8a6',
    glow: 'rgba(13,148,136,0.22)',
    swatches: ['#0d9488', '#9dd9d1', '#f5c451'],
  },
  {
    id: 'sunset-red',
    name: 'Jozi Sunset',
    description: 'Warm, bold and made for personality.',
    primary: '#e11d48',
    hover: '#f43f5e',
    glow: 'rgba(225,29,72,0.22)',
    swatches: ['#e11d48', '#fb7185', '#fbbf24'],
  },
  {
    id: 'ocean-blue',
    name: 'Cape Atlantic',
    description: 'Confident, polished and cinematic.',
    primary: '#2563eb',
    hover: '#3b82f6',
    glow: 'rgba(37,99,235,0.22)',
    swatches: ['#2563eb', '#38bdf8', '#e2e8f0'],
  },
  {
    id: 'earth-gold',
    name: 'Highveld Gold',
    description: 'Natural, grounded and editorial.',
    primary: '#d97706',
    hover: '#f59e0b',
    glow: 'rgba(217,119,6,0.22)',
    swatches: ['#d97706', '#fbbf24', '#84a98c'],
  },
] as const;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'before', 'being',
  'but', 'can', 'could', 'does', 'for', 'from', 'have', 'into', 'just', 'like', 'more',
  'not', 'our', 'out', 'over', 'that', 'the', 'their', 'then', 'there', 'they', 'this',
  'through', 'under', 'very', 'was', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'will', 'with', 'would', 'you', 'your',
]);

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function extractProjectKeywords(script: string, limit = 6): string[] {
  const counts = new Map<string, number>();
  const words = script.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  for (const raw of words) {
    const word = raw.replace(/^['-]+|['-]+$/g, '');
    if (!word || STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function inferTone(script: string, guidelines: string): string {
  const copy = `${script} ${guidelines}`.toLowerCase();
  if (/(joy|bright|fun|dance|energy|celebrat|upbeat)/.test(copy)) return 'Energetic and uplifting';
  if (/(document|educat|explain|research|history|learn)/.test(copy)) return 'Clear and informative';
  if (/(luxury|premium|cinematic|elegant|refined)/.test(copy)) return 'Cinematic and refined';
  if (/(urgent|bold|fast|impact|action)/.test(copy)) return 'Bold and direct';
  return 'Natural and confident';
}

function inferPacing(script: string): string {
  const sentences = script.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean);
  if (sentences.length === 0) return 'Balanced pacing';
  const averageWords = sentences.reduce((total, sentence) => {
    return total + sentence.split(/\s+/).filter(Boolean).length;
  }, 0) / sentences.length;
  if (averageWords <= 9) return 'Fast, punchy cuts';
  if (averageWords >= 20) return 'Measured, story-led pacing';
  return 'Balanced conversational pacing';
}

export function buildProjectSetup(input: {
  script: string;
  brandName: string;
  guidelines: string;
  paletteId: string;
  captionFont?: string;
}): ProjectSetup {
  const palette = PALETTES.find((item) => item.id === input.paletteId) ?? PALETTES[0];
  const script = input.script.trim();
  const guidelines = input.guidelines.trim();
  return {
    version: 1,
    script,
    brandName: input.brandName.trim() || 'Untitled brand',
    guidelines,
    paletteId: palette.id,
    primaryColor: palette.primary,
    accentHover: palette.hover,
    accentGlow: palette.glow,
    captionFont: input.captionFont?.trim() || 'Plus Jakarta Sans',
    keywords: extractProjectKeywords(`${script} ${guidelines}`),
    tone: inferTone(script, guidelines),
    pacing: inferPacing(script),
    createdAt: Date.now(),
  };
}

export function loadProjectSetup(): ProjectSetup | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || 'null') as ProjectSetup | null;
    if (!parsed || parsed.version !== 1 || !parsed.script) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveProjectSetup(setup: ProjectSetup): void {
  safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(setup));
}

function populateExistingPanels(setup: ProjectSetup): void {
  const scriptArea = document.querySelector<HTMLTextAreaElement>('#project-script-input, .script-area');
  if (scriptArea) scriptArea.value = setup.script;
  const brandName = document.querySelector<HTMLInputElement>('#project-brand-name');
  if (brandName) brandName.value = setup.brandName;
  const brandGuidelines = document.querySelector<HTMLTextAreaElement>('#project-brand-guidelines');
  if (brandGuidelines) brandGuidelines.value = setup.guidelines;
  const brandFont = document.querySelector<HTMLInputElement>('#project-caption-font');
  if (brandFont) brandFont.value = setup.captionFont;
}

export function applyProjectSetup(setup: ProjectSetup): void {
  window.iklippaProjectSetup = setup;
  const root = document.documentElement;
  root.style.setProperty('--accent-primary', setup.primaryColor);
  root.style.setProperty('--accent-hover', setup.accentHover);
  root.style.setProperty('--accent-glow', setup.accentGlow);
  populateExistingPanels(setup);
  window.dispatchEvent(new CustomEvent('ikl:projectSetupChanged', { detail: setup }));
}

function paletteMarkup(): string {
  return PALETTES.map((palette, index) => `
    <label class="onboarding-palette${index === 0 ? ' selected' : ''}">
      <input type="radio" name="onboarding-palette" value="${palette.id}" ${index === 0 ? 'checked' : ''}>
      <span class="onboarding-swatches">
        ${palette.swatches.map((colour) => `<span style="background:${colour}"></span>`).join('')}
      </span>
      <strong>${palette.name}</strong>
      <small>${palette.description}</small>
    </label>
  `).join('');
}

function setupMarkup(): string {
  return `
    <section class="project-onboarding" id="project-onboarding" aria-labelledby="onboarding-title">
      <div class="onboarding-ambient onboarding-ambient-one"></div>
      <div class="onboarding-ambient onboarding-ambient-two"></div>
      <div class="onboarding-shell">
        <header class="onboarding-header">
          <div class="onboarding-wordmark">
            <img src="/logo.png" alt="iKlippa">
            <span>Project setup</span>
          </div>
          <div class="onboarding-step"><span>01</span> Shape the edit</div>
        </header>
        <form class="onboarding-grid" id="project-onboarding-form">
          <div class="onboarding-copy">
            <p class="onboarding-kicker">Before the first cut</p>
            <h1 id="onboarding-title">Give your edit a point of view.</h1>
            <p class="onboarding-lede">Your script and brand become context for Granite, stock suggestions, pacing, and every creative decision that follows.</p>
            <label class="onboarding-field onboarding-script-field">
              <span>Script or creative brief <b>Required</b></span>
              <textarea id="onboarding-script" required placeholder="Paste the story, voiceover, or rough idea for this edit..."></textarea>
            </label>
            <div class="onboarding-field-row">
              <label class="onboarding-field">
                <span>Brand name</span>
                <input id="onboarding-brand-name" type="text" placeholder="Your channel or studio">
              </label>
              <label class="onboarding-field">
                <span>Caption font</span>
                <input id="onboarding-caption-font" type="text" value="Plus Jakarta Sans">
              </label>
            </div>
            <label class="onboarding-field">
              <span>Brand guidelines</span>
              <textarea id="onboarding-guidelines" placeholder="Tone, audience, words to avoid, visual rules..."></textarea>
            </label>
          </div>
          <aside class="onboarding-direction">
            <div>
              <p class="onboarding-kicker">Choose a visual rhythm</p>
              <h2>Colour that carries through.</h2>
            </div>
            <div class="onboarding-palettes">${paletteMarkup()}</div>
            <div class="onboarding-brief-preview" aria-live="polite">
              <div class="onboarding-brief-icon">✦</div>
              <div>
                <strong>Your edit brief</strong>
                <p id="onboarding-brief-copy">Add your script and iKlippa will map its tone, pacing, and visual keywords.</p>
              </div>
            </div>
            <button class="onboarding-submit" type="submit">
              <span>Build my editing space</span>
              <span aria-hidden="true">→</span>
            </button>
            <p class="onboarding-local-note">Stored locally on this device. Nothing is uploaded.</p>
          </aside>
        </form>
      </div>
    </section>
  `;
}

function updateBriefPreview(): void {
  const script = document.querySelector<HTMLTextAreaElement>('#onboarding-script')?.value ?? '';
  const guidelines = document.querySelector<HTMLTextAreaElement>('#onboarding-guidelines')?.value ?? '';
  const preview = document.querySelector<HTMLElement>('#onboarding-brief-copy');
  if (!preview) return;
  if (!script.trim()) {
    preview.textContent = 'Add your script and iKlippa will map its tone, pacing, and visual keywords.';
    return;
  }
  const keywords = extractProjectKeywords(`${script} ${guidelines}`, 3);
  preview.textContent = `${inferTone(script, guidelines)} · ${inferPacing(script)}${keywords.length ? ` · ${keywords.join(', ')}` : ''}`;
}

function bindOnboarding(overlay: HTMLElement): void {
  const form = overlay.querySelector<HTMLFormElement>('#project-onboarding-form');
  const script = overlay.querySelector<HTMLTextAreaElement>('#onboarding-script');
  const guidelines = overlay.querySelector<HTMLTextAreaElement>('#onboarding-guidelines');
  const palettes = overlay.querySelectorAll<HTMLElement>('.onboarding-palette');

  script?.addEventListener('input', updateBriefPreview);
  guidelines?.addEventListener('input', updateBriefPreview);
  for (const palette of palettes) {
    palette.addEventListener('click', () => {
      palettes.forEach((item) => item.classList.remove('selected'));
      palette.classList.add('selected');
    });
  }

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const selectedPalette = overlay.querySelector<HTMLInputElement>('input[name="onboarding-palette"]:checked');
    const setup = buildProjectSetup({
      script: script?.value ?? '',
      brandName: overlay.querySelector<HTMLInputElement>('#onboarding-brand-name')?.value ?? '',
      guidelines: guidelines?.value ?? '',
      paletteId: selectedPalette?.value ?? PALETTES[0].id,
      captionFont: overlay.querySelector<HTMLInputElement>('#onboarding-caption-font')?.value,
    });
    saveProjectSetup(setup);
    applyProjectSetup(setup);
    overlay.classList.add('leaving');
    document.body.classList.remove('onboarding-open');
    window.setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove('leaving');
    }, 520);
  });
}

export function initProjectOnboarding(): void {
  const existing = loadProjectSetup();
  if (existing) {
    applyProjectSetup(existing);
    return;
  }

  const host = document.createElement('div');
  host.innerHTML = setupMarkup();
  const overlay = host.firstElementChild as HTMLElement | null;
  if (!overlay) return;
  document.body.appendChild(overlay);
  document.body.classList.add('onboarding-open');
  bindOnboarding(overlay);

  window.openProjectOnboarding = () => {
    overlay.hidden = false;
    document.body.classList.add('onboarding-open');
    requestAnimationFrame(() => overlay.classList.remove('leaving'));
  };
}
