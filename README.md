<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-blue?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node" />
  <img src="https://img.shields.io/badge/license-ISC-yellow?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/platform-linux%20%7C%20macos%20%7C%20windows-lightgrey?style=flat-square" alt="Platform" />
</p>

<h1 align="center">🧲 Rattin</h1>

<p align="center">
  <strong>Stream torrents instantly in your browser. No waiting. No desktop app.</strong>
</p>

<p align="center">
  Browse movies & TV → Pick a torrent → Watch immediately.<br/>
  Powered by WebTorrent, React, and ffmpeg.
</p>

---

## ✨ Features

### 🎬 Streaming & Playback

- **Instant Streaming** — Start watching while it downloads. No waiting for full files.
- **Universal Format Support** — Play anything: MKV, AVI, MP4, WebM, MOV, FLV, WMV, and more. Non-native formats are transcoded on-the-fly via ffmpeg.
- **Smart Seeking** — Builds a keyframe index in the background so you can seek anywhere, even in incomplete downloads. Auto-prioritizes the right torrent pieces.
- **Background Transcoding** — Completed files are transcoded to MP4 with faststart for instant seeking. Tries remux first (fast), falls back to full re-encode if needed.
- **Download Overlay** — Real-time download progress in the seek bar, plus speed and peer count in the controls.
- **Resume Playback** — Automatically saves your position and resumes where you left off.

### ⏭️ Skip Intro

- **Automatic Intro Detection** — Detects TV show intros by fingerprinting audio across episodes using Chromaprint (`fpcalc`). Compares the first few minutes of 2+ episodes to find matching segments.
- **AniSkip Fallback** — For anime, falls back to the AniSkip API (via Jikan/MAL) to look up known intro timestamps.
- **One-Click Skip Button** — A "Skip Intro" button appears on-screen when playback enters the intro range. Auto-hides after 10 seconds. Click it and you're past the opening.

### 📺 Movie & TV Browser

- **TMDB Integration** — Full movie and TV metadata: posters, backdrops, synopses, ratings, runtime, genres, cast photos, and trailers.
- **Trending & Discovery** — Homepage sections for Trending This Week, New Releases, Popular Movies, Popular TV, Top Rated Movies, Top Rated TV, plus genre rows (Action, Comedy, Sci-Fi, Horror).
- **Hero Banner** — Featured trending content displayed as a full-width hero at the top of the homepage.
- **Availability Filtering** — Content rows only show titles that actually have available torrents.
- **TV Season & Episode Browser** — Season selector dropdown, episode grid with thumbnails, runtimes, and expandable synopses. Play or pick a source per episode.
- **Reviews** — Reddit discussions and IMDB user reviews displayed on detail pages with scores, comment counts, and expandable text.
- **Trailers** — YouTube trailer links auto-detected and shown when available.
- **Rating Color Coding** — Ratings are green (7+), yellow (5–7), or red (<5) at a glance.

### 🔍 Torrent Search & Ranking

- **Multi-Provider Search** — Searches **TPB**, **EZTV**, and **YTS** simultaneously.
- **Smart Scoring** — Ranks results by title match, resolution (1080p > 720p > 480p), source quality (BluRay > WEB-DL > HDTV), codec (x264 > HEVC), seeder count. Penalizes CAM/telesync.
- **Quality Tags** — Each result shows parsed tags: resolution, codec, source, audio format, container, HDR, Atmos, Season Pack, etc.
- **Auto-Play** — One click picks the best torrent and starts streaming.
- **Manual Picker** — Or browse the full ranked list and choose yourself.

### 📱 Phone Remote Control

- **QR Code Pairing** — Scan a QR code from the player to connect your phone as a remote.
- **Full Playback Control** — Play/pause, seek ±10s, volume slider, subtitle/audio track selection, fullscreen toggle, stop.
- **Real-Time Sync** — Server-Sent Events keep the remote and player in lockstep. Shows current position, duration, download speed, and peers.
- **Browse from Phone** — Browse and start content directly from the remote, with a Now Playing bar showing what's on.
- **Persistent Sessions** — Auth cookies last 30 days with automatic reconnection. Visual connection-status feedback throughout.

### 🔤 Subtitles & Audio

