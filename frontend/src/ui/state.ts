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
  width?: number;
  height?: number;
}

export const mediaPool = {
  footage: [] as MediaItem[],
  audio: [] as MediaItem[],
  stock: {
    video: [
      { id: 'sv1', name: 'Neon_Drive.mp4', picId: 83 },
      { id: 'sv2', name: 'Drone_City.mp4', picId: 103 },
    ] as MediaItem[],
    image: [
      { id: 'si1', name: 'Abstract_Texture.jpg', picId: 122 },
      { id: 'si2', name: 'Modern_Architecture.jpg', picId: 155 },
    ] as MediaItem[],
    music: [
      { id: 'sm1', name: 'Epic_Cinematic.mp3', dur: '2:10' },
      { id: 'sm2', name: 'Corporate_Rhythm.wav', dur: '1:45' },
    ] as MediaItem[],
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
