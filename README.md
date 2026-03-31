<h1 align="center">
  <br>
  <img src="https://img.shields.io/badge/%F0%9F%A7%B2-Rattin-000?style=for-the-badge&labelColor=000" alt="Rattin" height="40"/>
  <br>
</h1>

<p align="center">
  <strong>Torrents that play like Netflix.</strong><br>
  Browse. Click. Watch. No downloads. No waiting.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/web-any%20browser-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Web" />
  <img src="https://img.shields.io/badge/desktop-linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux" />
  <img src="https://img.shields.io/badge/remote-phone-34A853?style=for-the-badge&logo=android&logoColor=white" alt="Remote" />
</p>

---

## What you get

Rattin turns magnet links into a streaming experience. Search for any movie or TV show, pick a source, and it starts playing instantly - like any other streaming app, except the content comes from torrents.

It runs on your own machine. No subscriptions. No accounts. No limits.

### Two ways to watch

<table>
<tr>
<td width="50%" valign="top">

#### :globe_with_meridians: Web Mode
Open a browser tab and stream. Works on any device on your network - laptop, tablet, TV, phone. Formats that browsers can't play natively (MKV, HEVC) get transcoded on the fly.

**Best for:** Watching from the couch on your TV, sharing with devices on your network, remote access.

</td>
<td width="50%" valign="top">

#### :desktop_computer: Native Mode
A desktop app with a real video engine under the hood (libmpv). Plays every format natively with hardware acceleration - no transcoding, no quality loss. 4K HEVC, HDR, Dolby Atmos, all handled directly by your GPU.

**Best for:** Your main PC. Best possible quality. Instant seeking. HDR content.

</td>
</tr>
</table>

Both modes share the same interface and backend. The native version just swaps the browser's video player for something better.

---

### :fire: Streaming

- **Plays while downloading** - Start watching in seconds, not hours
- **Seek anywhere** - Even in files that haven't fully downloaded yet
- **Every format works** - MKV, AVI, MP4, HEVC, AV1, HDR, Dolby Vision
- **Real-time progress** - See download speed, peer count, and completion in the player

### :mag: Discovery

- **Full movie & TV browser** - Trending, new releases, top rated, genres, cast, trailers
- **Smart torrent search** - Searches multiple providers and ranks by quality, seeders, and format
- **One-click play** - Auto-selects the best available torrent and starts streaming
- **Quality at a glance** - Resolution, codec, audio format, and source parsed from every result

### :zap: Player

- **Skip intro** - Automatically detects TV show intros via audio fingerprinting
- **Subtitles** - Embedded and external, with language detection (SRT, ASS, SSA, VTT)
- **Multiple audio tracks** - Switch languages and surround formats on the fly
- **Source switching** - Swap between different torrents mid-playback if one is slow
- **Mini player** - Keep watching while browsing other content

### :iphone: Phone Remote

- **Scan a QR code** from the player to pair your phone
- **Full control** - Play, pause, seek, volume, subtitles, audio tracks
- **Browse from your phone** - Search and start content from the couch
- **Real-time sync** - Player and remote stay in lockstep

### :desktop_computer: Native Desktop Extras

- **Hardware decoding** - VAAPI, NVDEC, VideoToolbox - your GPU does the work
- **Zero transcoding** - Every format plays natively through libmpv
- **Subtitle controls** - Pick tracks and resize text from the player overlay
- **Instant seeking** - Jump to any point without waiting for the file to download

---

## Install

### :desktop_computer: Desktop App (Linux)

One command:

```bash
curl -fsSL "https://raw.githubusercontent.com/rattin-player/rattin-install/main/install-native.sh" | bash
```