- **Embedded & External Subtitles** — Auto-detects both. Supports SRT, ASS, SSA, VTT, SUB — all converted to WebVTT on the fly.
- **Multi-Language Detection** — Extracts language tags from embedded streams (English, Spanish, French, German, Japanese, Korean, and more).
- **Subtitle Offset** — Compensates for time misalignment between video and subtitle tracks.
- **Audio Track Selection** — Switch between multiple audio tracks. Surround sound detection (shows "5.1" badge).
- **Pre-Play Track Selection** — Modal to choose audio and subtitle tracks before playback starts.

### 🖥️ Player UI

- **Keyboard Shortcuts** — `Space` play/pause, `←`/`→` seek ±10s, `F` fullscreen, `Esc` exit fullscreen.
- **Mini Player** — Keep watching in a corner widget while browsing other content. Shows play/pause, expand, close, time, and progress bar.
- **Polished Controls** — Auto-hide after inactivity, seek preview tooltip on hover, remote connection toasts.

### 📦 Torrent Management

- **Multi-File Torrents** — Select which files to download, skip what you don't need.
- **Season Pack Support** — Detects and tags season packs, lets you pick individual episodes.
- **Bandwidth Prioritization** — Deselects other files when streaming one to focus bandwidth.
- **Media Validation** — Files verified with ffprobe before streaming to catch fakes and corruption.
- **Auto-Cleanup** — Idle torrents are automatically removed after 2 minutes of inactivity. Background transcodes are killed when streams close.

### 🎨 UI/UX

- Dark-themed SPA with skeleton loading, lazy images, smooth horizontal-scroll content rows, and deep linking via React Router.

---

## 🚀 Quick Install

One command. Fresh machine. Everything handled.

**Linux** (Ubuntu 22.04+, Debian 12+, Fedora 39+):

```bash
(curl -fsSL https://raw.githubusercontent.com/rattin-player/rattin-public/main/install.sh || wget -qO- https://raw.githubusercontent.com/rattin-player/rattin-public/main/install.sh) | sudo bash
```

