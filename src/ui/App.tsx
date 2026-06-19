import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { AudioAnalyzer } from "../lib/audioAnalyzer";
import { startExport, extensionForMime, pickRecorderMimeType } from "../lib/exportRenderer";
import { loadImageFile, revokeUrl } from "../lib/fileAssets";
import { VisualizerRenderer } from "../lib/visualizerRenderer";
import { defaultSettings, presets, resolutionMap } from "../settings";
import { ExportFps, ExportProgress, ExportResolution, LoadedAudio, RenderAssets, VisualizerSettings, VisualizerStyle } from "../types";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rendererRef = useRef<VisualizerRenderer | null>(null);
  const analyzerRef = useRef(new AudioAnalyzer());
  const animationRef = useRef(0);
  const exportCancelRef = useRef<(() => void) | null>(null);
  const settingsRef = useRef(defaultSettings);
  const assetsRef = useRef<RenderAssets>({});
  const urlsRef = useRef<{ audio?: string; logo?: string; background?: string }>({});
  const uploadFilesRef = useRef<{ logo?: File; background?: File }>({});

  const [settings, setSettings] = useState<VisualizerSettings>(defaultSettings);
  const [audio, setAudio] = useState<LoadedAudio | null>(null);
  const [assets, setAssets] = useState<RenderAssets>({});
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState("");
  const [resolution, setResolution] = useState<ExportResolution>("1080p");
  const [fps, setFps] = useState<ExportFps>(30);
  const [exportProgress, setExportProgress] = useState<ExportProgress>({
    status: "idle",
    progress: 0,
    message: "Ready to export once audio is loaded."
  });

  settingsRef.current = settings;
  assetsRef.current = assets;

  const recorderMime = useMemo(() => pickRecorderMimeType(), []);
  const recorderExt = recorderMime ? extensionForMime(recorderMime).toUpperCase() : "Unavailable";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    rendererRef.current = new VisualizerRenderer(canvas);

    const resizePreview = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      rendererRef.current?.resize(Math.max(640, Math.floor(rect.width * dpr)), Math.max(360, Math.floor(rect.height * dpr)));
    };

    const render = (timeMs: number) => {
      resizePreview();
      const fadeLevel = getFadeLevel(audioRef.current?.currentTime ?? 0, audio?.duration ?? 0, settingsRef.current.fadeIn, settingsRef.current.fadeOut);
      analyzerRef.current.setOutputGain(fadeLevel);
      const metrics = analyzerRef.current.getMetrics(settingsRef.current);
      rendererRef.current?.drawFrame(settingsRef.current, metrics, assetsRef.current, timeMs / 1000);
      animationRef.current = requestAnimationFrame(render);
    };

    resizePreview();
    animationRef.current = requestAnimationFrame(render);
    window.addEventListener("resize", resizePreview);
    return () => {
      cancelAnimationFrame(animationRef.current);
      window.removeEventListener("resize", resizePreview);
    };
  }, [audio]);

  useEffect(() => {
    return () => {
      revokeUrl(urlsRef.current.audio);
      revokeUrl(urlsRef.current.logo);
      revokeUrl(urlsRef.current.background);
      if (exportProgress.downloadUrl) revokeUrl(exportProgress.downloadUrl);
    };
  }, [exportProgress.downloadUrl]);

  async function onAudioUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    try {
      const loaded = await analyzerRef.current.loadAudio(file);
      revokeUrl(urlsRef.current.audio);
      urlsRef.current.audio = loaded.url;
      setAudio(loaded);
      if (audioRef.current) {
        audioRef.current.src = loaded.url;
        audioRef.current.load();
        await analyzerRef.current.connectElement(audioRef.current);
      }
      setExportProgress({ status: "idle", progress: 0, message: "Audio loaded. Preview it, then export when ready." });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that audio file.");
    }
  }

  async function onImageUpload(event: ChangeEvent<HTMLInputElement>, kind: "logo" | "background") {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    try {
      const loaded = await loadImageFile(file);
      revokeUrl(urlsRef.current[kind]);
      urlsRef.current[kind] = loaded.url;
      uploadFilesRef.current[kind] = file;
      setAssets((current) => ({ ...current, [kind]: loaded.image }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that image.");
    }
  }

  async function togglePlayback() {
    if (!audioRef.current || !audio) return;
    setError("");
    await analyzerRef.current.connectElement(audioRef.current);
    if (audioRef.current.paused) {
      await audioRef.current.play();
      setIsPlaying(true);
    } else {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  }

  function updateSetting<K extends keyof VisualizerSettings>(key: K, value: VisualizerSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function applyPreset(preset: Partial<VisualizerSettings>) {
    setSettings((current) => ({ ...current, ...preset }));
  }

  function handleExport() {
    if (!audio) {
      setError("Upload an audio file before exporting.");
      return;
    }

    if (resolution === "4k") {
      setExportProgress({
        status: "preparing",
        progress: 0,
        message: "4K export is memory-heavy. If the encoder stalls, switch to 1080p or 1440p."
      });
    }

    setError("");
    const controller = new AbortController();
    exportCancelRef.current = () => controller.abort();
    setExportProgress({ status: "recording", progress: 0.02, message: `Backend rendering ${resolutionMap[resolution].label} at ${fps} FPS. This may take a while, but it should be smooth.` });

    startBackendExport({ audio, settings, resolution, fps, logo: uploadFilesRef.current.logo, background: uploadFilesRef.current.background, signal: controller.signal, onProgress: setExportProgress })
      .then((result) => {
        setExportProgress({
          status: "done",
          progress: 1,
          message: "Backend render complete (MP4).",
          downloadUrl: result.url,
          filename: result.filename
        });
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          setExportProgress({ status: "cancelled", progress: 0, message: "Backend export cancelled." });
          return;
        }
        setError(err instanceof Error ? err.message : "Backend export could not start.");
        setExportProgress({ status: "error", progress: 0, message: "Backend export failed. Make sure the render server is running." });
      })
      .finally(() => {
        exportCancelRef.current = null;
      });
  }

  function cancelExport() {
    exportCancelRef.current?.();
  }

  return (
    <main className="appShell">
      <section className="stage">
        <header className="topbar">
          <div>
            <p className="eyebrow">Browser-only visualizer generator</p>
            <h1>Spectrum Studio</h1>
          </div>
          <div className="statusPill">{recorderExt} export</div>
        </header>

        <div className="previewFrame">
          <canvas ref={canvasRef} aria-label="Realtime music visualizer preview" />
        </div>

        <div className="transport">
          <button className="primaryButton" onClick={togglePlayback} disabled={!audio}>
            {isPlaying ? "Pause Preview" : "Play Preview"}
          </button>
          <audio ref={audioRef} onEnded={() => setIsPlaying(false)} controls />
        </div>

        {error && <div className="errorBox">{error}</div>}
      </section>

      <aside className="controlPanel">
        <Section title="Sources">
          <FileControl label="Audio" accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac,.flac" onChange={onAudioUpload} note={audio ? `${audio.file.name} - ${formatDuration(audio.duration)}` : "MP3, WAV, M4A, OGG, AAC, FLAC"} />
          <FileControl label="Center logo" accept="image/*" onChange={(event) => onImageUpload(event, "logo")} note={assets.logo ? "Logo loaded" : "PNG with transparency works best"} />
          <div className="cropTools">
            <Toggle label="Circle crop logo" checked={settings.cropLogoCircle} onChange={(v) => updateSetting("cropLogoCircle", v)} />
            <Slider label="Crop zoom" value={settings.logoCropZoom} min={0.6} max={2.4} step={0.01} onChange={(v) => updateSetting("logoCropZoom", v)} />
            <Slider label="Crop X" value={settings.logoCropX} min={-1} max={1} step={0.01} onChange={(v) => updateSetting("logoCropX", v)} />
            <Slider label="Crop Y" value={settings.logoCropY} min={-1} max={1} step={0.01} onChange={(v) => updateSetting("logoCropY", v)} />
          </div>
          <FileControl label="Background" accept="image/*" onChange={(event) => onImageUpload(event, "background")} note={assets.background ? "Background loaded" : "Optional image backdrop"} />
        </Section>

        <Section title="Presets">
          <div className="presetGrid">
            {presets.map((preset) => (
              <button key={preset.name} onClick={() => applyPreset(preset.settings)}>{preset.name}</button>
            ))}
          </div>
        </Section>

        <Section title="Visualizer">
          <label className="field">
            <span>Style</span>
            <select value={settings.style} onChange={(event) => updateSetting("style", event.target.value as VisualizerStyle)}>
              <option value="circular">Circular spectrum</option>
              <option value="bars">Horizontal bars</option>
              <option value="waveform">Waveform ring</option>
              <option value="particles">Particle pulse</option>
            </select>
          </label>
          <ColorRow label="Colors" settings={settings} onChange={updateSetting} />
          <Slider label="Logo size" value={settings.logoSize} min={0.12} max={0.42} step={0.01} onChange={(v) => updateSetting("logoSize", v)} />
          <Slider label="Spectrum radius" value={settings.spectrumRadius} min={0.16} max={0.42} step={0.01} onChange={(v) => updateSetting("spectrumRadius", v)} />
          <Slider label="Bar height" value={settings.barHeight} min={0.08} max={0.38} step={0.01} onChange={(v) => updateSetting("barHeight", v)} />
          <Slider label="Glow" value={settings.glowAmount} min={0} max={1.5} step={0.01} onChange={(v) => updateSetting("glowAmount", v)} />
        </Section>

        <Section title="Audio Response">
          <Slider label="Bass sensitivity" value={settings.bassSensitivity} min={0.4} max={2.4} step={0.01} onChange={(v) => updateSetting("bassSensitivity", v)} />
          <Slider label="Smoothing" value={settings.smoothing} min={0.1} max={0.94} step={0.01} onChange={(v) => updateSetting("smoothing", v)} />
          <Slider label="Bass boost" value={settings.bassBoost} min={0.6} max={2.5} step={0.01} onChange={(v) => updateSetting("bassBoost", v)} />
          <Slider label="Kick threshold" value={settings.kickThreshold} min={0.16} max={0.8} step={0.01} onChange={(v) => updateSetting("kickThreshold", v)} />
          <Slider label="Fade in seconds" value={settings.fadeIn} min={0} max={12} step={0.25} onChange={(v) => updateSetting("fadeIn", v)} />
          <Slider label="Fade out seconds" value={settings.fadeOut} min={0} max={12} step={0.25} onChange={(v) => updateSetting("fadeOut", v)} />
          <Toggle label="Bass pulse" checked={settings.bassPulse} onChange={(v) => updateSetting("bassPulse", v)} />
          <Toggle label="Waveform layer" checked={settings.waveform} onChange={(v) => updateSetting("waveform", v)} />
        </Section>

        <Section title="Background">
          <Slider label="Blur" value={settings.backgroundBlur} min={0} max={24} step={1} onChange={(v) => updateSetting("backgroundBlur", v)} />
          <Slider label="Brightness" value={settings.backgroundBrightness} min={0.25} max={1.25} step={0.01} onChange={(v) => updateSetting("backgroundBrightness", v)} />
          <Slider label="Dark overlay" value={settings.darkOverlay} min={0} max={0.78} step={0.01} onChange={(v) => updateSetting("darkOverlay", v)} />
          <Toggle label="Particles" checked={settings.particles} onChange={(v) => updateSetting("particles", v)} />
          <Toggle label="Background movement" checked={settings.backgroundMotion} onChange={(v) => updateSetting("backgroundMotion", v)} />
        </Section>

        <Section title="Export">
          <label className="field">
            <span>Resolution</span>
            <select value={resolution} onChange={(event) => setResolution(event.target.value as ExportResolution)}>
              {Object.entries(resolutionMap).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>FPS</span>
            <select value={fps} onChange={(event) => setFps(Number(event.target.value) as ExportFps)}>
              <option value={30}>30</option>
              <option value={60}>60</option>
            </select>
          </label>
          <div className="progressTrack">
            <div style={{ width: `${Math.round(exportProgress.progress * 100)}%` }} />
          </div>
          <p className="hint">{exportProgress.message}</p>
          <div className="buttonRow">
            <button className="primaryButton" onClick={handleExport} disabled={!audio || exportProgress.status === "recording"}>Export Video</button>
            {exportProgress.status === "recording" && <button onClick={cancelExport}>Cancel</button>}
          </div>
          {exportProgress.downloadUrl && (
            <a className="downloadButton" href={exportProgress.downloadUrl} download={exportProgress.filename}>Download {exportProgress.filename}</a>
          )}
        </Section>
      </aside>
    </main>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return <section className="panelSection"><h2>{props.title}</h2>{props.children}</section>;
}

function FileControl(props: { label: string; accept: string; onChange: (event: ChangeEvent<HTMLInputElement>) => void; note: string }) {
  return (
    <label className="fileControl">
      <span>{props.label}</span>
      <input type="file" accept={props.accept} onChange={props.onChange} />
      <small>{props.note}</small>
    </label>
  );
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <span>{props.label}<b>{formatValue(props.value)}</b></span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(event) => props.onChange(Number(event.target.value))} />
    </label>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle">
      <span>{props.label}</span>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
    </label>
  );
}

function ColorRow(props: { label: string; settings: VisualizerSettings; onChange: <K extends keyof VisualizerSettings>(key: K, value: VisualizerSettings[K]) => void }) {
  return (
    <div className="colorRow">
      <span>{props.label}</span>
      <input title="Primary color" type="color" value={props.settings.primaryColor} onChange={(event) => props.onChange("primaryColor", event.target.value)} />
      <input title="Secondary color" type="color" value={props.settings.secondaryColor} onChange={(event) => props.onChange("secondaryColor", event.target.value)} />
      <input title="Glow color" type="color" value={props.settings.glowColor} onChange={(event) => props.onChange("glowColor", event.target.value)} />
    </div>
  );
}

function formatDuration(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function formatValue(value: number) {
  return value >= 2 ? value.toFixed(0) : value.toFixed(2);
}
function getFadeLevel(time: number, duration: number, fadeIn: number, fadeOut: number) {
  if (duration <= 0) return 1;
  const inLevel = fadeIn <= 0 ? 1 : Math.min(1, time / fadeIn);
  const outRemaining = Math.max(0, duration - time);
  const outLevel = fadeOut <= 0 ? 1 : Math.min(1, outRemaining / fadeOut);
  return Math.max(0, Math.min(inLevel, outLevel));
}
async function startBackendExport(params: {
  audio: LoadedAudio;
  settings: VisualizerSettings;
  resolution: ExportResolution;
  fps: ExportFps;
  logo?: File;
  background?: File;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
}) {
  const form = new FormData();
  const size = resolutionMap[params.resolution];
  form.append("audio", params.audio.file, params.audio.file.name);
  if (params.logo) form.append("logo", params.logo, params.logo.name);
  if (params.background) form.append("background", params.background.name ? params.background : params.background, params.background.name);
  form.append("settings", JSON.stringify(params.settings));
  form.append("width", String(size.width));
  form.append("height", String(size.height));
  form.append("fps", String(params.fps));

  const startResponse = await fetch("http://127.0.0.1:8787/api/render-job", {
    method: "POST",
    body: form,
    signal: params.signal
  });

  if (!startResponse.ok) throw new Error(await readBackendError(startResponse));
  const { jobId } = await startResponse.json();
  let filename = `spectrum-studio-${size.width}x${size.height}-${params.fps}fps.mp4`;

  while (true) {
    await delay(700, params.signal);
    const statusResponse = await fetch(`http://127.0.0.1:8787/api/render-job/${jobId}`, { signal: params.signal });
    if (!statusResponse.ok) throw new Error(await readBackendError(statusResponse));
    const status = await statusResponse.json();
    filename = status.filename ?? filename;

    params.onProgress({
      status: status.status === "done" ? "finalizing" : "recording",
      progress: Math.max(0.02, Math.min(1, Number(status.progress ?? 0))),
      message: status.message ?? "Backend render is running."
    });

    if (status.status === "error") throw new Error(status.error ?? "Backend render failed.");
    if (status.status === "done") break;
  }

  const downloadResponse = await fetch(`http://127.0.0.1:8787/api/render-job/${jobId}/download`, { signal: params.signal });
  if (!downloadResponse.ok) throw new Error(await readBackendError(downloadResponse));
  const blob = await downloadResponse.blob();
  return {
    url: URL.createObjectURL(blob),
    filename
  };
}

async function readBackendError(response: Response) {
  try {
    const payload = await response.json();
    if (payload?.error) return payload.error;
  } catch {
    // Non-JSON error body.
  }
  return "Backend render failed.";
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

