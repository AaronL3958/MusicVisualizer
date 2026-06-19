import { AudioAnalyzer, createExportAudioGraph } from "./audioAnalyzer";
import { VisualizerRenderer } from "./visualizerRenderer";
import { AudioMetrics, ExportOptions, ExportProgress, LoadedAudio, RenderAssets, VisualizerSettings } from "../types";
import { resolutionMap } from "../settings";

export interface ExportJob {
  cancel: () => void;
  done: Promise<Blob>;
}

export function pickRecorderMimeType() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find((type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) ?? "";
}

export function extensionForMime(mimeType: string) {
  return mimeType.includes("mp4") ? "mp4" : "webm";
}

export function startExport(params: {
  audio: LoadedAudio;
  settings: VisualizerSettings;
  assets: RenderAssets;
  options: ExportOptions;
  onProgress: (progress: ExportProgress) => void;
}): ExportJob {
  const { audio, settings, assets, options, onProgress } = params;
  const resolution = resolutionMap[options.resolution];
  const canvas = document.createElement("canvas");
  const renderer = new VisualizerRenderer(canvas);
  renderer.resize(resolution.width, resolution.height);

  const mimeType = pickRecorderMimeType();
  if (!mimeType) {
    throw new Error("This browser does not expose MediaRecorder video encoding. Try current Chrome, Edge, or Firefox.");
  }

  const exportAnalyzer = new AudioAnalyzer();
  const graph = createExportAudioGraph(audio.buffer);
  const visualStream = canvas.captureStream(options.fps);
  const mixedStream = new MediaStream([
    ...visualStream.getVideoTracks(),
    ...graph.destination.stream.getAudioTracks()
  ]);

  const bitrate = resolution.width >= 3840 ? 52_000_000 : resolution.width >= 2560 ? 28_000_000 : 16_000_000;
  const recorder = new MediaRecorder(mixedStream, {
    mimeType,
    videoBitsPerSecond: bitrate,
    audioBitsPerSecond: 256_000
  });

  const chunks: Blob[] = [];
  let animationId = 0;
  let cancelled = false;
  let startedAt = 0;
  let lastDraw = 0;
  let lastProgressReport = 0;
  const frameMs = 1000 / options.fps;

  const cleanup = async () => {
    cancelAnimationFrame(animationId);
    mixedStream.getTracks().forEach((track) => track.stop());
    try {
      graph.source.disconnect();
      graph.gain.disconnect();
      graph.analyser.disconnect();
    } catch {
      // Already disconnected.
    }
    if (graph.context.state !== "closed") await graph.context.close();
  };

  const done = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    recorder.onerror = () => {
      cleanup();
      reject(new Error("The browser video encoder failed during export."));
    };

    recorder.onstop = async () => {
      await cleanup();
      if (cancelled) {
        onProgress({ status: "cancelled", progress: 0, message: "Export cancelled." });
        reject(new Error("Export cancelled."));
        return;
      }

      const blob = new Blob(chunks, { type: mimeType });
      const ext = extensionForMime(mimeType);
      const downloadUrl = URL.createObjectURL(blob);
      onProgress({
        status: "done",
        progress: 1,
        message: `Export complete (${ext.toUpperCase()}).`,
        downloadUrl,
        filename: `spectrum-studio-${options.resolution}-${options.fps}fps.${ext}`
      });
      resolve(blob);
    };

    const draw = () => {
      const elapsed = Math.max(0, graph.context.currentTime - startedAt);
      const fadeLevel = getFadeLevel(elapsed, audio.duration, settings.fadeIn, settings.fadeOut);
      graph.gain.gain.setTargetAtTime(fadeLevel, graph.context.currentTime, 0.02);
      const now = performance.now();
      if (now - lastDraw >= frameMs * 0.75) {
        const metrics: AudioMetrics = exportAnalyzer.readMetrics(graph.analyser, settings);
        renderer.drawFrame(settings, metrics, assets, elapsed);
        lastDraw = now;
      }

      const progress = Math.min(1, elapsed / audio.duration);
      if (now - lastProgressReport > 250 || progress >= 0.999) {
        onProgress({
          status: "recording",
          progress,
          message: `Rendering ${Math.round(progress * 100)}% at ${resolution.label}, ${options.fps} FPS.`
        });
        lastProgressReport = now;
      }

      if (elapsed >= audio.duration + 0.1) {
        if (recorder.state !== "inactive") recorder.stop();
        return;
      }
      animationId = requestAnimationFrame(draw);
    };

    onProgress({ status: "preparing", progress: 0, message: "Preparing high-resolution render canvas." });
    recorder.start(1000);
    graph.context.resume().then(() => {
      startedAt = graph.context.currentTime + 0.08;
      graph.source.start(startedAt);
      animationId = requestAnimationFrame(draw);
    }).catch(reject);
  });

  return {
    cancel: () => {
      cancelled = true;
      if (recorder.state !== "inactive") recorder.stop();
    },
    done
  };
}

function getFadeLevel(time: number, duration: number, fadeIn: number, fadeOut: number) {
  const inLevel = fadeIn <= 0 ? 1 : Math.min(1, time / fadeIn);
  const outRemaining = Math.max(0, duration - time);
  const outLevel = fadeOut <= 0 ? 1 : Math.min(1, outRemaining / fadeOut);
  return Math.max(0, Math.min(inLevel, outLevel));
}


