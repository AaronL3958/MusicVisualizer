import { AudioMetrics, LoadedAudio } from "../types";

const FFT_SIZE = 2048;

interface ResponseSettings {
  smoothing: number;
  bassBoost: number;
  bassSensitivity: number;
  kickThreshold: number;
}

export class AudioAnalyzer {
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private source?: MediaElementAudioSourceNode;
  private gain?: GainNode;
  private frequencyData = new Uint8Array(FFT_SIZE / 2);
  private waveformData = new Uint8Array(FFT_SIZE);
  private smoothBass = 0;
  private smoothMids = 0;
  private smoothHighs = 0;
  private pulse = 0;
  private lastBass = 0;
  private slowBass = 0;
  private bassFloor = 0.08;
  private bassPeak = 0.35;
  private kickCooldown = 0;
  private connectedElement?: HTMLAudioElement;

  async loadAudio(file: File): Promise<LoadedAudio> {
    if (!/audio\/|video\/mp4|application\/ogg/.test(file.type) && !/\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(file.name)) {
      throw new Error("Unsupported audio format. Try MP3, WAV, M4A, AAC, FLAC, or OGG.");
    }

    const url = URL.createObjectURL(file);
    const arrayBuffer = await file.arrayBuffer();
    const decodeContext = new AudioContext();
    try {
      const buffer = await decodeContext.decodeAudioData(arrayBuffer.slice(0));
      return { file, url, buffer, duration: buffer.duration };
    } finally {
      await decodeContext.close();
    }
  }

  async connectElement(element: HTMLAudioElement) {
    if (!this.context) {
      this.context = new AudioContext();
    }

    if (this.connectedElement === element && this.analyser) {
      await this.context.resume();
      return;
    }

    this.analyser = this.context.createAnalyser();
    this.gain = this.context.createGain();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.58;

    this.source?.disconnect();
    this.source = this.context.createMediaElementSource(element);
    this.source.connect(this.gain);
    this.gain.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    this.connectedElement = element;
    await this.context.resume();
  }

  setOutputGain(value: number) {
    if (!this.context || !this.gain) return;
    this.gain.gain.setTargetAtTime(clamp(value, 0, 1), this.context.currentTime, 0.035);
  }

  getMetrics(settings: ResponseSettings): AudioMetrics {
    if (!this.analyser) return this.silentMetrics();
    return this.readMetrics(this.analyser, settings);
  }

  readMetrics(analyser: AnalyserNode, settings: ResponseSettings): AudioMetrics {
    analyser.getByteFrequencyData(this.frequencyData);
    analyser.getByteTimeDomainData(this.waveformData);

    const bassRaw = this.weightedBandAverage(analyser, 28, 150, 1.45);
    const subBass = this.weightedBandAverage(analyser, 35, 80, 1.9);
    const bass = (bassRaw * 0.58 + subBass * 0.42) * settings.bassBoost;
    const mids = this.weightedBandAverage(analyser, 180, 2200, 0.85);
    const highs = this.weightedBandAverage(analyser, 2600, 11000, 0.75);
    const smooth = clamp(settings.smoothing, 0.05, 0.96);

    this.smoothBass = lerp(bass, this.smoothBass, smooth * 0.82);
    this.slowBass = lerp(bass, this.slowBass, 0.955);
    this.smoothMids = lerp(mids, this.smoothMids, smooth);
    this.smoothHighs = lerp(highs, this.smoothHighs, smooth);
    this.bassFloor = lerp(Math.min(this.bassFloor, this.slowBass), this.bassFloor, 0.985);
    this.bassPeak = lerp(Math.max(this.bassPeak, this.smoothBass), this.bassPeak, 0.975);

    const bassVelocity = Math.max(0, this.smoothBass - this.lastBass);
    const adaptiveRange = Math.max(0.08, this.bassPeak - this.bassFloor);
    const normalizedBass = clamp((this.smoothBass - this.bassFloor) / adaptiveRange, 0, 1);
    const threshold = clamp(settings.kickThreshold, 0.16, 0.8);
    const localLift = this.smoothBass - this.slowBass;
    const kick = this.kickCooldown <= 0 && normalizedBass > threshold && (bassVelocity > 0.012 || localLift > 0.035);
    this.kickCooldown = kick ? 7 : Math.max(0, this.kickCooldown - 1);

    const sensitivity = Math.max(settings.bassSensitivity, 0.2);
    const targetPulse = kick
      ? Math.min(1, 0.32 + normalizedBass * 0.78 * sensitivity)
      : Math.min(1, normalizedBass * 0.42 * sensitivity + this.smoothBass * 0.18);
    this.pulse = Math.max(targetPulse, this.pulse * 0.86);
    this.lastBass = this.smoothBass;

    return {
      bass: clamp(normalizedBass * settings.bassSensitivity, 0, 1),
      mids: clamp(this.smoothMids * 0.58, 0, 1),
      highs: clamp(this.smoothHighs * 0.5, 0, 1),
      bassPulse: clamp(this.pulse, 0, 1),
      kick,
      frequencyData: this.frequencyData,
      waveformData: this.waveformData
    };
  }

  createSilentMetrics(): AudioMetrics {
    return this.silentMetrics();
  }

  private silentMetrics(): AudioMetrics {
    return {
      bass: 0.08,
      mids: 0.06,
      highs: 0.04,
      bassPulse: 0.05,
      kick: false,
      frequencyData: this.frequencyData,
      waveformData: this.waveformData
    };
  }

  private weightedBandAverage(analyser: AnalyserNode, lowHz: number, highHz: number, lowWeight: number) {
    const nyquist = analyser.context.sampleRate / 2;
    const start = Math.max(0, Math.floor((lowHz / nyquist) * this.frequencyData.length));
    const end = Math.min(this.frequencyData.length - 1, Math.ceil((highHz / nyquist) * this.frequencyData.length));
    let total = 0;
    let weights = 0;
    for (let i = start; i <= end; i += 1) {
      const t = end === start ? 0 : (i - start) / (end - start);
      const weight = lerp(1, lowWeight, 1 - t);
      total += this.frequencyData[i] * weight;
      weights += weight;
    }
    return weights === 0 ? 0 : total / (weights * 255);
  }
}

export interface ExportAudioGraph {
  context: AudioContext;
  source: AudioBufferSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  destination: MediaStreamAudioDestinationNode;
}

export function createExportAudioGraph(buffer: AudioBuffer): ExportAudioGraph {
  const context = new AudioContext();
  const source = context.createBufferSource();
  const gain = context.createGain();
  const analyser = context.createAnalyser();
  const destination = context.createMediaStreamDestination();

  source.buffer = buffer;
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.58;
  source.connect(gain);
  gain.connect(analyser);
  analyser.connect(destination);

  return { context, source, gain, analyser, destination };
}

function lerp(next: number, prev: number, smoothing: number) {
  return prev * smoothing + next * (1 - smoothing);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
