export const GRANITE_MODEL_ID = 'onnx-community/granite-4.0-350m-ONNX-web';

export interface GraniteRuntimeConfig {
  device: 'webgpu' | 'wasm';
  dtype: 'fp16' | 'q4';
}

export function chooseGraniteRuntime(hasWebGpu: boolean): GraniteRuntimeConfig {
  return hasWebGpu
    ? { device: 'webgpu', dtype: 'fp16' }
    : { device: 'wasm', dtype: 'q4' };
}