**Windows** (10/11, as Administrator):

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/rattin-player/rattin-public/main/install.ps1 | iex"
```

The installer downloads Node, ffmpeg, and the app — all bundled locally in `/opt/rattin` (Linux) or `C:\Program Files\rattin` (Windows). You'll be prompted for a free [TMDB API key](https://www.themoviedb.org/settings/api) during setup.

**Uninstall:**

```bash
# Linux
(curl -fsSL https://raw.githubusercontent.com/rattin-player/rattin-public/main/install.sh || wget -qO- https://raw.githubusercontent.com/rattin-player/rattin-public/main/install.sh) | sudo bash -s -- --uninstall

# Windows
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/rattin-player/rattin-public/main/install.ps1 | iex" -Uninstall
```

**Update:** Rerun the install command. It detects the existing installation and updates in place.

---

## 🛠️ Manual Setup

If you prefer to set things up yourself:

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [ffmpeg](https://ffmpeg.org/) installed and on PATH
- [fpcalc](https://acoustid.org/chromaprint) (Chromaprint) on PATH — for intro detection
- A [TMDB API key](https://www.themoviedb.org/settings/api) (free, for movie/TV browsing)

### Install & Run

```bash
git clone https://github.com/rattin-player/player.git
cd player
npm install
npm run build
```

Create a `.env` file:

```env
TMDB_API_KEY=your_tmdb_api_key_here
```

Start the server:

```bash
npm start
```

Open **http://localhost:3000** and you're in.

### Development

```bash
npm run dev    # Vite dev server with hot reload
```

The dev server proxies `/api` requests to the backend at `localhost:3000`, so run `node --env-file=.env server.js` in a separate terminal.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Browser (React)                   │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐ │
│  │  Browse   │ │  Search  │ │ Player │ │  Remote  │ │
│  │  (TMDB)  │ │ Torrents │ │  Video │ │  (Phone) │ │
│  └────┬─────┘ └────┬─────┘ └───┬────┘ └────┬─────┘ │
└───────┼────────────┼───────────┼───────────┼────────┘
        │            │           │           │
   ─────┴────────────┴───────────┴───────────┴─────────
                     Express API
   ────────────────────────────────────────────────────
        │            │           │           │
   ┌────┴────┐  ┌────┴────┐ ┌───┴────┐ ┌───┴──────┐
   │  TMDB   │  │ Torrent │ │ ffmpeg │ │   SSE    │
   │  Proxy  │  │ Search  │ │ Trans- │ │  Remote  │
   │ + Cache │  │  (3x)   │ │  code  │ │ Control  │
   └─────────┘  └────┬────┘ └───┬────┘ └──────────┘
                     │           │
                ┌────┴────┐ ┌───┴────────┐
                │WebTorrent│ │ Seek Index │
                │  Client  │ │+ Intro Det.│
                └─────────┘ └────────────┘
```

---

## 📂 Project Structure

```
rattin/
├── server.js              # Express backend — streaming, transcoding, search, remote
├── index.html             # HTML entry point
├── vite.config.js         # Frontend build config
├── lib/
│   ├── cache.js           # TMDB cache with TTL + stale-while-revalidate
│   ├── seek-index.js      # Keyframe index for smart seeking
│   ├── intro-detect.js    # Intro detection orchestrator
│   ├── fingerprint.js     # Chromaprint audio fingerprinting & cross-correlation
│   ├── torrent-scoring.js # Multi-provider torrent ranking
│   ├── torrent-caches.js  # Bounded caches for torrent state
│   ├── media-utils.js     # ffprobe helpers & format detection
│   ├── idle-tracker.js    # Stream idle timeout tracking
│   ├── torrent-compat.js  # WebTorrent compatibility helpers
│   └── bounded-map.js     # Size-limited Map implementation
├── src/
│   ├── App.jsx            # Router & layout
│   ├── components/
│   │   ├── Navbar.jsx     # Search bar, navigation
│   │   ├── MiniPlayer.jsx # Persistent mini player widget
│   │   ├── MovieCard.jsx  # Content thumbnails with ratings
│   │   ├── ContentRow.jsx # Horizontal scrollable content row
│   │   ├── HeroSection.jsx          # Featured content banner
│   │   ├── PairRemoteModal.jsx      # QR code pairing modal
│   │   ├── QrScanner.jsx            # Phone QR scanner
│   │   └── RemoteNowPlaying.jsx     # Now playing bar for remote
│   ├── pages/
│   │   ├── Home.jsx       # Trending, genres, discovery
│   │   ├── Detail.jsx     # Movie/TV detail, episodes, reviews
│   │   ├── Player.jsx     # Full video player with skip intro
│   │   ├── Search.jsx     # Search results grid
│   │   └── Remote.jsx     # Phone remote UI
│   └── lib/
│       ├── PlayerContext.jsx  # Playback state context
│       ├── api.js         # API client
│       └── utils.js       # Formatting helpers
├── public/                # Built frontend assets
├── deploy/                # Ansible playbook for server deployment
└── .env                   # TMDB_API_KEY (create this)
```

---

## 🔧 Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TMDB_API_KEY` | — | Required for movie/TV browsing |
| `PORT` | `3000` | Server port |

Download and transcode paths default to `/tmp/rattin` and `/tmp/rattin-transcoded`.

---

## 🎯 How Streaming Works

Rattin adapts its strategy based on file state:

| Scenario | Strategy |
|----------|----------|
| Complete file, browser-native (MP4/WebM) | Direct stream with HTTP range requests |
| Complete file, non-native (MKV/AVI/etc.) | Live ffmpeg transcode → fragmented MP4 |
| Incomplete file, browser-native | WebTorrent stream with piece prioritization |
| Incomplete file, non-native | ffmpeg transcode from torrent stream |
| Seeking in incomplete file | Build keyframe index → prioritize pieces at target → serve |

---

## 🎬 Supported Formats

| Type | Formats |
|------|---------|
| **Video** | MP4, MKV, WebM, AVI, MOV, M4V, TS, FLV, WMV |
| **Audio** | MP3, FLAC, OGG, Opus, M4A, AAC, WAV, WMA |
| **Subtitles** | SRT, ASS, SSA, VTT, SUB |

---

---

## 🚢 Deployment

### Systemd (Linux)

```bash
npm install
npm run build
# Configure your .env
sudo systemctl restart rattin
```

### Ansible

An Ansible playbook is included in `deploy/` for automated server setup with nginx, basic auth, and systemd.

### Standalone Windows EXE

```bash
npm run build:exe
# Output: dist/rattin.exe
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, React Router 7, Vite 6 |
| **Backend** | Express 5, Node.js 20+ |
| **Torrents** | WebTorrent |
| **Transcoding** | ffmpeg / ffprobe |
| **Intro Detection** | Chromaprint (fpcalc) + AniSkip API |
| **Metadata** | TMDB API |
| **Reviews** | Reddit + IMDB |
| **Remote** | Server-Sent Events + QR pairing (uqr) |

---

## 📄 License

ISC
