declare module "../../shared/visualizerCore.mjs" {
  export function createVisualizerCore(canvas: HTMLCanvasElement): {
    resize(width: number, height: number): void;
    drawFrame(settings: unknown, metrics: unknown, assets: unknown, time: number): void;
  };
}
