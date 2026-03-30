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

🎬 **Instant Streaming** — Start watching while it downloads. No waiting for full files.

🔍 **Built-in Search** — Search multiple torrent providers (TPB, EZTV, YTS) with smart ranking that picks the best quality match.

🎥 **Universal Format Support** — Play anything: MKV, AVI, MP4, WebM, MOV, FLV, WMV. Non-native formats are transcoded on-the-fly with ffmpeg.

📺 **Movie & TV Browser** — Discover trending content, browse by genre, and view full details via TMDB integration.

📱 **Phone Remote** — Scan a QR code, control playback from your phone. Play/pause, seek, volume, subtitles — all from the couch.

🔤 **Subtitle Support** — Embedded and external subtitles auto-detected. SRT, ASS, SSA, VTT all converted to WebVTT on the fly. Offset adjustment included.

⏩ **Smart Seeking** — Builds a keyframe index in the background so you can seek anywhere, even in incomplete downloads. Prioritizes the right pieces automatically.

🖥️ **Background Transcoding** — Completed files are transcoded to MP4 with faststart for instant full seeking. Remux first (fast), re-encode if needed.

📦 **Multi-file Torrents** — Select which files to download. Skip what you don't need.

🪟 **Windows One-Click** — Double-click `start.bat` and it handles everything: downloads Node.js, grabs ffmpeg, installs deps, and opens the browser.

---

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [ffmpeg](https://ffmpeg.org/) installed and on PATH
- A [TMDB API key](https://www.themoviedb.org/settings/api) (free, for movie/TV browsing)

### Install & Run

```bash
git clone https://github.com/your-username/rattin.git
cd rattin
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

Open **http://localhost:3000** and you're in. 🎉

### Windows (Easiest)

Just double-click **`start.bat`** — it auto-downloads Node.js and ffmpeg, installs everything, and opens the browser. Zero setup.

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
                │  Client  │ │  Builder   │
                └─────────┘ └────────────┘
```

---

## 📂 Project Structure

```
rattin/
├── server.js              # Express backend — streaming, transcoding, search, remote
├── lib/
│   ├── cache.js           # TMDB cache with TTL + stale-while-revalidate
│   └── seek-index.js      # Keyframe index for smart seeking
├── src/
│   ├── App.jsx            # Router & layout
│   ├── components/
│   │   ├── Navbar.jsx     # Search bar, navigation
│   │   ├── MiniPlayer.jsx # Persistent mini player widget
│   │   ├── MovieCard.jsx  # Content thumbnails
│   │   ├── HeroSection.jsx# Featured content banner
│   │   └── PairRemoteModal.jsx  # QR code pairing
│   ├── pages/
│   │   ├── Home.jsx       # Trending, genres, discovery
│   │   ├── Detail.jsx     # Movie/TV detail + play
│   │   ├── Player.jsx     # Full video player
│   │   ├── Search.jsx     # Search results
│   │   └── Remote.jsx     # Phone remote UI
│   └── lib/
│       ├── PlayerContext.jsx  # Playback state context
│       ├── api.js         # API client
│       └── utils.js       # Formatting helpers
├── public/                # Built frontend assets
├── deploy/                # Ansible playbook for server deployment
├── start.bat              # Windows one-click launcher
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

## 📱 Phone Remote

1. Click the remote icon in the player
2. Scan the QR code with your phone
3. Control everything: play/pause, seek, volume, subtitles

Uses Server-Sent Events for real-time sync. Sessions persist for 24 hours, auth cookies last 30 days.

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

Background transcoding kicks in for completed non-native files: tries remux first (fast, copies codecs), falls back to full re-encode (H.264 + AAC) if needed.

---

## 🔍 Torrent Search & Ranking

Searches across **TPB**, **EZTV**, and **YTS** simultaneously, then scores results by:

- 🎯 Title match accuracy
- 📐 Resolution (1080p > 720p > 480p)
- 💿 Source quality (BluRay > WEB-DL > HDTV)
- 🎞️ Codec preference (x264 > HEVC)
- 🌱 Seeder count
- 🚫 Penalizes CAM/telesync

**Auto-play** picks the top result automatically, or use the manual picker to choose.

---

## 🎬 Supported Formats

| Type | Formats |
|------|---------|
| **Video** | MP4, MKV, WebM, AVI, MOV, M4V, TS, FLV, WMV |
| **Audio** | MP3, FLAC, OGG, Opus, M4A, AAC, WAV, WMA |
| **Subtitles** | SRT, ASS, SSA, VTT, SUB |

---

## 🛡️ Security

- Only media files are allowed — executables, archives, and documents are blocked
- Files are validated with ffprobe before streaming
- Remote sessions use short-lived tokens
- No credentials stored — TMDB key lives in `.env`

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
| **Metadata** | TMDB API |
| **Remote** | Server-Sent Events + QR pairing |

---

## 📄 License

ISC
