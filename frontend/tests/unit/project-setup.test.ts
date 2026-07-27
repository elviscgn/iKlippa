// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProjectSetup,
  buildProjectSetup,
  loadProjectSetup,
  saveProjectSetup,
} from '../../src/project/setup';

describe('project setup', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, String(value)),
    } satisfies Storage);
    localStorage.clear();
    document.body.innerHTML = `
      <textarea id="project-script-input"></textarea>
      <input id="project-brand-name">
      <textarea id="project-brand-guidelines"></textarea>
      <input id="project-caption-font">
      <section id="project-brief-card" hidden>
        <p id="project-brief-summary"></p>
        <div id="project-brief-keywords"></div>
      </section>
    `;
  });

  it('derives and persists an edit brief from onboarding fields', () => {
    const setup = buildProjectSetup({
      script: 'Fast dance energy in Johannesburg. Dance with bright energy.',
      brandName: 'Mzansi Motion',
      guidelines: 'Keep it joyful and use warm documentary shots.',
      paletteId: 'sunset-red',
      captionFont: 'Archivo Black',
    });

    saveProjectSetup(setup);

    expect(loadProjectSetup()).toMatchObject({
      brandName: 'Mzansi Motion',
      paletteId: 'sunset-red',
      tone: 'Energetic and uplifting',
      captionFont: 'Archivo Black',
    });
    expect(setup.keywords).toContain('dance');
  });

  it('applies saved setup to the editor and local theme', () => {
    const setup = buildProjectSetup({
      script: 'A measured history of local design and culture.',
      brandName: 'Archive',
      guidelines: 'Clear, educational, and calm.',
      paletteId: 'ocean-blue',
    });

    applyProjectSetup(setup);

    expect(window.iklippaProjectSetup).toBe(setup);
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('#2563eb');
    expect((document.querySelector('#project-script-input') as HTMLTextAreaElement).value).toBe(setup.script);
    expect((document.querySelector('#project-brand-name') as HTMLInputElement).value).toBe('Archive');
    expect(document.querySelector('#project-brief-card')?.hasAttribute('hidden')).toBe(false);
  });
});
