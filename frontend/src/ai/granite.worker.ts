import { env, pipeline, TextStreamer } from '@huggingface/transformers';

type GraniteRole = 'system' | 'user' | 'assistant';

interface GraniteMessage {
  role: GraniteRole;
  content: string;
}

type GraniteWorkerRequest =
  | { type: 'warm' }
  | { type: 'generate'; id: number; messages: GraniteMessage[] };

type GraniteWorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; progress: Record<string, unknown> }
  | { type: 'chunk'; id: number; chunk: string }
  | { type: 'result'; id: number; output: unknown }
  | { type: 'error'; id?: number; message: string };

type GranitePipeline = any;

// Smaller official browser build used by IBM's WebGPU demo.
const MODEL_ID = 'onnx-community/granite-4.0-micro-ONNX-web';
const GRANITE_CACHE_MISS_MESSAGE =
  'Granite has not been cached in this browser yet. Open the app once while online so Transformers.js can download and cache the model, then offline chat will work.';

let graniteModel: GranitePipeline | null = null;
let graniteModelPromise: Promise<GranitePipeline> | null = null;

function configureGraniteRuntime() {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
}

function chooseDevice(): 'webgpu' | 'wasm' {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) return 'webgpu';
  return 'wasm';
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

async function loadGraniteModel(): Promise<GranitePipeline> {
  configureGraniteRuntime();
  if (graniteModel) return graniteModel;
  if (graniteModelPromise) return graniteModelPromise;

  graniteModelPromise = pipeline('text-generation', MODEL_ID, {
    device: chooseDevice(),
    dtype: 'q4f16',
    revision: 'main',
    progress_callback: (progress: Record<string, unknown>) => {
      postMessage({ type: 'progress', progress } satisfies GraniteWorkerResponse);
    },
  })
    .then((pipe) => {
      graniteModel = pipe as GranitePipeline;
      return graniteModel;
    })
    .catch((error) => {
      graniteModelPromise = null;
      graniteModel = null;
      throw graniteLoadHint(error);
    });

  return graniteModelPromise;
}

self.addEventListener('message', async (event: MessageEvent<GraniteWorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'warm') {
      await loadGraniteModel();
      postMessage({ type: 'ready' } satisfies GraniteWorkerResponse);
      return;
    }

    if (msg.type === 'generate') {
      const generator = await loadGraniteModel();
      const messages = msg.messages;
      let streamedText = '';

      const streamer = new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (chunk: string) => {
          streamedText += chunk;
          postMessage({ type: 'chunk', id: msg.id, chunk } satisfies GraniteWorkerResponse);
        },
      });

      const output = await generator(messages, {
        max_new_tokens: 160,
        do_sample: false,
        temperature: 0.2,
        top_p: 0.9,
        repetition_penalty: 1.05,
        streamer,
      });

      postMessage({
        type: 'result',
        id: msg.id,
        output: normalizeResponseText(output) || streamedText.trim(),
      } satisfies GraniteWorkerResponse);
    }
  } catch (error) {
    const normalizedError = graniteLoadHint(error);
    if (normalizedError.message === GRANITE_CACHE_MISS_MESSAGE) {
      graniteModel = null;
      graniteModelPromise = null;
    }
    postMessage({
      type: 'error',
      id: msg.type === 'generate' ? msg.id : undefined,
      message: normalizedError.message,
    } satisfies GraniteWorkerResponse);
  }
});
