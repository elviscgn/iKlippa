import { warmGraniteModel } from '../ai/granite';
import { listStoredSourceIds, requestDurableStorage } from '../media/mediaStore';
import { waitForSourcePersistence } from '../media/sourceRegistry';
import { isAppShellCached, registerAppShell } from './appShell';

export interface OfflineReadiness {
  ready: boolean;
  graniteReady: boolean;
  mediaReady: boolean;
  appShellReady: boolean;
  requiredMedia: string[];
  missingMedia: string[];
  detail: string;
}

declare global {
  interface Window {
    verifyOfflineReadiness?: () => Promise<OfflineReadiness>;
  }
}

export function getProjectSourceIds(): string[] {
  const state = window.IKState;
  if (!state?.isReady?.()) return [];
  const sourceIds = new Set<string>();
  for (const track of state.getTracks?.() ?? []) {
    if (track.track_type === 'caption') continue;
    for (const clip of track.clips ?? []) {
      if (clip.source_id) sourceIds.add(clip.source_id);
    }
  }
  return [...sourceIds];
}

export async function verifyOfflineReadiness(): Promise<OfflineReadiness> {
  const requiredMedia = getProjectSourceIds();
  await Promise.all(requiredMedia.map((sourceId) => waitForSourcePersistence(sourceId)));
  void requestDurableStorage().catch(() => false);

  const [graniteResult, shellResult, storedIds] = await Promise.all([
    warmGraniteModel().then(() => true).catch(() => false),
    registerAppShell()
      .then(() => isAppShellCached())
      .catch(() => false),
    listStoredSourceIds().catch(() => []),
  ]);

  const stored = new Set(storedIds);
  const missingMedia = requiredMedia.filter((sourceId) => !stored.has(sourceId));
  const mediaReady = missingMedia.length === 0;
  const ready = graniteResult && shellResult && mediaReady;
  const missing: string[] = [];
  if (!graniteResult) missing.push('Granite Nano');
  if (!shellResult) missing.push('app shell');
  if (!mediaReady) {
    missing.push(`${missingMedia.length} media source${missingMedia.length === 1 ? '' : 's'}`);
  }

  return {
    ready,
    graniteReady: graniteResult,
    mediaReady,
    appShellReady: shellResult,
    requiredMedia,
    missingMedia,
    detail: ready ? 'Granite, the editor, and project media are cached.' : `Still needed: ${missing.join(', ')}.`,
  };
}

if (typeof window !== 'undefined') {
  window.verifyOfflineReadiness = verifyOfflineReadiness;
}
