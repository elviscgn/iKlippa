// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { captureThumbnailFromBuffer, exportVideo, handleWorkerMessage, renderLoop } from '../src/engine/engine';
import { seekAndDecodeFrame, primeAudioDecode, decodeNextSamples, setupAudioDecoder, setupDecoder } from '../src/engine/worker';
import { applyAiAction, renderRuler, renderClips } from '../src/ui/timeline';

test('engine functions should be imported', () => {
  expect(typeof captureThumbnailFromBuffer).toBe('function');
  expect(typeof exportVideo).toBe('function');
  expect(typeof handleWorkerMessage).toBe('function');
  expect(typeof renderLoop).toBe('function');
});

test('worker functions should be imported', () => {
  expect(typeof seekAndDecodeFrame).toBe('function');
  expect(typeof primeAudioDecode).toBe('function');
  expect(typeof decodeNextSamples).toBe('function');
  expect(typeof setupAudioDecoder).toBe('function');
  expect(typeof setupDecoder).toBe('function');
});

test('timeline functions should be imported', () => {
  expect(typeof applyAiAction).toBe('function');
  expect(typeof renderRuler).toBe('function');
  expect(typeof renderClips).toBe('function');
});
import { renderMedia } from '../src/ui/mediaPool';
test('mediaPool functions should be imported', () => {
  expect(typeof renderMedia).toBe('function');
});
