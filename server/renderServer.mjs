import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import ffmpegPath from "ffmpeg-static";
import FFT from "fft.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const app = express();
const upload = multer({ dest: path.join(os.tmpdir(), "spectrum-studio-uploads") });
const PORT = Number(process.env.RENDER_PORT ?? 8787);
const SAMPLE_RATE = 44100;
const FFT_SIZE = 2048;

app.use(cors({ origin: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true, renderer: "ffmpeg-backend" }));
const jobs = new Map();

app.post("/api/render-job", upload.fields([
  { name: "audio", maxCount: 1 },
  { name: "logo", maxCount: 1 },
  { name: "background", maxCount: 1 }
]), async (req, res) => {
  const files = req.files ?? {};
  const audioFile = files.audio?.[0];
  const logoFile = files.logo?.[0];
  const backgroundFile = files.background?.[0];
  if (!audioFile) return res.status(400).json({ error: "Audio file is required." });

  const jobId = randomUUID();
  const job = {
    id: jobId,
    status: "queued",
    progress: 0,
    frame: 0,
    totalFrames: 0,
    message: "Queued render job.",
    outputPath: null,
    tmpDir: null,
    filename: null,
    error: null
  };
  jobs.set(jobId, job);
  res.json({ jobId });

  runRenderJob(job, req.body, audioFile, logoFile, backgroundFile).catch((error) => {
    job.status = "error";
    job.error = error instanceof Error ? error.message : "Backend render failed.";
    job.message = job.error;
    cleanup([job.tmpDir, audioFile, logoFile, backgroundFile]);
  });
});

app.get("/api/render-job/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Render job not found." });
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    frame: job.frame,
    totalFrames: job.totalFrames,
    message: job.message,
    filename: job.filename,
    error: job.error
  });
});

app.get("/api/render-job/:jobId/download", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Render job not found." });
  if (job.status !== "done" || !job.outputPath) return res.status(409).json({ error: "Render job is not complete yet." });

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${job.filename}"`);
  fssync.createReadStream(job.outputPath).pipe(res);
  res.on("finish", () => {
    cleanup([job.tmpDir]);
    jobs.delete(job.id);
  });
});

async function runRenderJob(job, body, audioFile, logoFile, backgroundFile) {
  const settings = JSON.parse(body.settings ?? "{}");
  const width = Number(body.width ?? 2560);
  const height = Number(body.height ?? 1440);
  const fps = Number(body.fps ?? 60);
  const durationLimit = Number(body.durationLimit ?? 0);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spectrum-studio-render-"));
  const outPath = path.join(tmpDir, "visualizer.mp4");
  job.tmpDir = tmpDir;
  job.filename = `spectrum-studio-${width}x${height}-${fps}fps.mp4`;

  job.status = "decoding";
  job.progress = 0.02;
  job.message = "Decoding audio.";
  const pcm = await decodeAudio(audioFile.path);
  const duration = durationLimit > 0 ? Math.min(durationLimit, pcm.length / SAMPLE_RATE) : pcm.length / SAMPLE_RATE;
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  job.totalFrames = totalFrames;

  job.status = "preparing";
  job.progress = 0.04;
  job.message = "Loading render assets.";
  const logo = logoFile ? await loadImage(logoFile.path) : undefined;
  const background = backgroundFile ? await loadImage(backgroundFile.path) : undefined;
  const renderer = new BackendRenderer(width, height, settings, logo, background, pcm);

  const ffmpeg = spawn(ffmpegPath, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-f", "image2pipe",
    "-framerate", String(fps),
    "-i", "pipe:0",
    "-i", audioFile.path,
    "-t", duration.toFixed(3),
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level", width >= 2560 && fps >= 60 ? "5.2" : "4.2",
    "-movflags", "+faststart",
    "-c:a", "aac",
    "-b:a", "320k",
    "-shortest",
    outPath
  ], { stdio: ["pipe", "pipe", "pipe"] });

  let ffmpegError = "";
  ffmpeg.stderr.on("data", (chunk) => { ffmpegError += chunk.toString(); });

  job.status = "rendering";
  job.message = `Rendering frame 0 / ${totalFrames}.`;
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const time = frame / fps;
    const png = renderer.renderFrame(time, duration);
    if (!ffmpeg.stdin.write(png)) await onceDrain(ffmpeg.stdin);
    job.frame = frame + 1;
    job.progress = 0.05 + ((frame + 1) / totalFrames) * 0.9;
    if (frame % Math.max(1, Math.floor(fps / 2)) === 0 || frame + 1 === totalFrames) {
      job.message = `Rendering frame ${frame + 1} / ${totalFrames}.`;
    }
  }
  ffmpeg.stdin.end();

  job.status = "encoding";
  job.progress = 0.97;
  job.message = "Finalizing MP4.";
  const code = await waitForExit(ffmpeg);
  if (code !== 0) throw new Error(ffmpegError || `FFmpeg exited with code ${code}`);

  cleanup([audioFile, logoFile, backgroundFile]);
  job.status = "done";
  job.progress = 1;
  job.outputPath = outPath;
  job.message = "Render complete.";
}

