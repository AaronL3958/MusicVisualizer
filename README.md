# Spectrum Studio

Browser-based music visualizer generator with a local FFmpeg render backend for crisp high-resolution exports.

## Features

- Upload audio, center logo, and optional background image.
- Realtime canvas preview with bass-reactive circular spectrum.
- Logo circle crop controls.
- Fade-in and fade-out controls.
- Bass sensitivity, smoothing, bass boost, and kick threshold tuning.
- Local backend MP4 export using FFmpeg for 1080p, 1440p, and 4K targets.

## Run Locally

Install dependencies:

```bash
npm install
```

Start the frontend:

```bash
npm run dev -- --port 5173
```

Start the local render backend in a second terminal:

```bash
npm run render-server
```

Open:

```text
http://127.0.0.1:5173
```

The backend runs at:

```text
http://127.0.0.1:8787
```

## Export Architecture

The live preview uses Canvas and the Web Audio API in the browser. The high-quality export path sends the selected local files to a local Node server running on the same machine. The backend decodes audio with FFmpeg, renders deterministic frames with server-side Canvas and FFT analysis, then encodes a final MP4 with H.264 and AAC audio.

User files stay local unless you explicitly deploy or modify the server.
