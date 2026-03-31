<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-blue?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node" />
  <img src="https://img.shields.io/badge/license-ISC-yellow?style=flat-square" alt="License" />
</p>

<h1 align="center">Rattin</h1>

<p align="center">
  <strong>Stream torrents instantly. Two modes: browser or native desktop.</strong>
</p>

---

## What is it

Rattin is a self-hosted torrent streaming app. Browse movies and TV via TMDB, search for torrents across multiple providers, and start watching immediately while the file downloads. No waiting for full downloads.

It comes in two flavors:

| | Web Mode | Native Mode |
|---|---|---|
| **How it runs** | Browser tab (any OS) | Desktop app (Linux) |
| **Video engine** | HTML5 `<video>` + ffmpeg transcode | libmpv with hardware decoding |
| **Format support** | MP4/WebM native, everything else transcoded | All formats natively (MKV, HEVC, AV1, HDR) |
| **Seeking** | Keyframe index + piece prioritization | Instant, handled by mpv |
| **Subtitles** | WebVTT conversion, offset compensation | mpv native rendering (ASS/SRT from container) |
| **Controls** | React player UI | QML overlay (play/pause, seek, volume, subtitle/audio picker) |
| **Remote control** | Phone remote via QR pairing | Same (React runs in embedded WebView) |
| **Best for** | Remote access, multi-device | Local desktop, best quality, HDR content |

Both modes share the same Express backend and React frontend. The native mode wraps the web app in a Qt6 shell and routes video through libmpv instead of the browser's `<video>` element.

---

## Features

### Streaming
- **Instant playback** while downloading via WebTorrent
- **Smart seeking** in incomplete files (keyframe index + piece prioritization)
- **Live transcoding** via ffmpeg for non-native browser formats
- **Download progress** in the seek bar with speed and peer count

### Discovery
- **TMDB integration** with trending, new releases, genres, ratings, cast, trailers
- **Multi-provider torrent search** (TPB, EZTV, YTS) with smart ranking
- **Auto-play** picks the best torrent, or browse the full ranked list
- **Quality tags** parsed from torrent names (resolution, codec, source, HDR, Atmos)

### Player
- **Skip intro** detection via Chromaprint audio fingerprinting + AniSkip fallback
- **Subtitle support** with language detection, multi-format (SRT, ASS, SSA, VTT)
- **Audio track selection** with surround sound detection
- **Phone remote** via QR code pairing with real-time sync (Server-Sent Events)
- **Mini player** for browsing while watching
- **Source switching** between torrents mid-playback

### Native Desktop (Linux)
- **Hardware decoding** for all codecs via libmpv (VAAPI, NVDEC)
- **No transcoding** needed, ever
- **QML controls overlay** with subtitle/audio track picker, volume slider, seek bar
- **Subtitle size adjustment** (A-/A+ controls)
- **Fullscreen** with auto-hiding controls

---

## Install

### Native Desktop (recommended for Linux)

One command:

```bash
curl -fsSL "https://raw.githubusercontent.com/rattin-player/rattin-public/main/install-native.sh" | bash
```

Installs Qt6, libmpv, Node.js, ffmpeg, builds the shell, creates a desktop entry. You'll be prompted for a free [TMDB API key](https://www.themoviedb.org/settings/api).

Update by rerunning the same command. Uninstall with `--uninstall`.

### Web Only (any OS)

```bash
git clone https://github.com/rattin-player/player.git
cd player
npm install
npm run build
echo "TMDB_API_KEY=your_key_here" > .env
npm start
```

Open http://localhost:3000.

### Development

```bash
npm run dev     # Vite dev server with hot reload (port 5173)
npm start       # Backend (port 3000, proxied by Vite)
```

---

## Architecture

```
                    Native Mode                          Web Mode
               ┌─────────────────┐              ┌─────────────────┐
               │   Qt6 Window    │              │     Browser     │
               │  ┌───────────┐  │              │                 │
               │  │  libmpv   │  │              │   React App     │
               │  │  (video)  │  │              │  + HTML5 video  │
               │  ├───────────┤  │              │                 │
               │  │ QML Ctrl  │  │              └────────┬────────┘
               │  ├───────────┤  │                       │
               │  │ WebEngine │  │                       │
               │  │(React App)│  │                       │
               │  └─────┬─────┘  │                       │
               └────────┼────────┘                       │
                        │                                │
           ─────────────┴────────────────────────────────┘
                              Express API
           ──────────────────────────────────────────────
                    │           │           │
              ┌─────┴─────┐ ┌──┴───┐ ┌─────┴──────┐
              │ WebTorrent│ │ffmpeg│ │TMDB + Search│
              └───────────┘ └──────┘ └────────────┘
```

In native mode, the React app runs inside Qt's WebEngineView. When you play a video, instead of setting `<video>.src`, the React code sends the stream URL to mpv via QWebChannel. mpv renders at z:3 (on top), QML controls at z:4, WebView at z:2 (hidden behind mpv during playback).

---

## Native Shell Details

The shell is ~500 lines of C++/QML:

| File | Purpose |
|------|---------|
| `shell/main.cpp` | App init, server spawn, QML engine, bridge creation |
| `shell/main.qml` | WebEngineView + MpvObject + controls overlay + QWebChannel |
| `shell/mpvobject.cpp` | QQuickFramebufferObject wrapping libmpv (OpenGL FBO) |
| `shell/mpvbridge.cpp` | C++ bridge: play/pause/seek/volume/subtitle/audio/stop |

Build from source:

```bash
cd shell && mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
```

Requires: Qt6 (Quick, WebEngineQuick, WebChannel), libmpv, CMake 3.16+

---

## How Streaming Works

| File State | Browser Format? | Strategy |
|-----------|----------------|----------|
| Complete | Yes (MP4/WebM) | Direct HTTP range requests |
| Complete | No (MKV/AVI) | Live ffmpeg transcode to fMP4 |
| Incomplete | Yes | WebTorrent stream + piece prioritization |
| Incomplete | No | ffmpeg from torrent stream |
| Seeking incomplete | Any | Keyframe index, prioritize pieces at target |
| **Native mode** | **Any** | **Raw bytes to mpv, no transcode** |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TMDB_API_KEY` | required | Free key from themoviedb.org |
| `PORT` | `3000` | Server port |

Downloads go to `/tmp/rattin`, transcodes to `/tmp/rattin-transcoded`.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, React Router 7, Vite 6 |
| Backend | Express 5, Node.js 20+ |
| Torrents | WebTorrent |
| Native Shell | Qt6 (Quick, WebEngine, WebChannel), libmpv, CMake |
| Transcoding | ffmpeg / ffprobe |
| Intro Detection | Chromaprint + AniSkip API |
| Metadata | TMDB API, Reddit, IMDB |
| Remote Control | Server-Sent Events + QR (uqr) |

---

## License

ISC
