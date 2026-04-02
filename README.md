<p align="center">
  <img src="packaging/linux/rattin.svg" alt="Rattin" width="128" height="128"/>
</p>
<h1 align="center">Rattin</h1>

<p align="center">
  <strong>Desktop streaming from magnet links.</strong><br>
  Browse. Click. Watch. No downloads. No waiting.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/desktop-linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux" />
  <img src="https://img.shields.io/badge/remote-phone-34A853?style=for-the-badge&logo=android&logoColor=white" alt="Remote" />
</p>

---

## Why Rattin

Most tools in this space make you choose. Torrent clients that stream but can't browse. Media servers that browse but can't stream from torrents without bolting on five extra tools. Apps that do both but choke on MKV or HEVC unless you pay for transcoding. And none of them touch privacy — you're on your own for that.

Rattin is a single desktop app that does all of it — browse TMDB, click play, watch — with optional debrid integration and per-app VPN isolation built in.

🎬 Every codec, every container, every format — played natively through libmpv with hardware decoding<br>
⏩ Smart seeking in incomplete files — jump anywhere, even before it's downloaded<br>
🔍 TMDB discovery — trending, genres, search, trailers, cast, one-click play<br>
📱 Phone remote via QR scan — no app install, just point your camera<br>
🔒 No account, no database, no cloud, no telemetry — nothing leaves your machine<br>
⚡ Optional Real-Debrid — instant streaming via HTTPS, full seeking, no swarm exposure<br>
🛡️ Optional per-app VPN *(WIP)* — WireGuard isolation for torrent traffic only, built-in kill switch

### :mag: Discovery

- **Full movie & TV browser** - Trending, new releases, top rated, genres, cast, trailers
- **Smart torrent search** - Searches multiple providers and ranks by quality, seeders, and format
- **One-click play** - Auto-selects the best available torrent and starts streaming
- **Quality at a glance** - Resolution, codec, audio format, and source parsed from every result

### :zap: Player

- **Every format natively** - MKV, AVI, HEVC, AV1, HDR, Dolby Vision — zero transcoding, powered by libmpv
- **Hardware decoding** - VAAPI, NVDEC, VideoToolbox — your GPU does the work
- **Seek anywhere** - Even in files that haven't fully downloaded yet
- **Skip intro** *(WIP)* - Detects TV show intros via audio fingerprinting
- **Subtitles** - Embedded and external, with language detection and resizable text (SRT, ASS, SSA, VTT)
- **Multiple audio tracks** - Switch languages and surround formats on the fly
- **Source switching** - Swap between different torrents mid-playback if one is slow
- **Mini player** - Keep watching while browsing other content

### :iphone: Phone Remote

- **Scan a QR code** from the player to pair your phone
- **Full control** - Play, pause, seek, volume, subtitles, audio tracks
- **Browse from your phone** - Search and start content from the couch
- **Real-time sync** - Player and remote stay in lockstep

### :shield: Privacy

- **Real-Debrid integration** - Torrents download on RD's servers, you stream over HTTPS. Your IP never joins the swarm. Configure in Settings (gear icon).
- **Per-app VPN isolation** *(WIP)* - WireGuard tunnel in a Linux network namespace. Only Rattin's traffic goes through the VPN — everything else on your system stays on your normal connection. Built-in kill switch: if the tunnel drops, torrent connections die instead of leaking your real IP.
- **No built-in tracking** - No signup, no analytics, no telemetry, no phone-home. The only external calls are TMDB (metadata) and torrent search providers.

---

## Install

### :desktop_computer: Linux

One command:

```bash
curl -fsSL "https://raw.githubusercontent.com/rattin-player/rattin-public/main/install/install-native.sh" | bash
```

