import {
  type AudioAnalysisOptions,
  type AudioAnalysisResult,
  type BeatProfile,
} from './audioMath';
import { getSourceAudioBuffer } from '../media/sourceRegistry';

interface PendingRequest {
  resolve: (result: AudioAnalysisResult) => void;
  reject: (error: Error) => void;
}

type WorkerResponse =
  | { type: 'result'; id: number; result: AudioAnalysisResult }
  | { type: 'error'; id: number; message: string };

const analysisCache = new Map<string, Promise<AudioAnalysisResult>>();
const pending = new Map<number, PendingRequest>();
let analysisWorker: Worker | null = null;
let nextRequestId = 1;

function getWorker(): Worker {
  if (analysisWorker) return analysisWorker;
  analysisWorker = new Worker(new URL('./audio-analysis.worker.ts', import.meta.url), {
    type: 'module',
    name: 'iklippa-audio-analysis',
  });
  analysisWorker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.type === 'result') request.resolve(response.result);
    else request.reject(new Error(response.message));
  });
  analysisWorker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'Local audio analysis worker failed.');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    analysisWorker?.terminate();
    analysisWorker = null;
  });
  return analysisWorker;
}

function downmixForAnalysis(buffer: AudioBuffer, targetRate = 12_000): {
  samples: Float32Array;
  sampleRate: number;
} {
  const outputRate = Math.min(buffer.sampleRate, targetRate);
  const ratio = buffer.sampleRate / outputRate;
  const outputLength = Math.max(1, Math.floor(buffer.length / ratio));
  const samples = new Float32Array(outputLength);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => {
    return buffer.getChannelData(index);
  });

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex++) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.max(start + 1, Math.min(buffer.length, Math.floor((outputIndex + 1) * ratio)));
    let sum = 0;
    let count = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex++) {
      for (const channel of channels) {
        sum += channel[inputIndex] ?? 0;
        count++;
      }
    }
    samples[outputIndex] = count > 0 ? sum / count : 0;
  }
  return { samples, sampleRate: outputRate };
}

function analyzeInWorker(
  samples: Float32Array,
  sampleRate: number,
  options: AudioAnalysisOptions,
): Promise<AudioAnalysisResult> {
  const worker = getWorker();
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const bytes = samples.buffer;
    worker.postMessage({ type: 'analyze', id, samples: bytes, sampleRate, options }, [bytes]);
  });
}

export async function analyzeSourceAudio(
  sourceId: string,
  profile: BeatProfile = 'default',
): Promise<AudioAnalysisResult> {
  const cacheKey = `${sourceId}:${profile}`;
  const existing = analysisCache.get(cacheKey);
  if (existing) return existing;

  const task = (async () => {
    const buffer = await getSourceAudioBuffer(sourceId);
    const prepared = downmixForAnalysis(buffer);
    return analyzeInWorker(prepared.samples, prepared.sampleRate, {
      profile,
      frameMs: 24,
      minSilenceMs: 360,
    });
  })();
  analysisCache.set(cacheKey, task);
  try {
    return await task;
  } catch (error) {
    analysisCache.delete(cacheKey);
    throw error;
  }
}

export function clearAudioAnalysisCache(sourceId?: string): void {
  if (!sourceId) {
    analysisCache.clear();
    return;
  }
  for (const key of analysisCache.keys()) {
    if (key.startsWith(`${sourceId}:`)) analysisCache.delete(key);
  }
}
