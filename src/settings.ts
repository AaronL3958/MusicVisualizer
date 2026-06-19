import { ExportResolution, VisualizerSettings } from "./types";

export const defaultSettings: VisualizerSettings = {
  style: "circular",
  primaryColor: "#35f2ff",
  secondaryColor: "#ff3df2",
  glowColor: "#78ffdb",
  logoSize: 0.23,
  spectrumRadius: 0.27,
  barHeight: 0.22,
  bassSensitivity: 0.92,
  smoothing: 0.7,
  bassBoost: 1.55,
  kickThreshold: 0.38,
  fadeIn: 2,
  fadeOut: 2,
  backgroundBlur: 7,
  backgroundBrightness: 0.65,
  glowAmount: 0.9,
  cropLogoCircle: true,
  logoCropZoom: 1,
  logoCropX: 0,
  logoCropY: 0,
  particles: true,
  bassPulse: true,
  waveform: true,
  backgroundMotion: true,
  darkOverlay: 0.45
};

export const resolutionMap: Record<ExportResolution, { width: number; height: number; label: string }> = {
  "1080p": { width: 1920, height: 1080, label: "1920 x 1080" },
  "1440p": { width: 2560, height: 1440, label: "2560 x 1440" },
  "4k": { width: 3840, height: 2160, label: "3840 x 2160" }
};

export const presets: Array<{ name: string; settings: Partial<VisualizerSettings> }> = [
  {
    name: "Neon Halo",
    settings: {
      style: "circular",
      primaryColor: "#35f2ff",
      secondaryColor: "#ff3df2",
      glowColor: "#78ffdb",
      glowAmount: 0.95,
      bassSensitivity: 0.92,
      bassBoost: 1.55,
      particles: true
    }
  },
  {
    name: "Chrome Pulse",
    settings: {
      style: "waveform",
      primaryColor: "#f5f7ff",
      secondaryColor: "#7c8cff",
      glowColor: "#ffffff",
      backgroundBlur: 11,
      darkOverlay: 0.55
    }
  },
  {
    name: "Bassline",
    settings: {
      style: "bars",
      primaryColor: "#00ff88",
      secondaryColor: "#ffe45f",
      glowColor: "#00ff88",
      bassSensitivity: 1.05,
      bassBoost: 1.8,
      kickThreshold: 0.32,
      barHeight: 0.28
    }
  },
  {
    name: "Meteor",
    settings: {
      style: "particles",
      primaryColor: "#ff6b35",
      secondaryColor: "#35d7ff",
      glowColor: "#ffb703",
      particles: true,
      backgroundMotion: true
    }
  }
];
