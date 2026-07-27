import { loadStoredSourceFiles, persistSourceFile } from './mediaStore';

const sourceFiles = new Map<string, File>();
const sourceAudio = new Map<string, Promise<AudioBuffer>>();
const sourcePersistence = new Map<string, Promise<boolean>>();
let analysisContext: AudioContext | null = null;

function getAnalysisContext(): AudioContext {
  if (analysisContext) return analysisContext;
  const AudioContextCtor = window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error('This browser cannot decode audio for local analysis.');
  analysisContext = new AudioContextCtor();
  return analysisContext;
}

export function registerSourceFile(sourceId: string, file: File): void {
  sourceFiles.set(sourceId, file);
  sourceAudio.delete(sourceId);
  const persistence = typeof indexedDB === 'undefined'
    ? Promise.resolve(false)
    : persistSourceFile(sourceId, file)
    .then(() => {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('ikl:sourceCached', {
          detail: { sourceId, fileName: file.name, size: file.size, type: file.type },
        }));
      }
      return true;
    })
    .catch((error) => {
      console.warn(`[iKlippa:media] Could not cache ${file.name}:`, error);
      return false;
    });
  sourcePersistence.set(sourceId, persistence);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('ikl:sourceRegistered', {
      detail: { sourceId, fileName: file.name, size: file.size, type: file.type },
    }));
  }
}

export function registerSourceAudioBuffer(sourceId: string, buffer: AudioBuffer): void {
  sourceAudio.set(sourceId, Promise.resolve(buffer));
}

export function getRegisteredSourceFile(sourceId: string): File | null {
  return sourceFiles.get(sourceId) ?? null;
}

export function listRegisteredSourceIds(): string[] {
  return [...new Set([...sourceFiles.keys(), ...sourceAudio.keys()])];
}

export function hasRegisteredSource(sourceId: string): boolean {
  return sourceFiles.has(sourceId) || sourceAudio.has(sourceId);
}

async function restoreSourceFile(sourceId: string): Promise<File | null> {
  if (sourceFiles.has(sourceId)) return sourceFiles.get(sourceId) ?? null;
  const stored = await loadStoredSourceFiles([sourceId]).catch(() => []);
  const restored = stored[0]?.file ?? null;
  if (restored) sourceFiles.set(sourceId, restored);
  return restored;
}

export async function resolveSourceForAnalysis(
  preferredSourceId: string,
  kind: 'video' | 'audio' | 'any' = 'any',
): Promise<string | null> {
  if (hasRegisteredSource(preferredSourceId)) return preferredSourceId;
  if (await restoreSourceFile(preferredSourceId)) return preferredSourceId;

  const candidates = [...sourceFiles.entries()]
    .filter(([, file]) => {
      if (kind === 'any') return file.type.startsWith('video/') || file.type.startsWith('audio/');
      return file.type.startsWith(`${kind}/`);
    })
    .map(([sourceId]) => sourceId);
  return candidates.length === 1 ? candidates[0]! : null;
}

export async function waitForSourcePersistence(sourceId: string): Promise<boolean> {
  const pending = sourcePersistence.get(sourceId);
  if (!pending) return false;
  return pending;
}

export async function getSourceAudioBuffer(sourceId: string): Promise<AudioBuffer> {
  const existing = sourceAudio.get(sourceId);
  if (existing) return existing;
  const file = sourceFiles.get(sourceId) ?? await restoreSourceFile(sourceId);
  if (!file) throw new Error('The original media file is not available for audio analysis.');

  const decode = (async () => {
    const context = getAnalysisContext();
    if (context.state === 'suspended') await context.resume().catch(() => undefined);
    const bytes = await file.arrayBuffer();
    return context.decodeAudioData(bytes.slice(0));
  })();
  sourceAudio.set(sourceId, decode);
  try {
    return await decode;
  } catch (error) {
    sourceAudio.delete(sourceId);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not decode this clip's audio for analysis: ${message}`);
  }
}

export function clearSourceRegistry(): void {
  sourceFiles.clear();
  sourceAudio.clear();
  sourcePersistence.clear();
}
