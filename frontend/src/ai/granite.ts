import type { ClipWithMeta, Track } from '../state/types';

type GraniteRole = 'system' | 'user' | 'assistant';

export interface GraniteMessage {
  role: GraniteRole;
  content: string;
}

export interface GraniteSendOptions {
  onChunk?: (chunk: string) => void;
}

export interface GraniteLoadProgress {
  status?: 'initiate' | 'download' | 'progress' | 'done' | 'ready' | string;
  progress?: number;
  loaded?: number;
  total?: number;
  file?: string;
  name?: string;
  task?: string;
  model?: string;
  [key: string]: unknown;
}

export interface GraniteLoadState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  title: string;
  detail: string;
  percent: number | null;
}

type GraniteWorkerRequest =
  | { type: 'warm' }
  | { type: 'generate'; id: number; messages: GraniteMessage[] };

type GraniteWorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; progress: GraniteLoadProgress }
  | { type: 'chunk'; id: number; chunk: string }
  | { type: 'result'; id: number; output: unknown }
  | { type: 'error'; id?: number; message: string };

type PendingGraniteRequest = {
  onChunk?: (chunk: string) => void;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
};

const MAX_HISTORY_MESSAGES = 10;
const MAX_TRACK_LINES = 6;
const MAX_SELECTED_CLIPS = 5;
const MAX_CURRENT_CLIPS = 4;
const MAX_NEARBY_CLIPS = 5;
const PLAYHEAD_CONTEXT_WINDOW_US = 5_000_000;
const GRANITE_CACHE_MISS_MESSAGE =
  'Granite has not been cached in this browser yet. Open the app once while online so Transformers.js can download and cache the model, then offline chat will work.';
const GRANITE_IDLE_STATE: GraniteLoadState = {
  phase: 'idle',
  title: 'Granite is idle',
  detail: 'Focus the chat box to warm the local model.',
  percent: null,
};

let graniteLoadError: Error | null = null;
let conversationHistory: GraniteMessage[] = [];
let graniteWorker: Worker | null = null;
let graniteWorkerReady = false;
let graniteLoadPromise: Promise<void> | null = null;
let graniteWarmResolve: (() => void) | null = null;
let graniteWarmReject: ((error: Error) => void) | null = null;
let graniteLifecycleBound = false;
let nextGraniteRequestId = 1;
const pendingGraniteRequests = new Map<number, PendingGraniteRequest>();
let graniteLoadState: GraniteLoadState = GRANITE_IDLE_STATE;
let graniteLoadStateListener: ((state: GraniteLoadState) => void) | null = null;

function createGraniteWorker(): Worker {
  const worker = new Worker(new URL('./granite.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.addEventListener('message', handleGraniteWorkerMessage);
  worker.addEventListener('error', handleGraniteWorkerError);
  return worker;
}

function getGraniteWorker(): Worker {
  if (!graniteWorker) {
    graniteWorker = createGraniteWorker();
  }
  return graniteWorker;
}

function resetGraniteWorkerState(errorMessage: string) {
  const resetError = new Error(errorMessage);

  if (graniteWarmReject) {
    rejectGraniteWarm(resetError);
  }

  if (pendingGraniteRequests.size > 0) {
    for (const id of [...pendingGraniteRequests.keys()]) {
      rejectGraniteRequest(id, resetError);
    }
  }

  try {
    graniteWorker?.terminate();
  } catch {
    // Ignore worker shutdown noise during page restore.
  }

  graniteWorker = null;
  graniteWorkerReady = false;
  graniteLoadPromise = null;
  graniteWarmResolve = null;
  graniteWarmReject = null;
  graniteLoadError = null;
  emitGraniteLoadState(GRANITE_IDLE_STATE);
}

function installGraniteLifecycleHooks() {
  if (graniteLifecycleBound || typeof window === 'undefined') return;
  graniteLifecycleBound = true;

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    resetGraniteWorkerState(
      'Granite was paused while this tab was cached. Send the prompt again to restart it.',
    );
  });
}

installGraniteLifecycleHooks();

function emitGraniteLoadState(next: GraniteLoadState) {
  graniteLoadState = next;
  graniteLoadStateListener?.(next);
}

