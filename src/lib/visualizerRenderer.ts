// @ts-expect-error Shared ESM renderer is consumed by both Vite and Node.
import { createVisualizerCore } from "../../shared/visualizerCore.mjs";
import { AudioMetrics, RenderAssets, VisualizerSettings } from "../types";

export class VisualizerRenderer {
  private core: ReturnType<typeof createVisualizerCore>;

  constructor(canvas: HTMLCanvasElement) {
    this.core = createVisualizerCore(canvas);
  }

  resize(width: number, height: number) {
    this.core.resize(width, height);
  }

  drawFrame(settings: VisualizerSettings, metrics: AudioMetrics, assets: RenderAssets, time: number) {
    this.core.drawFrame(settings, metrics, assets, time);
  }
}

