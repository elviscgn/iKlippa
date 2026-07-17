import type { CanvasPort, CanvasFactory } from '../../src/adapters/types';

class FakeCanvasRenderingContext2D {
  private _imagesDrawn: ImageData[] = [];
  private _fillRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  private _lastPut: { data: ImageData; x: number; y: number } | null = null;
  private _width = 0;
  private _height = 0;

  _globalCompositeOperation: string = 'source-over';
  _globalAlpha: number = 1;
  _fillStyle: string = '#000';

  get globalCompositeOperation(): string { return this._globalCompositeOperation; }
  set globalCompositeOperation(val: string) { this._globalCompositeOperation = val; }

  get globalAlpha(): number { return this._globalAlpha; }
  set globalAlpha(val: number) { this._globalAlpha = val; }

  get fillStyle(): string { return this._fillStyle; }
  set fillStyle(val: string) { this._fillStyle = val; }

  putImageData(imageData: ImageData, dx: number, dy: number): void {
    this._lastPut = { data: imageData, x: dx, y: dy };
  }

  drawImage(_source: CanvasImageSource, _dx: number, _dy: number): void {}

  fillRect(x: number, y: number, w: number, h: number): void {
    this._fillRects.push({ x, y, w, h });
  }

  clearRect(_x: number, _y: number, _w: number, _h: number): void {}

  setSize(w: number, h: number): void {
    this._width = w;
    this._height = h;
  }

  getLastPut(): { data: ImageData; x: number; y: number } | null {
    return this._lastPut;
  }

  getRects(): Array<{ x: number; y: number; w: number; h: number }> {
    return this._fillRects;
  }
}

class FakeCanvas {
  _width = 0;
  _height = 0;
  _ctx: FakeCanvasRenderingContext2D | null = null;
  _toDataURLCalls: Array<{ type: string; quality: number }> = [];
  _dataUrlResult: string | null = null;

  get width(): number { return this._width; }
  set width(val: number) { this._width = val; }

  get height(): number { return this._height; }
  set height(val: number) { this._height = val; }

  getContext(
    _contextId: '2d',
    _options?: CanvasRenderingContext2DSettings,
  ): CanvasRenderingContext2D | null {
    this._ctx = new FakeCanvasRenderingContext2D();
    this._ctx.setSize(this._width, this._height);
    return this._ctx as unknown as CanvasRenderingContext2D;
  }

  toDataURL(type?: string, quality?: number): string {
    this._toDataURLCalls.push({ type: type ?? 'image/png', quality: quality ?? 1 });
    return this._dataUrlResult ?? 'data:image/png;base64,fake';
  }

  setDataUrlResult(url: string | null): void {
    this._dataUrlResult = url;
  }

  getFakeCtx(): FakeCanvasRenderingContext2D | null {
    return this._ctx;
  }

  getDataURLCalls(): Array<{ type: string; quality: number }> {
    return this._toDataURLCalls;
  }
}

export type FakeCanvasType = FakeCanvas;

export const fakeCanvasFactory: CanvasFactory = {
  createElement(name: string): HTMLElement {
    const el: Record<string, unknown> = {
      tagName: name.toUpperCase(),
      click: () => {},
    };
    return el as unknown as HTMLElement;
  },
  createCanvas(): CanvasPort {
    return new FakeCanvas() as unknown as CanvasPort;
  },
};