function progressLabel(progress: GraniteLoadProgress): string {
  const raw = progress.file ?? progress.name ?? progress.model ?? progress.task ?? 'Granite';
  const cleaned = cleanText(raw);
  if (!cleaned) return 'Granite';
  return cleaned.length > 44 ? cleaned.slice(0, 43) + '...' : cleaned;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function formatGraniteLoadState(progress: GraniteLoadProgress): GraniteLoadState {
  const percent =
    typeof progress.progress === 'number' && Number.isFinite(progress.progress)
      ? Math.max(0, Math.min(100, Math.round(progress.progress)))
      : null;
  const label = progressLabel(progress);
  const loadedBytes =
    typeof progress.loaded === 'number' && Number.isFinite(progress.loaded) ? formatBytes(progress.loaded) : '';
  const totalBytes =
    typeof progress.total === 'number' && Number.isFinite(progress.total) ? formatBytes(progress.total) : '';
  const byteSummary = loadedBytes && totalBytes ? `${loadedBytes} / ${totalBytes}` : loadedBytes || totalBytes;

  switch (progress.status) {
    case 'initiate':
      return {
        phase: 'loading',
        title: 'Preparing Granite locally',
        detail: `Starting ${label}`,
        percent: percent ?? 0,
      };
    case 'download':
      return {
        phase: 'loading',
        title: 'Downloading Granite locally',
        detail: byteSummary || `Fetching ${label}`,
        percent: percent ?? 0,
      };
    case 'progress':
      return {
        phase: 'loading',
        title: 'Downloading Granite locally',
        detail: byteSummary || `${percent ?? 0}% complete`,
        percent: percent ?? 0,
      };
    case 'done':
      return {
        phase: 'loading',
        title: 'Caching Granite locally',
        detail: `Finalizing ${label}`,
        percent: 100,
      };
    case 'ready':
      return {
        phase: 'ready',
        title: 'Granite is ready locally',
        detail: 'Cached and ready to chat.',
        percent: 100,
      };
    default:
      return {
        phase: 'loading',
        title: 'Loading Granite locally',
        detail: `Warming ${label}`,
        percent,
      };
  }
}

function resetGraniteWarmState() {
  graniteLoadPromise = null;
  graniteWarmResolve = null;
  graniteWarmReject = null;
}

function resolveGraniteWarm() {
  const resolve = graniteWarmResolve;
  resetGraniteWarmState();
  graniteWorkerReady = true;
  graniteLoadError = null;
  emitGraniteLoadState({
    phase: 'ready',
    title: 'Granite is ready locally',
    detail: 'Cached and ready to chat.',
    percent: 100,
  });
  resolve?.();
}

function rejectGraniteWarm(error: Error) {
  const reject = graniteWarmReject;
  resetGraniteWarmState();
  graniteWorkerReady = false;
  graniteLoadError = error;
  emitGraniteLoadState({
    phase: 'error',
    title: 'Granite failed to load',
    detail: error.message,
    percent: null,
  });
  reject?.(error);
}

function rejectGraniteRequest(id: number, error: Error) {
  const pending = pendingGraniteRequests.get(id);
  if (!pending) return;
  pendingGraniteRequests.delete(id);
  pending.reject(error);
}

function handleGraniteWorkerMessage(event: MessageEvent<GraniteWorkerResponse>) {
  const data = event.data;
  if (!data || typeof data !== 'object' || !('type' in data)) return;

  if (data.type === 'progress') {
    emitGraniteLoadState(formatGraniteLoadState(data.progress));
    return;
  }

  if (data.type === 'ready') {
    resolveGraniteWarm();
    return;
  }

  if (data.type === 'chunk') {
    const pending = pendingGraniteRequests.get(data.id);
    pending?.onChunk?.(data.chunk);
    return;
  }

  if (data.type === 'result') {
    const pending = pendingGraniteRequests.get(data.id);
    if (!pending) return;
    pendingGraniteRequests.delete(data.id);
    const response = typeof data.output === 'string' ? data.output.trim() : normalizeResponseText(data.output);
    pending.resolve(response);
    return;
  }

  if (data.type === 'error') {
    const normalizedError = graniteLoadHint(new Error(data.message));
    graniteLoadError = normalizedError;
    if (data.id !== undefined) {
      rejectGraniteRequest(data.id, normalizedError);
    }
    rejectGraniteWarm(normalizedError);
    if (normalizedError.message === GRANITE_CACHE_MISS_MESSAGE) {
      graniteWorkerReady = false;
    }
  }
}

function handleGraniteWorkerError(event: ErrorEvent) {
  const normalizedError = graniteLoadHint(event.error ?? event.message ?? 'Granite worker failed.');
  graniteLoadError = normalizedError;
  rejectGraniteWarm(normalizedError);
  if (pendingGraniteRequests.size > 0) {
    for (const id of [...pendingGraniteRequests.keys()]) {
      rejectGraniteRequest(id, normalizedError);
    }
  }
}

function trimHistory() {
  if (conversationHistory.length <= MAX_HISTORY_MESSAGES) return;
  conversationHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES);
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function shortText(text: unknown, max = 72): string {
  const cleaned = cleanText(text);
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '...' : cleaned;
}

function toClipId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatTimeRange(startUs: number, endUs: number): string {
  return `${(startUs / 1_000_000).toFixed(2)}-${(endUs / 1_000_000).toFixed(2)}s`;
}

function getSelectedClipIds(): number[] {
  const ids = new Set<number>();
  const windowSelection = (window as Window & { selectedClipIds?: Set<number | string> })
    .selectedClipIds;
  if (windowSelection?.size) {
    for (const raw of windowSelection) {
      const id = toClipId(raw);
      if (id !== null) ids.add(id);
    }
  }

  document.querySelectorAll('.tl-clip.active').forEach((el) => {
    const id = toClipId((el as HTMLElement).dataset.clipId);
    if (id !== null) ids.add(id);
  });

  return [...ids];
}

function getClipEntries(): Array<{ track: Track; clip: ClipWithMeta; meta: Record<string, unknown> | null }> {
  const state = window.IKState;
  if (!state?.isReady()) return [];

  const tracks = state.getTracks?.() ?? [];
  const entries: Array<{ track: Track; clip: ClipWithMeta; meta: Record<string, unknown> | null }> = [];
  for (const track of tracks) {
    for (const clip of track.clips ?? []) {
      entries.push({
        track,
        clip: clip as ClipWithMeta,
        meta: state.getClipMeta?.(clip.id) ?? null,
      });
    }
  }
  return entries;
}

function clipLabel(
  clip: ClipWithMeta,
  meta: Record<string, unknown> | null,
  track: Track,
): string {
  if (track.track_type === 'caption') {
    return shortText(clip.caption_text || meta?.name || clip.source_id || `Clip ${clip.id}`, 56);
  }
  return shortText(meta?.name || clip.caption_text || clip.source_id || `Clip ${clip.id}`, 56);
}

function formatClipLine(
  clip: ClipWithMeta,
  track: Track,
  meta: Record<string, unknown> | null,
): string {
  const details: string[] = [`${formatTimeRange(clip.timeline_start_us, clip.timeline_end_us)}`];
  details.push(`src=${shortText(clip.source_id, 20)}`);

  if (track.track_type !== 'caption' && clip.caption_text) {
    details.push(`caption="${shortText(clip.caption_text, 44)}"`);
  }
  if (meta?.name && shortText(meta.name, 56) !== clipLabel(clip, meta, track)) {
    details.push(`name="${shortText(meta.name, 32)}"`);
  }
  if (meta?.isReal === true) details.push('real');
  if (meta?.isReal === false) details.push('stock');
  if (typeof meta?.picId === 'number') details.push(`picId=${meta.picId}`);
  const thumbnails = Array.isArray(meta?.thumbnails) ? meta.thumbnails : [];
  if (thumbnails.length > 0) {
    details.push(`${thumbnails.length} thumbs`);
  }
  if (clip.speed && Math.abs(clip.speed - 1) > 0.01) {
    details.push(`speed ${clip.speed.toFixed(2)}x`);
  }
  if (clip.effects?.length) {
    const effectTypes = clip.effects.map((effect) => effect.effect_type).slice(0, 3).join(', ');
    details.push(`effects=${effectTypes}`);
  }
  if (clip.group_id) {
    details.push(`group=${shortText(clip.group_id, 14)}`);
  }

  return `- ${clipLabel(clip, meta, track)} [${track.name}/${track.track_type}] ${details.join(', ')}`;
}

function formatTrackLine(track: Track): string {
  const clips = track.clips ?? [];
  if (clips.length === 0) {
    return `- ${track.name} [${track.track_type}] empty, ${track.visible ? 'visible' : 'hidden'}, ${track.locked ? 'locked' : 'unlocked'}`;
  }

  const spanStart = clips[0]?.timeline_start_us ?? 0;
  const spanEnd = clips[clips.length - 1]?.timeline_end_us ?? 0;
  return `- ${track.name} [${track.track_type}] ${clips.length} clips, ${formatTimeRange(spanStart, spanEnd)}, ${track.visible ? 'visible' : 'hidden'}, ${track.locked ? 'locked' : 'unlocked'}${track.muted ? ', muted' : ''}`;
}

function buildContextLines(): string[] {
  const state = window.IKState;
  if (!state?.isReady()) return ['No project is loaded yet.'];

  const project = state.getProject();
  if (!project) return ['No project is loaded yet.'];

  const tracks = state.getTracks?.() ?? [];
  const entries = getClipEntries();
  const playheadUs = Math.round((window.S?.time ?? 0) * 1_000_000);
  const durationSec = state.getDurationSec?.() ?? 0;
  const selectedAr = window.S?.selectedAR ?? '16/9';
  const frameRate = project.frame_rate?.den ? project.frame_rate.num / project.frame_rate.den : 0;
  const fpsLabel = frameRate > 0 ? `${frameRate % 1 === 0 ? frameRate.toFixed(0) : frameRate.toFixed(2)}fps` : 'fps unknown';
  const recentNodes = (window.aiNodes ?? []).slice(-5);

  const lines: string[] = [
    `Project: ${project.name ?? 'Untitled'} (${project.width}x${project.height}, ${selectedAr}, ${fpsLabel})`,
    `Timeline: ${durationSec.toFixed(2)}s total, playhead ${(playheadUs / 1_000_000).toFixed(2)}s`,
    `Tracks: ${tracks.length} total, ${entries.length} clips`,
    'Track overview:',
  ];

  const selectedIds = new Set(getSelectedClipIds());
  const currentEntries = entries.filter(
    ({ clip }) => playheadUs >= clip.timeline_start_us && playheadUs < clip.timeline_end_us,
  );
  const currentIds = new Set(currentEntries.map(({ clip }) => clip.id));
  const nearbyEntries = entries
    .filter(({ clip }) => !selectedIds.has(clip.id) && !currentIds.has(clip.id))
    .map((entry) => {
      const centerUs = (entry.clip.timeline_start_us + entry.clip.timeline_end_us) / 2;
      return { ...entry, distanceUs: Math.abs(centerUs - playheadUs) };
    })
    .filter((entry) => entry.distanceUs <= PLAYHEAD_CONTEXT_WINDOW_US)
    .sort((a, b) => a.distanceUs - b.distanceUs)
    .slice(0, MAX_NEARBY_CLIPS);

  const selectedEntries = selectedIds.size
    ? entries.filter(({ clip }) => selectedIds.has(clip.id)).slice(0, MAX_SELECTED_CLIPS)
    : [];

  lines.push(...tracks.slice(0, MAX_TRACK_LINES).map(formatTrackLine));
  if (tracks.length > MAX_TRACK_LINES) {
    lines.push(`- ...and ${tracks.length - MAX_TRACK_LINES} more track(s)`);
  }

  lines.push('Selected clips:');
  if (selectedEntries.length > 0) {
    lines.push(...selectedEntries.map(({ track, clip, meta }) => formatClipLine(clip, track, meta)));
  } else {
    lines.push('- none');
  }

  lines.push('Clips at playhead:');
  if (currentEntries.length > 0) {
    lines.push(
      ...currentEntries.slice(0, MAX_CURRENT_CLIPS).map(({ track, clip, meta }) =>
        formatClipLine(clip, track, meta),
      ),
    );
  } else {
    lines.push('- none');
  }

  lines.push('Nearby clips:');
  if (nearbyEntries.length > 0) {
    lines.push(
      ...nearbyEntries.map(({ track, clip, meta }) => formatClipLine(clip, track, meta)),
    );
  } else {
    lines.push('- none');
  }

  if (recentNodes.length > 0) {
    lines.push(
      'Recent AI markers: ' +
        recentNodes.map((node) => `${shortText(node.label, 24)} @ ${node.time.toFixed(1)}s`).join('; '),
    );
  }

  return lines;
}

function formatClipSummary(): string {
  return buildContextLines().join('\n');
}

function buildSystemPrompt(): string {
  return [
    'You are Granite, the local assistant inside iKlippa.',
    'Answer in a concise, helpful way.',
    'The app runs fully in the browser, so do not claim server access or internet access.',
    'Use the edit context below when the user asks about the timeline, selected clips, captions, pacing, or export.',
    'Treat the selected clips and playhead clips as the primary source of truth.',
    'If the context is still too thin, ask the user to select a clip or move the playhead instead of saying you cannot see the video.',
    'When you suggest edits, name the concrete clip, track, or timeline range you are referring to.',
    '',
    'Project context:',
    formatClipSummary(),
  ].join('\n');
}

function buildMessages(prompt: string): GraniteMessage[] {
  const history = conversationHistory.slice(-MAX_HISTORY_MESSAGES);
  return [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
    { role: 'user', content: prompt },
  ];
}

function normalizeResponseText(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  if (!first || typeof first !== 'object') return '';

  const generated = (first as { generated_text?: unknown }).generated_text;
  if (typeof generated === 'string') return generated.trim();

  if (Array.isArray(generated) && generated.length > 0) {
    const last = generated[generated.length - 1];
    if (typeof last === 'string') return last.trim();
    if (last && typeof last === 'object') {
      const content = (last as { content?: unknown }).content;
      if (typeof content === 'string') return content.trim();
    }
  }

  return '';
}

function graniteLoadHint(error: unknown): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  const message = base.message.toLowerCase();
  const isHtmlParseError =
    message.includes('unexpected token') &&
    (message.includes('doctype') || message.includes('html') || message.includes('<'));
  if (
    isHtmlParseError ||
    message.includes('not valid json') ||
    message.includes('invalid json') ||
    message.includes('could not locate file') ||
    message.includes('not found locally') ||
    message.includes('failed to fetch') ||
    message.includes('local models are disabled') ||
    message.includes('both local and remote models are disabled') ||
    message.includes('local_files_only=true') ||
    message.includes('env.allowremotemodels=false')
  ) {
    return new Error(GRANITE_CACHE_MISS_MESSAGE);
  }
  return base;
}

