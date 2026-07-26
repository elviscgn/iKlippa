import {
  analyzePcm,
  type AudioAnalysisOptions,
} from './audioMath';

interface AnalyzeAudioRequest {
  type: 'analyze';
  id: number;
  samples: ArrayBuffer;
  sampleRate: number;
  options: AudioAnalysisOptions;
}

self.addEventListener('message', (event: MessageEvent<AnalyzeAudioRequest>) => {
  const request = event.data;
  if (request.type !== 'analyze') return;
  try {
    const result = analyzePcm(new Float32Array(request.samples), request.sampleRate, request.options);
    postMessage({ type: 'result', id: request.id, result });
  } catch (error) {
    postMessage({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