Downloads the AppImage, creates a desktop entry, opens the firewall port for phone remote, and prompts for a free [TMDB API key](https://www.themoviedb.org/settings/api). Shows up in your app launcher as "Rattin".

To update, rerun the same command. To uninstall: add `--uninstall`.

You can also grab the AppImage directly from the [latest release](https://github.com/rattin-player/rattin-install/releases/latest) and run it manually.

### :globe_with_meridians: Web Mode (self-hosted server)

For running as a web server accessible from any browser on your network:

```bash
git clone https://github.com/rattin-player/rattin.git && cd player
npm install && npm run build
echo "TMDB_API_KEY=your_key" > .env
npm start
```

Open `http://<your-ip>:3000` from any device. Requires Node.js 20+ and ffmpeg.

---

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `TMDB_API_KEY` | Yes | Free API key from [themoviedb.org](https://www.themoviedb.org/settings/api) |
| `PORT` | No | Server port (default: 3000, native mode uses 9630) |

---

<details>
<summary><h2>Technical Details</h2></summary>

### Architecture

```
                    Native Mode                          Web Mode
               +-------------------+              +-------------------+
               |    Qt6 Window     |              |      Browser      |
               |  +-------------+  |              |                   |
               |  |   libmpv    |  |              |    React App      |
               |  |   (video)   |  |              |  + HTML5 <video>  |
               |  +-------------+  |              |                   |
               |  | QML Controls|  |              +--------+----------+
               |  +-------------+  |                       |
               |  | WebEngine   |  |                       |
               |  | (React App) |  |                       |
               |  +------+------+  |                       |
               +---------+---------+                       |
                         |                                 |
            -------------+---------------------------------+
                              Express API
            ------------------------------------------------
                      |           |           |
                +-----+-----+ +--+---+ +-----+------+
                | WebTorrent| |ffmpeg| |TMDB + Search|
                +-----------+ +------+ +-------------+
```

In native mode, the React app runs inside Qt's WebEngineView. When a video plays, React sends the stream URL to mpv via QWebChannel instead of setting `<video>.src`. mpv renders the video in an OpenGL framebuffer object layered above the webview, with a QML controls overlay on top.

### How Streaming Works

| Scenario | Strategy |
|----------|----------|
| Complete file, browser-native (MP4/WebM) | Direct HTTP range requests |
| Complete file, non-native (MKV/AVI) | Live ffmpeg transcode to fragmented MP4 |
| Incomplete file, browser-native | WebTorrent stream + piece prioritization |
| Incomplete file, non-native | ffmpeg transcode from torrent stream |
| Seeking in incomplete file | Keyframe index + prioritize pieces at target |
| **Native mode (any file)** | **Raw bytes to mpv - no transcode** |

### Native Shell

~500 lines of C++/QML:

| File | What it does |
|------|-------------|
| `shell/main.cpp` | Spawns Express server on port 9630, creates QML engine, wires up the mpv bridge |
| `shell/main.qml` | Layout: WebEngineView (z:2) + MpvObject (z:3) + QML controls (z:4) + QWebChannel |
| `shell/mpvobject.cpp` | QQuickFramebufferObject wrapping libmpv with OpenGL rendering |
| `shell/mpvbridge.cpp` | C++ slots callable from JS: play, pause, seek, volume, subtitle/audio track, stop |

### Phone Remote

The phone remote uses Server-Sent Events (SSE) for real-time communication:

1. PC creates an RC session and generates a QR code containing `http://<lan-ip>:9630/api/rc/auth?session=X&token=Y`
2. Phone scans QR, authenticates, and connects to the SSE stream
3. PC reports playback state every second; phone sends commands via POST
4. In native mode, commands route through the mpv bridge (play/pause/seek/volume/subtitles)

The native shell binds to `0.0.0.0` so phones on the same LAN can reach it. Firewall port 9630 is opened automatically on start and closed on exit.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, React Router 7, Vite 6 |
| Backend | Express 5, Node.js 20+ |
| Torrents | WebTorrent |
| Native Shell | Qt6, libmpv, QWebChannel, CMake |
| Transcoding | ffmpeg / ffprobe |
| Intro Detection | Chromaprint (fpcalc) + AniSkip API |
| Metadata | TMDB API |
| Remote | Server-Sent Events + QR (uqr) |

### Development

```bash
npm run dev     # Vite dev server with hot reload (port 5173)
npm start       # Backend (port 3000, proxied by Vite)
```

</details>

---

<p align="center">ISC License</p>
