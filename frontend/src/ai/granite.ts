import { env, pipeline, TextStreamer } from '@huggingface/transformers';
import { isOfflineMode } from '../ui/utils';

type GraniteRole = 'system' | 'user' | 'assistant';

export interface GraniteMessage {
  role: GraniteRole;
  content: string;
}

export interface GraniteSendOptions {
  onChunk?: (chunk: string) => void;
}

type GranitePipeline = any;

const MODEL_ID = 'onnx-community/granite-4.0-micro-ONNX-web';
const LOCAL_MODEL_ROOT = '/models/';
const LOCAL_WASM_ROOT = '/transformers/';
const MAX_HISTORY_MESSAGES = 10;

let graniteModel: GranitePipeline | null = null;
let graniteModelPromise: Promise<GranitePipeline> | null = null;
let graniteLoadError: Error | null = null;
let conversationHistory: GraniteMessage[] = [];

function configureOfflineRuntime() {
  const offline = isOfflineMode();
  env.allowLocalModels = true;
  env.allowRemoteModels = !offline;
  env.localModelPath = LOCAL_MODEL_ROOT;
  env.backends.onnx.wasm.wasmPaths = LOCAL_WASM_ROOT;
}

function chooseDevice(): 'webgpu' | 'wasm' {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) return 'webgpu';
  return 'wasm';
}

function trimHistory() {
  if (conversationHistory.length <= MAX_HISTORY_MESSAGES) return;
  conversationHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES);
}

function shortText(text: string, max = 72): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '...' : cleaned;
}

function formatClipSummary(): string {
  const state = window.IKState;
  if (!state?.isReady()) return 'No project is loaded yet.';

  const project = state.getProject();
  const videoClips = state.getVideoClips?.() ?? [];
  const audioClips = state.getAudioClips?.() ?? [];
  const tracks = state.getTracks?.() ?? [];
  const selectedAr = window.S?.selectedAR ?? '16/9';
  const timelineTime = window.S?.time ?? 0;
  const timelineDur = window.S?.dur ?? 0;
  const recentNodes = (window.aiNodes ?? []).slice(-5);

  const lines: string[] = [
    `Project: ${project?.name ?? 'Untitled'} (${project?.width ?? 0}x${project?.height ?? 0})`,
    `Aspect ratio: ${selectedAr}`,
    `Timeline: ${timelineTime.toFixed(2)}s playhead, ${timelineDur.toFixed(2)}s total`,
    `Tracks: ${tracks.map((track) => `${track.name} [${track.track_type}] ${track.clips.length} clips`).join('; ') || 'none'}`,
    `Clips: ${videoClips.length} video, ${audioClips.length} audio`,
  ];

  if (videoClips.length > 0) {
    const clipLines = videoClips.slice(0, 6).map((clip) => {
      const name = shortText(
        clip.name || clip.caption_text || clip.source_id || `Clip ${clip.id}`,
        48,
      );
      const start = (clip.timeline_start_us / 1_000_000).toFixed(2);
      const end = (clip.timeline_end_us / 1_000_000).toFixed(2);
      return `- ${name}: ${start}s to ${end}s`;
    });
    if (clipLines.length > 0) {
      lines.push('Video clip summary:');
      lines.push(...clipLines);
    }
  }

  if (recentNodes.length > 0) {
    lines.push(
      'Recent AI markers: ' +
        recentNodes
          .map((node) => `${shortText(node.label, 28)} @ ${node.time.toFixed(1)}s`)
          .join('; '),
    );
  }

  return lines.join('\n');
}

function buildSystemPrompt(): string {
  return [
    'You are Granite, the local assistant inside iKlippa.',
    'Answer in a concise, helpful way.',
    'The app runs fully in the browser, so do not claim server access or internet access.',
    'Use the project context below when the user asks about the edit or timeline.',
    'If the user asks for actions, explain the exact editor action or workflow.',
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
  if (
    message.includes('could not locate file') ||
    message.includes('not found locally') ||
    message.includes('failed to fetch')
  ) {
    return new Error(
      `Granite model files were not found under ${LOCAL_MODEL_ROOT}${MODEL_ID}/onnx/. Put the local Transformers.js export there and reload.`,
    );
  }
  return base;
}

async function loadGraniteModel(): Promise<GranitePipeline> {
  configureOfflineRuntime();
  if (graniteModel) return graniteModel;
  if (graniteModelPromise) return graniteModelPromise;

  graniteModelPromise = pipeline('text-generation', MODEL_ID, {
    device: chooseDevice(),
    dtype: 'q4f16',
    local_files_only: isOfflineMode(),
    revision: 'main',
  })
    .then((pipe) => {
      graniteModel = pipe as GranitePipeline;
      graniteLoadError = null;
      return graniteModel;
    })
    .catch((error) => {
      graniteLoadError = graniteLoadHint(error);
      graniteModelPromise = null;
      throw graniteLoadError;
    });

  return graniteModelPromise;
}

export async function warmGraniteModel(): Promise<void> {
  await loadGraniteModel();
}

export function resetGraniteConversation(): void {
  conversationHistory = [];
}

export function getGraniteLoadError(): Error | null {
  return graniteLoadError;
}

export async function sendGranitePrompt(
  prompt: string,
  options: GraniteSendOptions = {},
): Promise<string> {
  const generator = await loadGraniteModel();
  const messages = buildMessages(prompt);
  let streamedText = '';

  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk: string) => {
      streamedText += chunk;
      options.onChunk?.(chunk);
    },
  });

  const output = await generator(messages, {
    max_new_tokens: 256,
    do_sample: false,
    temperature: 0.2,
    top_p: 0.9,
    repetition_penalty: 1.05,
    streamer,
  });

  const response = normalizeResponseText(output) || streamedText.trim();
  conversationHistory.push({ role: 'user', content: prompt });
  conversationHistory.push({ role: 'assistant', content: response });
  trimHistory();
  return response;
}