app.post("/api/render", upload.fields([
  { name: "audio", maxCount: 1 },
  { name: "logo", maxCount: 1 },
  { name: "background", maxCount: 1 }
]), async (req, res) => {
  const files = req.files ?? {};
  const audioFile = files.audio?.[0];
  const logoFile = files.logo?.[0];
  const backgroundFile = files.background?.[0];
  if (!audioFile) return res.status(400).json({ error: "Audio file is required." });

  const settings = JSON.parse(req.body.settings ?? "{}");
  const width = Number(req.body.width ?? 2560);
  const height = Number(req.body.height ?? 1440);
  const fps = Number(req.body.fps ?? 60);
  const durationLimit = Number(req.body.durationLimit ?? 0);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spectrum-studio-render-"));
  const outPath = path.join(tmpDir, "visualizer.mp4");

  try {
    const pcm = await decodeAudio(audioFile.path);
    const duration = durationLimit > 0 ? Math.min(durationLimit, pcm.length / SAMPLE_RATE) : pcm.length / SAMPLE_RATE;
    const totalFrames = Math.max(1, Math.ceil(duration * fps));
    const logo = logoFile ? await loadImage(logoFile.path) : undefined;
    const background = backgroundFile ? await loadImage(backgroundFile.path) : undefined;
    const renderer = new BackendRenderer(width, height, settings, logo, background, pcm);

    const ffmpeg = spawn(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-f", "image2pipe",
      "-framerate", String(fps),
      "-i", "pipe:0",
      "-i", audioFile.path,
      "-t", duration.toFixed(3),
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", "16",
      "-pix_fmt", "yuv420p",
      "-profile:v", "high",
      "-level", width >= 2560 && fps >= 60 ? "5.2" : "4.2",
      "-movflags", "+faststart",
      "-c:a", "aac",
      "-b:a", "320k",
      "-shortest",
      outPath
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let ffmpegError = "";
    ffmpeg.stderr.on("data", (chunk) => { ffmpegError += chunk.toString(); });

    for (let frame = 0; frame < totalFrames; frame += 1) {
      const time = frame / fps;
      const png = renderer.renderFrame(time, duration);
      if (!ffmpeg.stdin.write(png)) await onceDrain(ffmpeg.stdin);
    }
    ffmpeg.stdin.end();

    const code = await waitForExit(ffmpeg);
    if (code !== 0) throw new Error(ffmpegError || `FFmpeg exited with code ${code}`);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="spectrum-studio-${width}x${height}-${fps}fps.mp4"`);
    fssync.createReadStream(outPath).pipe(res);
    res.on("finish", () => cleanup([tmpDir, audioFile, logoFile, backgroundFile]));
  } catch (error) {
    cleanup([tmpDir, audioFile, logoFile, backgroundFile]);
    res.status(500).json({ error: error instanceof Error ? error.message : "Backend render failed." });
  }
});

app.listen(PORT, () => {
  console.log(`Spectrum Studio render server listening on http://127.0.0.1:${PORT}`);
});

class BackendRenderer {
  constructor(width, height, settings, logo, background, pcm) {
    this.width = width;
    this.height = height;
    this.settings = settings;
    this.logo = logo;
    this.background = background;
    this.pcm = pcm;
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext("2d");
    this.fft = new FFT(FFT_SIZE);
    this.fftInput = new Array(FFT_SIZE).fill(0);
    this.fftOutput = this.fft.createComplexArray();
    this.frequencyData = new Uint8Array(FFT_SIZE / 2);
    this.waveformData = new Uint8Array(FFT_SIZE);
    this.smoothBass = 0;
    this.slowBass = 0;
    this.bassFloor = 0.08;
    this.bassPeak = 0.35;
    this.lastBass = 0;
    this.pulse = 0;
    this.kickCooldown = 0;
    this.particles = makeTunnelParticles(90);
  }

  renderFrame(time, duration) {
    const metrics = this.analyze(time);
    const fade = getFadeLevel(time, duration, this.settings.fadeIn ?? 0, this.settings.fadeOut ?? 0);
    metrics.bass *= fade;
    metrics.bassPulse *= fade;
    this.draw(metrics, time);
    return this.canvas.encodeSync("png");
  }

  analyze(time) {
    const center = Math.floor(time * SAMPLE_RATE);
    const half = FFT_SIZE / 2;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const sample = this.pcm[center - half + i] ?? 0;
      const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
      this.fftInput[i] = sample * win;
      this.waveformData[i] = Math.max(0, Math.min(255, Math.round(128 + sample * 128)));
    }
    this.fft.realTransform(this.fftOutput, this.fftInput);

    for (let i = 0; i < this.frequencyData.length; i += 1) {
      const re = this.fftOutput[i * 2] ?? 0;
      const im = this.fftOutput[i * 2 + 1] ?? 0;
      const mag = Math.sqrt(re * re + im * im) / 18;
      this.frequencyData[i] = Math.max(0, Math.min(255, Math.round(mag * 255)));
    }

    const s = this.settings;
    const bassRaw = this.weightedBandAverage(28, 150, 1.45);
    const subBass = this.weightedBandAverage(35, 80, 1.9);
    const bass = (bassRaw * 0.58 + subBass * 0.42) * (s.bassBoost ?? 1.5);
    const mids = this.weightedBandAverage(180, 2200, 0.85);
    const highs = this.weightedBandAverage(2600, 11000, 0.75);
    const smooth = clamp(s.smoothing ?? 0.7, 0.05, 0.96);

    this.smoothBass = lerp(bass, this.smoothBass, smooth * 0.82);
    this.slowBass = lerp(bass, this.slowBass, 0.955);
    this.bassFloor = lerp(Math.min(this.bassFloor, this.slowBass), this.bassFloor, 0.985);
    this.bassPeak = lerp(Math.max(this.bassPeak, this.smoothBass), this.bassPeak, 0.975);
    const bassVelocity = Math.max(0, this.smoothBass - this.lastBass);
    const normalizedBass = clamp((this.smoothBass - this.bassFloor) / Math.max(0.08, this.bassPeak - this.bassFloor), 0, 1);
    const localLift = this.smoothBass - this.slowBass;
    const kick = this.kickCooldown <= 0 && normalizedBass > clamp(s.kickThreshold ?? 0.38, 0.16, 0.8) && (bassVelocity > 0.012 || localLift > 0.035);
    this.kickCooldown = kick ? 7 : Math.max(0, this.kickCooldown - 1);
    const sensitivity = Math.max(s.bassSensitivity ?? 0.9, 0.2);
    const targetPulse = kick ? Math.min(1, 0.32 + normalizedBass * 0.78 * sensitivity) : Math.min(1, normalizedBass * 0.42 * sensitivity + this.smoothBass * 0.18);
    this.pulse = Math.max(targetPulse, this.pulse * 0.86);
    this.lastBass = this.smoothBass;

    return {
      bass: clamp(normalizedBass * sensitivity, 0, 1),
      mids: clamp(mids * 0.58, 0, 1),
      highs: clamp(highs * 0.5, 0, 1),
      bassPulse: clamp(this.pulse, 0, 1),
      frequencyData: this.frequencyData,
      waveformData: this.waveformData
    };
  }

  weightedBandAverage(lowHz, highHz, lowWeight) {
    const nyquist = SAMPLE_RATE / 2;
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

  draw(metrics, time) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const min = Math.min(w, h);
    const cx = w / 2;
    const cy = h / 2;
    const s = this.settings;
    ctx.save();
    ctx.fillStyle = "#070812";
    ctx.fillRect(0, 0, w, h);

    if (this.background) {
      const motion = s.backgroundMotion ? Math.sin(time * 0.22) * 0.018 + metrics.bassPulse * 0.035 : 0;
      const scale = Math.max(w / this.background.width, h / this.background.height) * (1.08 + motion);
      const dw = this.background.width * scale;
      const dh = this.background.height * scale;
      const dx = (w - dw) / 2 + Math.sin(time * 0.13) * w * 0.018;
      const dy = (h - dh) / 2 + Math.cos(time * 0.11) * h * 0.018;
      ctx.filter = `blur(${s.backgroundBlur ?? 7}px) brightness(${s.backgroundBrightness ?? 0.65}) saturate(1.12)`;
      ctx.drawImage(this.background, dx, dy, dw, dh);
      ctx.filter = "none";
    } else {
      const gradient = ctx.createRadialGradient(w * 0.5, h * 0.48, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
      gradient.addColorStop(0, "#182338");
      gradient.addColorStop(0.42, "#0d1222");
      gradient.addColorStop(1, "#04050b");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.fillStyle = `rgba(0,0,0,${s.darkOverlay ?? 0.45})`;
    ctx.fillRect(0, 0, w, h);
    if (s.particles) this.drawTunnelParticles(ctx, metrics, time, cx, cy, min);

    ctx.translate(cx, cy);
    ctx.globalCompositeOperation = "lighter";
    this.drawOuterGlow(ctx, metrics, min);
    if (s.style === "bars") this.drawHorizontalBars(ctx, metrics, w, min);
    if (s.style === "waveform") this.drawWaveformRing(ctx, metrics, min, 0.82);
    if (s.style === "particles") this.drawParticlePulse(ctx, metrics, min, time);
    if (!s.style || s.style === "circular") this.drawCircularSpectrum(ctx, metrics, min);
    if (s.waveform && s.style !== "waveform") this.drawWaveformRing(ctx, metrics, min, 0.45);
    ctx.globalCompositeOperation = "source-over";
    this.drawLogo(ctx, metrics, min);
    ctx.restore();
  }

  drawCircularSpectrum(ctx, metrics, min) {
    const s = this.settings;
    const bins = metrics.frequencyData;
    const count = 192;
    const radius = min * (s.spectrumRadius ?? 0.27) * (1 + metrics.bassPulse * 0.055);
    const maxBar = min * (s.barHeight ?? 0.22);
    ctx.save();
    ctx.lineCap = "round";
    ctx.shadowColor = s.glowColor ?? "#78ffdb";
    ctx.shadowBlur = min * 0.034 * (s.glowAmount ?? 0.9);
    for (let i = 0; i < count; i += 1) {
      const mirrored = i < count / 2 ? i : count - i;
      const t = mirrored / (count / 2);
      const bassIndex = Math.floor(t * bins.length * 0.075);
      const bodyIndex = Math.floor(t * bins.length * 0.18);
      const bassValue = (bins[bassIndex] ?? 0) / 255;
      const bodyValue = (bins[bodyIndex] ?? 0) / 255;
      const value = Math.pow(bassValue * 0.72 + bodyValue * 0.18 + metrics.bass * 0.1, 1.55);
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const length = maxBar * (0.04 + value * 0.72 + metrics.bassPulse * 0.18);
      ctx.strokeStyle = i / count < 0.5 ? s.primaryColor ?? "#35f2ff" : s.secondaryColor ?? "#ff3df2";
      ctx.globalAlpha = 0.72 + value * 0.28;
      ctx.lineWidth = Math.max(3, min * 0.0038);
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      ctx.lineTo(Math.cos(angle) * (radius + length), Math.sin(angle) * (radius + length));
      ctx.stroke();
    }
    ctx.restore();
  }

  drawWaveformRing(ctx, metrics, min, alpha = 0.82) {
    const s = this.settings;
    const radius = min * ((s.spectrumRadius ?? 0.27) + 0.06);
    ctx.save();
    ctx.strokeStyle = s.secondaryColor ?? "#ff3df2";
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(2, min * 0.003);
    ctx.shadowColor = s.secondaryColor ?? "#ff3df2";
    ctx.shadowBlur = min * 0.02 * (s.glowAmount ?? 0.9);
    ctx.beginPath();
    for (let i = 0; i <= 256; i += 1) {
      const sample = (metrics.waveformData[Math.floor((i / 256) * (metrics.waveformData.length - 1))] - 128) / 128;
      const angle = (i / 256) * Math.PI * 2 - Math.PI / 2;
      const r = radius + sample * min * 0.032 + metrics.bassPulse * min * 0.015;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  drawHorizontalBars(ctx, metrics, width, min) {
    const s = this.settings;
    const bins = metrics.frequencyData;
    const bars = 96;
    const span = width * 0.76;
    const barWidth = span / bars;
    const maxHeight = min * (s.barHeight ?? 0.22) * 0.65;
    ctx.save();
    ctx.shadowColor = s.glowColor ?? "#78ffdb";
    ctx.shadowBlur = min * 0.03 * (s.glowAmount ?? 0.9);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < bars; i += 1) {
        const bin = Math.floor((i / bars) * bins.length * 0.72);
        const value = Math.pow((bins[bin] ?? 0) / 255, 1.22);
        const h = maxHeight * (0.08 + value + metrics.bass * 0.2);
        const x = -span / 2 + i * barWidth;
        ctx.fillStyle = i % 2 ? s.primaryColor ?? "#35f2ff" : s.secondaryColor ?? "#ff3df2";
        ctx.globalAlpha = 0.72;
        ctx.fillRect(x, side * (min * 0.22), barWidth * 0.56, side * h);
      }
    }
    ctx.restore();
  }

  drawParticlePulse(ctx, metrics, min, time) {
    const s = this.settings;
    const radius = min * (s.spectrumRadius ?? 0.27) * (1.1 + metrics.bassPulse * 0.2);
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.shadowColor = s.glowColor ?? "#78ffdb";
    ctx.shadowBlur = min * 0.03 * (s.glowAmount ?? 0.9);
    for (let i = 0; i < 160; i += 1) {
      const angle = (i / 160) * Math.PI * 2 + time * 0.04;
      const wave = Math.sin(i * 0.17 + time * 2.2) * min * 0.018;
      const r = radius + wave + ((metrics.frequencyData[i % metrics.frequencyData.length] ?? 0) / 255) * min * 0.12;
      ctx.fillStyle = i % 3 ? s.primaryColor ?? "#35f2ff" : s.secondaryColor ?? "#ff3df2";
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * r, Math.sin(angle) * r, min * 0.0035, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  drawOuterGlow(ctx, metrics, min) {
    const s = this.settings;
    const radius = min * (s.spectrumRadius ?? 0.27) * (1 + metrics.bassPulse * 0.12);
    const gradient = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius * 1.8);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.45, hexToRgba(s.glowColor ?? "#78ffdb", 0.11 * (s.glowAmount ?? 0.9)));
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.9, 0, Math.PI * 2);
    ctx.fill();
  }

  drawLogo(ctx, metrics, min) {
    const s = this.settings;
    const size = min * (s.logoSize ?? 0.23) * (1 + metrics.bassPulse * 0.1);
    ctx.save();
    ctx.shadowColor = s.glowColor ?? "#78ffdb";
    ctx.shadowBlur = min * 0.055 * (s.glowAmount ?? 0.9);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(8,10,18,0.74)";
    ctx.fill();
    if (this.logo) {
      const diameter = size * 1.18;
      ctx.save();
      if (s.cropLogoCircle !== false) {
        ctx.beginPath();
        ctx.arc(0, 0, diameter / 2, 0, Math.PI * 2);
        ctx.clip();
      }
      const scaleMode = s.cropLogoCircle !== false ? Math.max : Math.min;
      const scale = scaleMode(diameter / this.logo.width, diameter / this.logo.height) * (s.logoCropZoom ?? 1);
      const dw = this.logo.width * scale;
      const dh = this.logo.height * scale;
      ctx.drawImage(this.logo, -dw / 2 + (s.logoCropX ?? 0) * diameter * 0.5, -dh / 2 + (s.logoCropY ?? 0) * diameter * 0.5, dw, dh);
      ctx.restore();
    }
    ctx.restore();
  }

  drawTunnelParticles(ctx, metrics, time, cx, cy, min) {
    if (!this.settings.particles) return;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalCompositeOperation = "lighter";
    for (const p of this.particles) {
      const depthRaw = (p.radius - (time * p.speed * 0.12 + metrics.bassPulse * 0.08)) % 1;
      const depth = depthRaw < 0 ? depthRaw + 1 : depthRaw;
      const spread = Math.pow(depth, 1.85);
      const r = min * (0.18 + spread * 0.68);
      const x = Math.cos(p.angle) * r;
      const y = Math.sin(p.angle) * r;
      const tailX = Math.cos(p.angle) * r * 0.84;
      const tailY = Math.sin(p.angle) * r * 0.84;
      ctx.globalAlpha = (1 - depth) * p.alpha * (0.35 + metrics.bassPulse * 0.9);
      ctx.strokeStyle = p.angle % 2 > 1 ? this.settings.primaryColor ?? "#35f2ff" : this.settings.secondaryColor ?? "#ff3df2";
      ctx.lineWidth = Math.max(1, p.size * min * (1.25 - depth));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function decodeAudio(filePath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", filePath, "-f", "f32le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let err = "";
    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => { err += chunk.toString(); });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code !== 0) return reject(new Error(err || `Audio decode failed with code ${code}`));
      const buffer = Buffer.concat(chunks);
      resolve(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
    });
  });
}

