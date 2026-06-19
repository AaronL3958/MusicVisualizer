export function createVisualizerCore(canvas) {
  return new SharedVisualizerCore(canvas);
}

class SharedVisualizerCore {
  constructor(canvas) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D rendering is not available.");
    this.ctx = ctx;
    this.seedParticles();
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  drawFrame(settings, metrics, assets, time) {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const minSide = Math.min(width, height);
    const cx = width / 2;
    const cy = height / 2;
    const pulse = settings.bassPulse ? metrics.bassPulse : 0;

    this.drawBackground(settings, assets?.background, time, pulse);
    if (settings.particles) this.drawParticles(settings, metrics, time, cx, cy, minSide);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalCompositeOperation = "lighter";
    this.drawOuterGlow(settings, metrics, minSide);

    if (settings.style === "bars") this.drawHorizontalBars(settings, metrics, width, minSide);
    if (settings.style === "waveform") this.drawWaveformRing(settings, metrics, minSide);
    if (settings.style === "particles") this.drawParticlePulse(settings, metrics, minSide, time);
    if (!settings.style || settings.style === "circular") this.drawCircularSpectrum(settings, metrics, minSide);
    if (settings.waveform && settings.style !== "waveform") this.drawWaveformRing(settings, metrics, minSide, 0.45);

    ctx.globalCompositeOperation = "source-over";
    this.drawLogo(settings, assets?.logo, minSide, pulse);
    ctx.restore();
  }

