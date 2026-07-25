export const S = {
  time: 0,
  dur: 10,
  playing: false,
  rafId: null as number | null,
  lastTs: null as number | null,
  zoom: 1,
  tool: 'select',
  selectedAR: '16/9',
  timelineHeight: 360,
};

interface MediaItem {
  id: string;
  name: string;
  picId?: number;
  dur?: string;
  isReal?: boolean;
  thumbDataUrl?: string | null;
  thumbnailUrl?: string | null;
  remoteUrl?: string;
  provider?: string;
  creator?: string | null;
  pageUrl?: string | null;
  mimeType?: string;
  width?: number;
  height?: number;
}

export const mediaPool = {
  footage: [] as MediaItem[],
  audio: [] as MediaItem[],
  stock: {
    video: [] as MediaItem[],
    image: [] as MediaItem[],
    music: [] as MediaItem[],
  },
};

export interface AINode {
  time: number;
  label: string;
  icon: string;
}

export const aiNodes: AINode[] = [];

// For easy DOM selection
export const $ = (s: string) => document.querySelector(s) as HTMLElement | null;
export const $$ = (s: string) => document.querySelectorAll(s);

// µs → seconds helper
export const us2s = (us: number) => us / 1_000_000;