function onceDrain(stream) {
  return new Promise((resolve) => stream.once("drain", resolve));
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
}

function cleanup(items) {
  for (const item of items) {
    if (!item) continue;
    const target = typeof item === "string" ? item : item.path;
    if (!target) continue;
    fs.rm(target, { recursive: true, force: true }).catch(() => {});
  }
}

function getFadeLevel(time, duration, fadeIn, fadeOut) {
  const inLevel = fadeIn <= 0 ? 1 : Math.min(1, time / fadeIn);
  const outRemaining = Math.max(0, duration - time);
  const outLevel = fadeOut <= 0 ? 1 : Math.min(1, outRemaining / fadeOut);
  return Math.max(0, Math.min(inLevel, outLevel));
}

function makeTunnelParticles(count) {
  return Array.from({ length: count }, (_, i) => {
    const n = pseudoRandom(i + 11);
    return {
      angle: pseudoRandom(i + 1) * Math.PI * 2,
      radius: 0.22 + pseudoRandom(i + 2) * 0.58,
      speed: 0.01 + pseudoRandom(i + 3) * 0.035,
      size: 0.0016 + n * 0.0035,
      alpha: 0.18 + pseudoRandom(i + 4) * 0.52
    };
  });
}

function pseudoRandom(seed) {
  const x = Math.sin(seed * 999) * 10000;
  return x - Math.floor(x);
}

function lerp(next, prev, smoothing) {
  return prev * smoothing + next * (1 - smoothing);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgba(hex, alpha) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized.length === 3 ? normalized.split("").map((c) => c + c).join("") : normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}