Downloads the AppImage, creates a desktop entry, opens the firewall port for phone remote, and prompts for a free [TMDB API key](https://www.themoviedb.org/settings/api). Optionally configures WireGuard VPN during install. Shows up in your app launcher as "Rattin".

To update, rerun the same command. To uninstall: add `--uninstall`.

You can also grab the AppImage directly from the [latest release](https://github.com/rattin-player/rattin-public/releases/latest) and run it manually.

### :window: Windows

Coming soon.

---

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `TMDB_API_KEY` | Yes | Free API key from [themoviedb.org](https://www.themoviedb.org/settings/api) |
| `PORT` | No | Server port (default: 9630) |

### Debrid Setup

1. Get a [Real-Debrid](https://real-debrid.com) account (~$3/month)
2. Copy your API token from [real-debrid.com/apitoken](https://real-debrid.com/apitoken)
3. Open Rattin, click the **Debrid** button in the navbar, paste your key, click **Connect**
4. Choose your streaming mode:

| Mode | Behavior |
|------|----------|
| **Always use debrid** | Every play goes through Real-Debrid. Waits for RD to download if not cached. Best seeking, full privacy, but uncached content has a cold start delay. |
| **Cached only** | Uses debrid when content is already cached on RD (instant). Falls back to WebTorrent for uncached content (zero delay). |

### VPN Setup (optional, Linux only)

1. Get a WireGuard config from your VPN provider (Mullvad, ProtonVPN, IVPN, etc.)
2. Place it at `~/.config/rattin/wg/wg0.conf`
3. Start Rattin via the VPN supervisor: `./rattin-vpn` instead of the AppImage
4. Toggle VPN on/off from the shield icon in the navbar

The VPN isolates only Rattin's traffic in a Linux network namespace. Your browser, other apps, and system traffic stay on your normal connection.

---

<details>
<summary><h2>Technical Details</h2></summary>

### Architecture

```
               +-------------------+
               |    Qt6 Window     |
               |  +-------------+  |
               |  |   libmpv    |  |
               |  |   (video)   |  |
               |  +-------------+  |
               |  | QML Controls|  |
               |  +-------------+  |
               |  | WebEngine   |  |
               |  | (React App) |  |
               |  +------+------+  |
               +---------+---------+
                         |
            -------------+-------------
                   Express API
            ---------------------------
               |           |           |           |
         +-----+-----+ +--+---+ +-----+------+ +--+------+
         | WebTorrent| |ffmpeg| |TMDB + Search| |Real-Debrid|
         +-----------+ +------+ +-------------+ +-----------+
```

The React app runs inside Qt's WebEngineView. When a video plays, React sends the stream URL to mpv via QWebChannel. mpv renders the video in an OpenGL framebuffer object layered above the webview, with a QML controls overlay on top. Every format plays natively — no transcoding needed.

### How Streaming Works

| Scenario | Strategy |
|----------|----------|
| Complete file on disk | Direct HTTP range requests to mpv |
| Incomplete file | WebTorrent stream + piece prioritization to mpv |
| Seeking in incomplete file | Keyframe index + prioritize pieces at target |
| Debrid | HTTPS stream from Real-Debrid — full range support |

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
4. Commands route through the mpv bridge (play/pause/seek/volume/subtitles)

The app binds to `0.0.0.0` so phones on the same LAN can reach it. Firewall port 9630 is opened by the install script.

### Privacy Architecture

**Debrid path:** Magnet link → Real-Debrid API → HTTPS download URL → stream to player. User's IP only visible to RD (encrypted HTTPS), never to the torrent swarm.

**VPN path:** `rattin-vpn` supervisor creates a Linux network namespace with a WireGuard tunnel. Node.js runs inside the namespace. All torrent traffic (peers, DHT, trackers) goes through the VPN. The browser connects to the API via a veth bridge (`10.199.199.0/24`). If the WireGuard tunnel drops, there's no fallback route — connections fail instead of leaking the real IP.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, React Router 7, Vite 6 |
| Backend | Express 5, Node.js 20+ |
| Torrents | WebTorrent |
| Debrid | Real-Debrid REST API |
| Native Shell | Qt6, libmpv, QWebChannel, CMake |
| Intro Detection | Chromaprint (fpcalc) + AniSkip API |
| Metadata | TMDB API |
| Remote | Server-Sent Events + QR (uqr) |
| VPN | WireGuard + Linux network namespaces |

### Development

```bash
npm run dev     # Vite dev server with hot reload (port 5173)
npm start       # Backend (port 9630, proxied by Vite)
```

</details>

---

<p align="center">GPL-3.0 License</p>
