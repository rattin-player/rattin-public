# UX Improvements v3 — Design Spec

## Overview

Five user-facing issues to address in a single pass:

1. Loading spinner appears when video is paused (not buffering)
2. Torrent source picker rework — grouped by resolution, top 3 per group
3. Subtitle/audio track popup overflows when too many tracks
4. Continue Watching should play directly instead of navigating to Detail
5. English audio/subtitle auto-detection fails with region-tagged tracks

---

## Issue 1: Loading Spinner on Pause

### Root Cause

`shell/main.qml:178` — when mpv goes `core-idle` (which happens on pause), the handler starts `seekBufferTimer` because the condition only checks `idle && playing && !loadingOverlay` — it doesn't check `paused`. The timer fires after 300ms and sets `seekBuffering = true`, showing the seek-buffering spinner.

### Fix

- Add `&& !root.paused` to the `seekBufferTimer` start condition at line 178
- Add `&& !root.paused` to the `seekBufferTimer.onTriggered` guard at line 255
- In `onPauseChanged` handler (line 151-153), clear `seekBuffering` when pausing

---

## Issue 2: Torrent Source Picker Rework

### Current State

Flat list of up to 50 torrents with filter chips (resolution, language, features). Each torrent shows name, all tags, source, seeders, size, and various unreliable badges (language flags, multi-audio, subs, foreign).

### New Design

**Grouped by resolution** — 3 main sections (4K, 1080p, 720p), each showing top 3 torrents by score. First torrent in the highest-available group has a "selected" visual treatment. Clicking any row plays immediately (same behavior as current).

**Layout per resolution group:**
- Resolution header label (e.g., "4K")
- Up to 3 torrent rows, sorted by score then seeders
- First row is visually larger/highlighted as the default pick

**Per torrent row shows:**
- Torrent name (truncated)
- Tags: resolution, codec, source type — text in `var(--accent-bright)`, background stays gray
- Cached badge (if applicable)
- Source provider (TORRENTIO, TPB, etc.)
- Seeder count with green dot
- File size

**Removed from display:**
- Language flags (unreliable)
- Multi-audio badge (unreliable)
- Subs badge (unreliable from Torrentio metadata)
- Foreign badge (unreliable)
- Season Pack badge for movies (bug — see below)

**Torrents without a recognized resolution** go into an "Other" group at the bottom.

### Season Pack Bug Fix

`lib/torrentio.ts:164-166`: `seasonPack` is set when `fileIdx !== undefined && !S##E##.test(name)`. For movies, Torrentio sets `fileIdx` to indicate which file in a multi-file torrent, and movie names don't have `S##E##` patterns, so every movie torrent from Torrentio gets tagged as a season pack.

Fix: Only set `seasonPack: true` when the search was for TV content (when `season` and `episode` parameters are present in the search call). The `searchTorrentio` function already receives `type`, `season`, `episode` — pass `type` through to the mapping logic.

### Scoring Rebalance

Current scoring allows 5-seeder torrents to outrank 200-seeder ones because title match (50pts) + year (15pts) + source (12pts) dominate seeders (log2 curve, capped at 40pts).

**New weights:**
- Title match: keep at 50 (necessary to avoid wrong-title results)
- Year match (movies only): reduce from 15 → 8
- Resolution: keep (10-20)
- Source quality: reduce from 8-12 → 5-8
- Seeders: increase weight — `Math.min(50, Math.log2(seeders + 1) * 5)`. This gives: 5s→13, 50s→28, 200s→38, 1000s→50
- Remove `hasSubs` +5 bonus (unreliable)
- Remove `multiAudio` +5 bonus (unreliable)
- Remove `foreignOnly` -20 penalty (unreliable)
- Remove all language/sub scoring from `scoreTorrent()`
- CAM penalty: keep at -50

### SourcePicker Component Changes

