import type { ThumbnailEntry } from '../state/types';

const MIN_THUMBNAILS = 6;
const MAX_THUMBNAILS = 20;
const THUMBNAIL_INTERVAL_MS = 3_000;
const THUMBNAIL_WIDTH = 160;
const SEEK_TIMEOUT_MS = 4_000;
const FRAME_MATCH_TOLERANCE_SEC = 0.5;

export function buildThumbnailTimes(durationMs: number): number[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const count = Math.min(
    MAX_THUMBNAILS,
    Math.max(MIN_THUMBNAILS, Math.ceil(durationMs / THUMBNAIL_INTERVAL_MS)),
  );
  return Array.from({ length: count }, (_, index) =>
    Math.min(
      Math.max(0, durationMs - 1),
      Math.round(((index + 0.5) / count) * durationMs),
    ),
  );
}

function waitForEvent(
  target: HTMLMediaElement,
  eventName: 'loadedmetadata' | 'seeked',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Video thumbnail ${eventName} timed out`));
    }, SEEK_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      target.removeEventListener(eventName, onReady);
      target.removeEventListener('error', onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('The browser could not decode this video for thumbnails'));
    };
    target.addEventListener(eventName, onReady, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  const seeked = waitForEvent(video, 'seeked');
  const supportsFrameCallbacks =
    typeof video.requestVideoFrameCallback === 'function';
  const presented = supportsFrameCallbacks
    ? waitForPresentedFrame(video, timeSec)
    : null;
  video.currentTime = timeSec;
  await seeked;
  if (presented) {
    await presented;
  } else {
    await waitForBrowserPaint();
  }
}

function waitForPresentedFrame(
  video: HTMLVideoElement,
  targetTimeSec: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let callbackId = 0;
    const timeout = window.setTimeout(() => {
      video.cancelVideoFrameCallback(callbackId);
      reject(new Error('Video thumbnail frame presentation timed out'));
    }, SEEK_TIMEOUT_MS);
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (Math.abs(metadata.mediaTime - targetTimeSec) <= FRAME_MATCH_TOLERANCE_SEC) {
        window.clearTimeout(timeout);
        resolve();
        return;
      }
      callbackId = video.requestVideoFrameCallback(onFrame);
    };
    callbackId = video.requestVideoFrameCallback(onFrame);
  });
}

function waitForBrowserPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

export async function generateVideoThumbnails(
  file: File,
  durationMs: number,
): Promise<ThumbnailEntry[]> {
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return [];

  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const objectUrl = URL.createObjectURL(file);

  try {
    const metadataReady = waitForEvent(video, 'loadedmetadata');
    video.src = objectUrl;
    video.load();
    await metadataReady;

    const resolvedDurationMs = Number.isFinite(video.duration) && video.duration > 0
      ? Math.round(video.duration * 1_000)
      : durationMs;
    const width = video.videoWidth || THUMBNAIL_WIDTH;
    const height = video.videoHeight || Math.round(THUMBNAIL_WIDTH * 9 / 16);
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = Math.max(1, Math.round(THUMBNAIL_WIDTH * height / width));

    const thumbnails: ThumbnailEntry[] = [];
    for (const targetMs of buildThumbnailTimes(resolvedDurationMs)) {
      await seekVideo(video, targetMs / 1_000);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      thumbnails.push({
        ms: targetMs,
        dataUrl: canvas.toDataURL('image/jpeg', 0.58),
      });
    }
    return thumbnails;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

export function pickPosterThumbnail(
  thumbnails: ThumbnailEntry[],
  durationMs: number,
): ThumbnailEntry | null {
  if (thumbnails.length === 0) return null;
  const midpointMs = durationMs / 2;
  return thumbnails.reduce((closest, thumbnail) =>
    Math.abs(thumbnail.ms - midpointMs) < Math.abs(closest.ms - midpointMs)
      ? thumbnail
      : closest,
  );
}

export function buildClipThumbnailStrip(
  thumbnails: ThumbnailEntry[],
  sourceStartUs: number,
  sourceEndUs: number,
  count: number,
): ThumbnailEntry[] {
  if (thumbnails.length === 0 || count <= 0) return [];
  const sorted = thumbnails
    .filter((thumbnail) => Number.isFinite(thumbnail.ms) && thumbnail.dataUrl.length > 0)
    .slice()
    .sort((a, b) => a.ms - b.ms);
  if (sorted.length === 0) return [];

  const startMs = Math.max(0, sourceStartUs / 1_000);
  const endMs = Math.max(startMs, sourceEndUs / 1_000);
  const spanMs = endMs - startMs;

  return Array.from({ length: count }, (_, index) => {
    const targetMs = spanMs > 0
      ? startMs + ((index + 0.5) / count) * spanMs
      : startMs;
    return sorted.reduce((closest, thumbnail) =>
      Math.abs(thumbnail.ms - targetMs) < Math.abs(closest.ms - targetMs)
        ? thumbnail
        : closest,
    );
  });
}
