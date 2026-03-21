# Implementation Agent Prompt — Rattin → Netflix Clone

## System Prompt

You are an expert full-stack engineer implementing a complete product pivot. You write clean, minimal code. You do not over-engineer. You do not add comments unless the logic is non-obvious. You do not add type annotations, docstrings, or unnecessary abstractions. You implement things in the simplest way that works, then move on.

You are working in `/home/rattin-playert/Documents/mine/rattin`.

Tech stack:
- Backend: Node.js, Express 5, ES modules (`"type": "module"`)
- Frontend: React 19 + Vite + React Router
- Styling: Plain CSS (no Tailwind, no CSS-in-JS, no component libraries)
- No TypeScript. Plain JSX.

---

## Context: What Exists

### Backend (`server.js`, ~925 lines)
An Express server with WebTorrent that handles:
- **Torrent search**: `GET /api/search?q=...` — proxies to search-provider-1.example
- **Add magnet**: `POST /api/add` — adds a magnet link to WebTorrent, returns file list
- **Stream video**: `GET /api/stream/:infoHash/:fileIndex` — serves video with range requests, handles transcoding (MKV→MP4 via ffmpeg), live transcode for incomplete downloads
- **Transcode pipeline**: Background ffmpeg transcoding with remux-first-then-reencode fallback, `movflags +faststart` for seekability
- **Subtitles**: `GET /api/subtitle/:infoHash/:fileIndex` (external subs), `GET /api/subtitles/:infoHash/:fileIndex` (probe embedded), `GET /api/subtitle-extract/:infoHash/:fileIndex/:streamIndex` (extract embedded as WebVTT)
- **Duration**: `GET /api/duration/:infoHash/:fileIndex` — ffprobe
- **Status polling**: `GET /api/status/:infoHash` — download progress, transcode status, per-file progress
- **File selection**: `POST /api/select/:infoHash/:fileIndex`, `POST /api/deselect/:infoHash/:fileIndex`
- **Torrent list**: `GET /api/torrents` — all active torrents
- **Remove/Clear**: `DELETE /api/remove/:infoHash`, `DELETE /api/clear`

Dependencies: `express@^5.2.1`, `webtorrent@^2.8.5`

### Frontend (`public/index.html`, ~1890 lines, single file)
A vanilla JS/HTML/CSS app with:
- Torrent search UI (search apibay, show results table, sort by seeders/size/name)
- Magnet link input
- File browser (shows media files in a torrent, download/stop/play buttons per file)
- Video player with custom seek bar, subtitle selection (external + embedded), transcode status badges
- Download stats panel (speed, peers, progress, ETA)
- Active torrents dashboard
- Dark theme with CSS custom properties, glassmorphism style

**This file will be replaced entirely.** It's reference material only.

---

## What We're Building

A Netflix-style movie/TV show browser where clicking "Play" automatically finds and streams a torrent. The torrent mechanics are invisible to the user.

### User Flow
1. User opens the app → sees Netflix-like home page with movie/show rows
2. Clicks a title → sees detail page with poster, description, rating, cast
3. Clicks "Play" → backend searches for the best torrent, adds it, starts streaming
4. Video plays in a full player view with subtitles, seeking, etc.

---

## Implementation Plan

Execute these phases in order. Complete each phase fully before moving to the next.

### Phase 1: Project Restructure