Replace `SourcePicker.tsx` entirely:
- Remove all filter state and filter UI
- Group streams by resolution using `getRes(tags)`
- Within each group, take top 3 by score
- Render grouped layout
- `onPick` callback stays the same (clicking a row calls it)

The in-player source switcher (`Player.tsx:608-663`) should also get the same tag cleanup (remove language/subs/foreign badges) but keep the flat list layout since it's a secondary UI.

---

## Issue 3: Track Picker Overflow

### Root Cause

`shell/main.qml:608`: `height: trackCol.height + 24` — unbounded. No scrolling mechanism exists.

### Fix

- Set maximum height: `height: Math.min(trackCol.height + 24, 340)`
- Wrap subtitle + audio repeaters inside a `Flickable` with `clip: true`
- Add `ScrollBar.vertical` that appears only when content overflows
- Keep the size controls (A-/A+) outside the Flickable since they're always visible
- The Flickable's `contentHeight` is driven by its inner Column

---

## Issue 4: Continue Watching → Direct Play

### Current Flow

Click poster → navigate to `/{type}/{tmdbId}` (Detail page) → user clicks Play → `autoPlay()` → navigate to Player.

### New Flow

Click poster → show loading state on card → call `autoPlay()` directly → navigate to Player with full state.

### Schema Changes

Add optional fields to `WatchRecord` (in `lib/watch-history.ts`):
- `imdbId?: string` — needed for Torrentio search (best provider)
- `year?: number` — needed for movie search quality

These are populated during `reportWatchProgress` — the Player already has this data in its `state` object. The backend `handleProgress` handler passes them through to `recordProgress`. Existing records without these fields work fine (autoPlay falls back to text search).

### Frontend Changes

`WatchHistoryRow.tsx`:
- Add an `onPlay?: (item) => Promise<void>` prop
- On poster click: if `onPlay` is provided, call it instead of navigating to Detail
- Show a loading indicator on the card while `onPlay` is in progress
- If `onPlay` throws (e.g., no streams found), fall back to navigating to Detail

`Home.tsx`:
- Pass `onPlay` to the Continue Watching `WatchHistoryRow`
- The handler calls `autoPlay(item.title, item.year, item.mediaType, item.season, item.episode, item.imdbId)`
- On success, navigate to `/play/${result.infoHash}/${result.fileIndex}` with the same state shape Detail uses

### Navigation State

Player.tsx requires specific state fields. The `onPlay` handler must construct:
```
{ tags, title, tmdbId, year, type, imdbId, posterPath, season?, episode?,
  episodeTitle?, seasonEpisodeCount?, debridStreamKey?, resumePosition? }
```

All of these are available from the WatchRecord (after schema expansion) except `debridStreamKey` (comes from `autoPlay` result) and `tags` (comes from `autoPlay` result).

---

## Issue 5: English Audio/Subtitle Auto-Detection

### Root Cause

`useAudioTracks.ts:67-69` and `useSubtitles.ts:80-82` use exact string matching for language codes. ffprobe can return region-tagged codes like `"fr-CA"`, `"en-US"`, `"pt-BR"` which don't match `"en"`, `"eng"`, or `"english"`.

Additionally, `LANG_MAP` in `useSubtitles.ts:4-12` doesn't handle region variants for display purposes.

### Fix

Create a shared `isEnglishLang(lang: string): boolean` helper:
```ts
function isEnglishLang(lang: string): boolean {
  const base = lang.toLowerCase().split(/[-_]/)[0];
  return base === "eng" || base === "en" || base === "english";
}
```

Apply in:
- `useAudioTracks.ts:67-69` — replace inline English check
- `useSubtitles.ts:80-82` — replace `isEnglish()` function

For `LANG_MAP` lookups, strip region before lookup:
```ts
const base = lang.split(/[-_]/)[0];
const label = LANG_MAP[base] || lang;
```

This handles: `"en"`, `"eng"`, `"en-US"`, `"en-GB"`, `"en-CA"`, `"english"` → all detected as English.
