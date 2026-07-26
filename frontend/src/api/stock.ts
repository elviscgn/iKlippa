export interface StockMediaResult {
  id: string;
  name: string;
  duration: number;
  thumbnail_url?: string | null;
  provider: 'Pexels' | 'Jamendo';
  creator?: string | null;
  page_url?: string | null;
}

export interface StockVideoResult extends StockMediaResult {
  video_url: string;
  width?: number | null;
  height?: number | null;
}

export interface StockMusicResult extends StockMediaResult {
  audio_url: string;
}

interface StockSearchResponse<T> {
  items: T[];
}

async function searchStock<T>(
  path: string,
  query: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const response = await fetch(`/api/stock/${path}?q=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });

  let payload: StockSearchResponse<T> | { detail?: string; error?: string } | null = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The stock service returned an invalid response.');
  }

  if (!response.ok) {
    const errorPayload = payload as { detail?: string; error?: string };
    throw new Error(errorPayload.detail || errorPayload.error || 'Stock search failed.');
  }

  return Array.isArray((payload as StockSearchResponse<T>).items)
    ? (payload as StockSearchResponse<T>).items
    : [];
}

export function searchStockVideos(
  query: string,
  signal?: AbortSignal,
): Promise<StockVideoResult[]> {
  return searchStock<StockVideoResult>('videos', query, signal);
}

export function searchStockMusic(
  query: string,
  signal?: AbortSignal,
): Promise<StockMusicResult[]> {
  return searchStock<StockMusicResult>('music', query, signal);
}

export async function downloadStockFile(
  url: string,
  name: string,
  fallbackType: string,
): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Media download failed (${response.status}).`);
  }
  const blob = await response.blob();
  const type = blob.type || fallbackType;
  return new File([blob], name, { type });
}