export function resetGraniteConversation(): void {
  conversationHistory = [];
}

export function getGraniteLoadError(): Error | null {
  return graniteLoadError;
}

export function getGraniteLoadState(): GraniteLoadState {
  return graniteLoadState;
}

export function subscribeGraniteLoadState(listener: (state: GraniteLoadState) => void): () => void {
  graniteLoadStateListener = listener;
  listener(graniteLoadState);
  return () => {
    if (graniteLoadStateListener === listener) {
      graniteLoadStateListener = null;
    }
  };
}

async function loadGraniteModel(): Promise<void> {
  if (graniteWorkerReady) return;
  if (graniteLoadPromise) return graniteLoadPromise;

  graniteLoadError = null;
  emitGraniteLoadState({
    phase: 'loading',
    title: 'Loading Granite locally',
    detail: 'Starting the browser model...',
    percent: null,
  });
  const worker = getGraniteWorker();

  graniteLoadPromise = new Promise<void>((resolve, reject) => {
    graniteWarmResolve = () => {
      graniteWorkerReady = true;
      graniteLoadError = null;
      resolve();
    };
    graniteWarmReject = (error: Error) => {
      reject(error);
    };
    worker.postMessage({ type: 'warm' } satisfies GraniteWorkerRequest);
  }).finally(() => {
    graniteLoadPromise = null;
    graniteWarmResolve = null;
    graniteWarmReject = null;
  });

  return graniteLoadPromise;
}

