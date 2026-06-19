export type VisualizerStyle = "circular" | "bars" | "waveform" | "particles";
export type ExportResolution = "1080p" | "1440p" | "4k";
export type ExportFps = 30 | 60;

export interface VisualizerSettings {
  style: VisualizerStyle;
  primaryColor: string;
  secondaryColor: string;
  glowColor: string;
  logoSize: number;
  spectrumRadius: number;
  barHeight: number;
  bassSensitivity: number;
  smoothing: number;
  bassBoost: number;
  kickThreshold: number;
  fadeIn: number;
  fadeOut: number;
  backgroundBlur: number;
  backgroundBrightness: number;
  glowAmount: number;
  cropLogoCircle: boolean;
  logoCropZoom: number;
  logoCropX: number;
  logoCropY: number;
  particles: boolean;
  bassPulse: boolean;
  waveform: boolean;
  backgroundMotion: boolean;
  darkOverlay: number;
}

export interface AudioMetrics {
  bass: number;
  mids: number;
  highs: number;
  bassPulse: number;
  kick: boolean;
  frequencyData: Uint8Array;
  waveformData: Uint8Array;
}

export interface LoadedAudio {
  file: File;
  url: string;
  buffer: AudioBuffer;
  duration: number;
}

export interface RenderAssets {
  logo?: HTMLImageElement;
  background?: HTMLImageElement;
}

export interface ExportOptions {
  resolution: ExportResolution;
  fps: ExportFps;
}

export interface ExportProgress {
  status: "idle" | "preparing" | "recording" | "finalizing" | "done" | "error" | "cancelled";
  progress: number;
  message: string;
  downloadUrl?: string;
  filename?: string;
}