  drawBackground(settings, background, time, pulse) {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.save();
    ctx.fillStyle = "#070812";
    ctx.fillRect(0, 0, width, height);

    if (background) {
      const motion = settings.backgroundMotion ? Math.sin(time * 0.22) * 0.018 + pulse * 0.035 : 0;
      const scale = Math.max(width / background.width, height / background.height) * (1.08 + motion);
      const dw = background.width * scale;
      const dh = background.height * scale;
      const dx = (width - dw) / 2 + Math.sin(time * 0.13) * width * 0.018;
      const dy = (height - dh) / 2 + Math.cos(time * 0.11) * height * 0.018;
      ctx.filter = `blur(${settings.backgroundBlur}px) brightness(${settings.backgroundBrightness}) saturate(1.12)`;
      ctx.drawImage(background, dx, dy, dw, dh);
      ctx.filter = "none";
    } else {
      const gradient = ctx.createRadialGradient(width * 0.5, height * 0.48, 0, width * 0.5, height * 0.5, Math.max(width, height) * 0.78);
      gradient.addColorStop(0, "#182338");
      gradient.addColorStop(0.42, "#0d1222");
      gradient.addColorStop(1, "#04050b");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }

    ctx.fillStyle = `rgba(0, 0, 0, ${settings.darkOverlay})`;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  drawLogo(settings, logo, minSide, pulse) {
    const ctx = this.ctx;
    const size = minSide * settings.logoSize * (1 + pulse * 0.1);
    ctx.save();
    ctx.shadowColor = settings.glowColor;
    ctx.shadowBlur = minSide * 0.055 * settings.glowAmount;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(8, 10, 18, 0.74)";
    ctx.fill();

    if (logo) {
      const diameter = size * 1.18;
      ctx.save();
      if (settings.cropLogoCircle) {
        ctx.beginPath();
        ctx.arc(0, 0, diameter / 2, 0, Math.PI * 2);
        ctx.clip();
      }
      const scaleMode = settings.cropLogoCircle ? Math.max : Math.min;
      const scale = scaleMode(diameter / logo.width, diameter / logo.height) * settings.logoCropZoom;
      const dw = logo.width * scale;
      const dh = logo.height * scale;
      const offsetX = settings.logoCropX * diameter * 0.5;
      const offsetY = settings.logoCropY * diameter * 0.5;
      ctx.drawImage(logo, -dw / 2 + offsetX, -dh / 2 + offsetY, dw, dh);
      ctx.restore();
      if (settings.cropLogoCircle) {
        ctx.beginPath();
        ctx.arc(0, 0, diameter / 2, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.16)";
        ctx.lineWidth = Math.max(1, minSide * 0.002);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = Math.max(2, minSide * 0.004);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.font = `${Math.round(size * 0.18)}px Inter, Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("LOGO", 0, 0);
    }
    ctx.restore();
  }

  drawCircularSpectrum(settings, metrics, minSide) {
    const ctx = this.ctx;
    const bins = metrics.frequencyData;
    const count = 192;
    const radius = minSide * settings.spectrumRadius * (1 + metrics.bassPulse * 0.055);
    const maxBar = minSide * settings.barHeight;
    ctx.save();
    ctx.lineCap = "round";
    ctx.shadowColor = settings.glowColor;
    ctx.shadowBlur = minSide * 0.034 * settings.glowAmount;

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
      const r1 = radius;
      const r2 = radius + length;
      const mix = i / count;
      ctx.strokeStyle = mix < 0.5 ? settings.primaryColor : settings.secondaryColor;
      ctx.globalAlpha = 0.72 + value * 0.28;
      ctx.lineWidth = Math.max(2, minSide * 0.0038);
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * r1, Math.sin(angle) * r1);
      ctx.lineTo(Math.cos(angle) * r2, Math.sin(angle) * r2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawWaveformRing(settings, metrics, minSide, alpha = 0.82) {
    const ctx = this.ctx;
    const wave = metrics.waveformData;
    const count = 256;
    const radius = minSide * (settings.spectrumRadius + 0.06);
    ctx.save();
    ctx.strokeStyle = settings.secondaryColor;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(2, minSide * 0.003);
    ctx.shadowColor = settings.secondaryColor;
    ctx.shadowBlur = minSide * 0.025 * settings.glowAmount;
    ctx.beginPath();
    for (let i = 0; i <= count; i += 1) {
      const sample = (wave[Math.floor((i / count) * (wave.length - 1))] - 128) / 128;
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const r = radius + sample * minSide * 0.035 + metrics.bassPulse * minSide * 0.015;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  drawHorizontalBars(settings, metrics, width, minSide) {
    const ctx = this.ctx;
    const bins = metrics.frequencyData;
    const bars = 96;
    const span = width * 0.76;
    const barWidth = span / bars;
    const maxHeight = minSide * settings.barHeight * 0.65;
    ctx.save();
    ctx.shadowColor = settings.glowColor;
    ctx.shadowBlur = minSide * 0.03 * settings.glowAmount;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < bars; i += 1) {
        const bin = Math.floor((i / bars) * bins.length * 0.72);
        const value = Math.pow((bins[bin] ?? 0) / 255, 1.22);
        const h = maxHeight * (0.08 + value + metrics.bass * 0.2);
        const x = -span / 2 + i * barWidth;
        ctx.fillStyle = i % 2 ? settings.primaryColor : settings.secondaryColor;
        ctx.globalAlpha = 0.72;
        ctx.fillRect(x, side * (minSide * 0.22), barWidth * 0.56, side * h);
      }
    }
    ctx.restore();
  }

  drawParticlePulse(settings, metrics, minSide, time) {
    const ctx = this.ctx;
    const radius = minSide * settings.spectrumRadius * (1.1 + metrics.bassPulse * 0.2);
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.shadowColor = settings.glowColor;
    ctx.shadowBlur = minSide * 0.03 * settings.glowAmount;
    for (let i = 0; i < 160; i += 1) {
      const angle = (i / 160) * Math.PI * 2 + time * 0.04;
      const wave = Math.sin(i * 0.17 + time * 2.2) * minSide * 0.018;
      const r = radius + wave + metrics.frequencyData[i % metrics.frequencyData.length] / 255 * minSide * 0.12;
      ctx.fillStyle = i % 3 ? settings.primaryColor : settings.secondaryColor;
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * r, Math.sin(angle) * r, minSide * 0.0035, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawOuterGlow(settings, metrics, minSide) {
    const ctx = this.ctx;
    const radius = minSide * settings.spectrumRadius * (1 + metrics.bassPulse * 0.12);
    const gradient = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius * 1.8);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.45, hexToRgba(settings.glowColor, 0.11 * settings.glowAmount));
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.9, 0, Math.PI * 2);
    ctx.fill();
  }

  drawParticles(settings, metrics, time, cx, cy, minSide) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalCompositeOperation = "lighter";
    for (const p of this.particles) {
      const depthRaw = (p.radius - (time * p.speed * 0.12 + metrics.bassPulse * 0.08)) % 1;
      const depth = depthRaw < 0 ? depthRaw + 1 : depthRaw;
      const spread = Math.pow(depth, 1.85);
      const r = minSide * (0.18 + spread * 0.68);
      const x = Math.cos(p.angle) * r;
      const y = Math.sin(p.angle) * r;
      const tailX = Math.cos(p.angle) * r * 0.84;
      const tailY = Math.sin(p.angle) * r * 0.84;
      ctx.globalAlpha = (1 - depth) * p.alpha * (0.35 + metrics.bassPulse * 0.9);
      ctx.strokeStyle = p.angle % 2 > 1 ? settings.primaryColor : settings.secondaryColor;
      ctx.lineWidth = Math.max(1, p.size * minSide * (1.25 - depth));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
    }
    ctx.restore();
  }

  seedParticles() {
    this.particles = Array.from({ length: 90 }, (_, i) => {
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
}

function pseudoRandom(seed) {
  const x = Math.sin(seed * 999) * 10000;
  return x - Math.floor(x);
}

function hexToRgba(hex, alpha) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized.length === 3 ? normalized.split("").map((c) => c + c).join("") : normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