export async function warmGraniteModel(): Promise<void> {
  await loadGraniteModel();
}

export async function sendGranitePrompt(
  prompt: string,
  options: GraniteSendOptions = {},
): Promise<string> {
  await loadGraniteModel();
  const messages = buildMessages(prompt);
  let streamedText = '';
  const worker = getGraniteWorker();
  const requestId = nextGraniteRequestId++;

  let output: unknown;
  try {
    output = await new Promise<unknown>((resolve, reject) => {
      pendingGraniteRequests.set(requestId, {
        onChunk: (chunk: string) => {
          streamedText += chunk;
          options.onChunk?.(chunk);
        },
        resolve: (response: string) => resolve(response || streamedText.trim()),
        reject: (error: Error) => reject(error),
      });
      const request: GraniteWorkerRequest = {
        type: 'generate',
        id: requestId,
        messages,
      };
      worker.postMessage(request);
    });
  } catch (error) {
    const normalizedError = graniteLoadHint(error);
    graniteLoadError = normalizedError;
    pendingGraniteRequests.delete(requestId);
    throw normalizedError;
  }

  const response = typeof output === 'string' ? output.trim() || streamedText.trim() : normalizeResponseText(output) || streamedText.trim();
  conversationHistory.push({ role: 'user', content: prompt });
  conversationHistory.push({ role: 'assistant', content: response });
  trimHistory();
  return response;
}
