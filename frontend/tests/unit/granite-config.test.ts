import { describe, expect, it } from 'vitest';
import {
  chooseGraniteRuntime,
  GRANITE_MODEL_ID,
} from '../../src/ai/graniteConfig';

describe('Granite Nano runtime', () => {
  it('uses the Nano 350M browser checkpoint', () => {
    expect(GRANITE_MODEL_ID).toBe('onnx-community/granite-4.0-350m-ONNX-web');
  });

  it('uses FP16 on WebGPU', () => {
    expect(chooseGraniteRuntime(true)).toEqual({
      device: 'webgpu',
      dtype: 'fp16',
    });
  });

  it('uses quantized weights on the WASM fallback', () => {
    expect(chooseGraniteRuntime(false)).toEqual({
      device: 'wasm',
      dtype: 'q4',
    });
  });
});