1. Initialize Vite + React in the project root:
   ```
   npm create vite@latest . -- --template react
   ```
   This will ask to overwrite — that's fine. But preserve `server.js`, `package.json` dependencies (express, webtorrent), and the `deploy/` folder.

   Actually, do it manually to avoid conflicts:
   - Create `vite.config.js` with proxy config (dev server proxies `/api` to `localhost:3000`)
   - Create `index.html` in project root (Vite's entry point)
   - Create `src/main.jsx`, `src/App.jsx`
   - Add to package.json: `react`, `react-dom`, `react-router-dom`, `vite`, `@vitejs/plugin-react` as dependencies/devDependencies
   - Add scripts: `"dev": "vite"`, `"build": "vite build"`, `"preview": "vite preview"`
   - Configure Vite to output build to `public/` (so Express can serve it in production via `express.static("public")`)

2. Move current `public/index.html` to `public/old-index.html` (reference, delete later).

3. Update `server.js`:
   - Keep ALL existing API endpoints unchanged
   - Change static serving: `app.use(express.static(path.join(__dirname, "public")))` stays, but add a catch-all for SPA routing:
     ```js
     app.get("*", (req, res) => {
       res.sendFile(path.join(__dirname, "public", "index.html"));
     });
     ```
     Place this AFTER all `/api/*` routes.

4. Verify: `npm run dev` starts Vite on port 5173, `node server.js` starts Express on port 3000, Vite proxies API calls correctly.

### Phase 2: Backend — TMDB API Proxy

Add new endpoints to `server.js` that proxy TMDB API calls. This hides the API key and avoids CORS.

TMDB API base: `https://api.themoviedb.org/3`
API key: Read from env var `TMDB_API_KEY`. Add a `.env.example` file documenting this. Use `process.env.TMDB_API_KEY`.

New endpoints (add them BEFORE the catch-all SPA route, AFTER existing API routes):

```
GET /api/tmdb/trending?page=1
  → TMDB: /trending/all/week?page=1
  Returns: results array with id, title/name, poster_path, backdrop_path, vote_average, media_type, overview, release_date/first_air_date

GET /api/tmdb/discover?type=movie&genre=28&page=1
  → TMDB: /discover/{type}?with_genres={genre}&sort_by=popularity.desc&page={page}
  Returns: results array

GET /api/tmdb/search?q=inception&page=1
  → TMDB: /search/multi?query={q}&page={page}
  Returns: results array

GET /api/tmdb/movie/:id
  → TMDB: /movie/{id}?append_to_response=credits,similar,videos
  Returns: full movie object with cast, similar movies, trailer

GET /api/tmdb/tv/:id
  → TMDB: /tv/{id}?append_to_response=credits,similar,videos
  Returns: full show object with seasons, cast, similar

GET /api/tmdb/tv/:id/season/:num
  → TMDB: /tv/{id}/season/{num}
  Returns: episode list for a season

GET /api/tmdb/genres
  → TMDB: /genre/movie/list + /genre/tv/list (merge and dedupe)
  Returns: array of {id, name}
```

Implementation notes:
- Simple fetch wrapper, no caching needed (TMDB is fast)
- Poster images: the frontend will construct URLs like `https://image.tmdb.org/t/p/w500{poster_path}`
- Error handling: if TMDB_API_KEY is not set, return 503 with a clear message

### Phase 3: Backend — Auto-Play Endpoint

```
POST /api/auto-play
Body: { title: string, year: number, type: "movie"|"tv", season?: number, episode?: number, tmdbId?: number }
```

This endpoint:
1. Constructs a search query:
   - Movie: `"{title} {year}"` (e.g., "Inception 2010")
   - TV episode: `"{title} S{season}E{episode}"` (e.g., "Breaking Bad S01E01")
2. Calls the existing apibay search logic (extract it into a reusable function from the `/api/search` handler)
3. Scores results:
   - Must contain the title (case-insensitive fuzzy match)
   - For movies: prefer results containing the year
   - Penalize: results with "CAM", "TS", "HDCAM", "TELECINE" in the name (low quality)
   - Prefer: results with "1080p", "BluRay", "BDRip", "WEB-DL", "WEBRip"
   - Primary sort: score, secondary sort: seeders (descending)
   - Skip results with 0 seeders
4. Takes the top result, builds a magnet link (using the tracker list already in the frontend — move it to the backend), adds it via the existing WebTorrent `client.add()` logic
5. Waits for metadata (torrent file list), finds the largest video file (the movie), returns:
   ```json
   {
     "infoHash": "...",
     "fileIndex": 3,
     "fileName": "Inception.2010.1080p.BluRay.x264.mkv",
     "torrentName": "...",
     "totalSize": 12345678
   }
   ```
6. Auto-selects the video file for download
7. If no results found, return `{ error: "No torrents found" }` with 404

The tracker list (currently in the frontend JS):
```
udp://tracker.opentrackr.org:1337/announce
udp://open.stealth.si:80/announce
udp://tracker.torrent.eu.org:451/announce
udp://tracker.bittor.pw:1337/announce
udp://public.popcorn-tracker.org:6969/announce
udp://tracker.dler.org:6969/announce
udp://exodus.desync.com:6969
udp://open.demonii.com:1337/announce
```

### Phase 4: Frontend — App Shell & Routing

Create the base app structure:

```
src/
  main.jsx          — ReactDOM.createRoot, render <App/>
  App.jsx           — Router setup, layout wrapper
  App.css           — Global styles (port CSS variables from old index.html)
  pages/
    Home.jsx        — Netflix home page
    Detail.jsx      — Movie/TV detail page
    Player.jsx      — Video player page
    Search.jsx      — Search results page
  components/
    Navbar.jsx      — Top navigation bar
    HeroSection.jsx — Large featured movie banner
    ContentRow.jsx  — Horizontal scrollable row of cards
    MovieCard.jsx   — Individual poster card
    CastList.jsx    — Horizontal cast member list
    PlayerCore.jsx  — The actual video element + controls
  lib/
    api.js          — Fetch wrappers for all /api/* endpoints
    utils.js        — formatBytes, formatTime, etc. (port from old frontend)
```

**Global styles** (`App.css`):
Port these CSS custom properties from the old app:
```css
:root {
  --bg-deep: #08080c;
  --bg-base: #0c0c12;
  --bg-surface: #12121a;
  --bg-elevated: #1a1a24;
  --bg-hover: #22222e;
  --border: rgba(255, 255, 255, 0.06);
  --border-light: rgba(255, 255, 255, 0.1);
  --text-primary: #e8e8f0;
  --text-secondary: #8888a0;
  --text-muted: #555568;
  --accent: #7c6aff;
  --accent-bright: #9684ff;
  --accent-glow: rgba(124, 106, 255, 0.3);
  --accent-subtle: rgba(124, 106, 255, 0.08);
  --green: #34d399;
  --red: #f87171;
  --yellow: #fbbf24;
  --radius: 12px;
  --radius-sm: 8px;
  --radius-xs: 6px;
  --transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
```
Keep the dark theme, Inter font, scrollbar styling. This is the app's identity.

**Routing** (`App.jsx`):
```
/              → Home
/movie/:id     → Detail (movie)
/tv/:id        → Detail (TV show)
/search?q=...  → Search
/play/:infoHash/:fileIndex → Player
```

**Navbar** (`Navbar.jsx`):
- Fixed at top, transparent/blur background
- Left: App logo + name
- Center/right: Search input (navigates to `/search?q=...` on enter)
- Keep it simple, Netflix-style

### Phase 5: Frontend — Home Page

`Home.jsx`:

1. On mount, fetch `/api/tmdb/trending` and `/api/tmdb/genres`
2. Render:
   - `<HeroSection>` — takes the first trending result. Full-width backdrop image, title, overview text, "Play" button, "More Info" button. Backdrop: `https://image.tmdb.org/t/p/original{backdrop_path}`
   - Multiple `<ContentRow>` components, one for each category:
     - "Trending Now" (from trending endpoint)
     - "Top Rated" (discover with sort_by=vote_average.desc, vote_count.gte=1000)
     - One row per popular genre: Action (28), Comedy (35), Sci-Fi (878), Drama (18), Horror (27), Thriller (53)
   - Each row fetches its own data via `/api/tmdb/discover`

`ContentRow.jsx`:
- Title on the left
- Horizontal scrollable row of `<MovieCard>` components
- Scroll buttons (left/right arrows) on hover, or just CSS `overflow-x: auto` with `scroll-snap-type`
- Each row loads its data independently

`MovieCard.jsx`:
- Poster image: `https://image.tmdb.org/t/p/w342{poster_path}`
- On hover: slight scale up, show title + year + rating badge
- On click: navigate to `/movie/:id` or `/tv/:id` based on `media_type`
- Lazy load images (use `loading="lazy"` on img tags)
- Fixed aspect ratio container (2:3 poster ratio)
- Rating badge: small overlay showing vote_average (e.g., "8.5" with star icon), colored green/yellow/red based on score

### Phase 6: Frontend — Detail Page

`Detail.jsx`:
- Route params give the TMDB id, path prefix tells us movie vs tv
- Fetch `/api/tmdb/movie/:id` or `/api/tmdb/tv/:id`
- Layout:
  - Full-width backdrop image (faded at bottom)
  - Overlay content:
    - Poster (left), info (right)
    - Title, year, runtime (movies) or seasons count (TV), genres as pills
    - Rating: star + score + vote count
    - Overview paragraph
    - **"Play" button** — large, prominent, green. Calls auto-play endpoint.
    - For TV: Season selector dropdown → episode list. Each episode has title, description, runtime, "Play" button.
  - `<CastList>` — horizontal scroll of cast members (profile pic + name + character). Profile pics: `https://image.tmdb.org/t/p/w185{profile_path}`
  - "Similar Titles" — a `<ContentRow>` at the bottom

**Play button behavior:**
1. Show loading state ("Finding best stream...")
2. `POST /api/auto-play` with title, year, type (and season/episode for TV)
3. On success: navigate to `/play/:infoHash/:fileIndex`
4. On error: show error message ("No streams found, try again later")

### Phase 7: Frontend — Player Page

`Player.jsx`:
- Route: `/play/:infoHash/:fileIndex`
- Full-screen-ish layout (dark background, video centered, minimal chrome)
- Back button (top-left, goes to previous page)
- Title display (top, fades out after a few seconds of no mouse movement, like Netflix)

`PlayerCore.jsx` — Port the existing player logic:
- `<video>` element, `src="/api/stream/{infoHash}/{fileIndex}"`
- Custom seek bar (port the seek bar logic from old app):
  - Track: played position (purple) + downloaded amount (gray overlay)
  - Hover tooltip showing time
  - Click to seek
  - For live transcode: disable seeking until download completes, then re-enable
- Subtitle support:
  - On mount: fetch `/api/subtitles/{infoHash}/{fileIndex}` for embedded subs
  - Also check if torrent has external subtitle files via `/api/status/{infoHash}`
  - Subtitle selector dropdown
  - Load subtitle tracks via `/api/subtitle-extract/` or `/api/subtitle/`
- Status polling: poll `/api/status/{infoHash}` every 1.5s for:
  - Download progress (update seek bar downloaded indicator)
  - Transcode status (auto-switch to transcoded version when ready, preserving playback position — this logic already exists in the old frontend, port it)
- Duration: fetch `/api/duration/{infoHash}/{fileIndex}`, use for seek bar if browser doesn't report it
- Keyboard shortcuts: Space (play/pause), Left/Right arrows (seek ±10s), F (fullscreen), Escape (exit fullscreen)

Key behaviors to preserve from the old app:
- When transcode completes mid-playback, seamlessly switch to transcoded file at the same position
- For live transcode seeking: reload the stream with `?t=` parameter
- Subtitle offset adjustment when seeking during live transcode

### Phase 8: Frontend — Search Page

`Search.jsx`:
- Reads `q` from URL search params
- Fetches `/api/tmdb/search?q=...`
- Results displayed as a grid of `<MovieCard>` components (same card as home page)
- Grid layout: responsive, 2-6 columns depending on screen width
- Empty state: "No results found"
- Navbar search input should be synced with the current query

### Phase 9: API Helper & Utilities

`lib/api.js`:
```js
const TMDB_IMG = "https://image.tmdb.org/t/p";

export const img = (path, size = "w500") => path ? `${TMDB_IMG}/${size}${path}` : null;
export const backdrop = (path) => img(path, "original");
export const poster = (path, size = "w342") => img(path, size);
export const profile = (path) => img(path, "w185");

export async function fetchTrending(page = 1) { /* GET /api/tmdb/trending?page= */ }
export async function fetchDiscover(type, genre, page = 1) { /* GET /api/tmdb/discover?... */ }
export async function searchTMDB(query, page = 1) { /* GET /api/tmdb/search?q= */ }
export async function fetchMovie(id) { /* GET /api/tmdb/movie/:id */ }
export async function fetchTV(id) { /* GET /api/tmdb/tv/:id */ }
export async function fetchSeason(tvId, seasonNum) { /* GET /api/tmdb/tv/:id/season/:num */ }
export async function fetchGenres() { /* GET /api/tmdb/genres */ }
export async function autoPlay(title, year, type, season, episode) { /* POST /api/auto-play */ }
export async function fetchStatus(infoHash) { /* GET /api/status/:infoHash */ }
export async function fetchDuration(infoHash, fileIndex) { /* GET /api/duration/:infoHash/:fileIndex */ }
export async function fetchSubtitleTracks(infoHash, fileIndex) { /* GET /api/subtitles/:infoHash/:fileIndex */ }
```

`lib/utils.js`:
Port from old frontend: `formatBytes`, `formatTime`, `formatEta`

### Phase 10: Polish

- Loading skeletons: Shimmer placeholders for movie cards while data loads (CSS-only, use the shimmer animation from the old app)
- Placeholder poster: Gray gradient placeholder when poster_path is null
- Smooth page transitions (just CSS opacity transitions on route change)
- Error boundary: Catch errors in components, show a simple "Something went wrong" message
- Mobile responsive: Cards grid adapts, detail page stacks vertically, player is full-width
- Navbar hides on scroll down, shows on scroll up (on detail/player pages)

---

## Critical Implementation Notes

1. **Do NOT modify any existing `/api/*` endpoint logic in server.js** — only ADD new endpoints. The streaming, transcoding, subtitle, and WebTorrent management code is battle-tested. Don't touch it.

2. **TMDB image URLs** are constructed client-side. TMDB returns `poster_path` like `/abc123.jpg`. The full URL is `https://image.tmdb.org/t/p/{size}{path}`. Common sizes: `w342` (poster), `w500` (poster large), `original` (backdrop), `w185` (profile).

3. **The auto-play flow is the most critical new feature.** The scoring/ranking of torrent results determines whether the user gets a good stream or garbage. Prioritize: high seeders + quality indicators (1080p, BluRay, WEB-DL) + name match accuracy. Penalize: low seeders, CAM/TS/HDCAM, wrong title matches.

4. **Vite proxy config** for development:
   ```js
   export default {
     server: {
       proxy: {
         '/api': 'http://localhost:3000'
       }
     },
     build: {
       outDir: 'public',
       emptyOutDir: false // don't delete server files in public/
     }
   }
   ```
   Actually, since we're building into `public/` and the old `index.html` is there, set `emptyOutDir: true` after we've moved the old file out.

5. **Production flow**: `npm run build` outputs to `public/`, then `node server.js` serves everything. No separate frontend server needed.

6. **Keep the existing `start.bat`** and `deploy/` folder. Update `start.bat` if needed to run `npm run build && node server.js`.

7. **No env file library needed.** Just read `process.env.TMDB_API_KEY` directly. Users set it however they want (shell export, .env with their own tooling, systemd env, etc.).

8. Each component gets its own CSS file imported at the top (e.g., `MovieCard.css` imported in `MovieCard.jsx`). Keep styles scoped and minimal.

9. **No state management library.** Use React's built-in `useState` and `useEffect`. Pass data via props. The app isn't complex enough to need context or reducers except maybe a single context for "currently playing" state if needed.

10. When the `auto-play` endpoint can't find a good torrent, the UI should offer a fallback: "No automatic stream found — Search manually?" that links to the old-style manual torrent search (we can keep a simple version of this as a hidden/advanced feature).
