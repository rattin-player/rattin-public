# Magnet Copy & Paste Design

**Date:** 2026-04-06  
**Scope:** SourcePicker copy-magnet button + navbar magnet-paste-to-play

---

## Overview

Two related convenience features centered on magnet links:

1. **Copy Magnet** — a button in each SourcePicker row lets the user copy the torrent's magnet URI to the clipboard.
2. **Magnet Paste to Play** — pasting a magnet link into the search bar and pressing Enter plays it directly, bypassing the TMDB search flow.

Both features are low-priority additions. They must not introduce regressions in normal search/play behavior.

---

## Feature 1: Copy Magnet button in SourcePicker

### Problem

`picker-item` is currently rendered as a `<button>`. HTML does not allow nesting interactive elements inside a `<button>`, so a copy button cannot be added inside without browser-silent breakage.

### Solution

Convert the outer `<button class="picker-item">` to a `<div class="picker-item" role="button" tabIndex={0}>` with an `onClick` handler and an `onKeyDown` handler (Enter/Space → pick). Keyboard accessibility is preserved.

Add `<button class="picker-copy-magnet">` as the last element inside `.picker-item-meta`, after `.picker-size`. It stops propagation so clicking it does not also trigger source selection.

### Magnet construction

Constructed entirely on the frontend from fields already present in the stream object:

```
magnet:?xt=urn:btih:{s.infoHash}&dn={encodeURIComponent(s.name)}
```

No tracker list is included. Modern clients use DHT, so trackers are not required for discovery.

### Copy feedback

A per-row `copiedId` state tracks which row (if any) was just copied. For 1.5 s after clicking, the button label changes to "Copied!" then resets. Uses `navigator.clipboard.writeText`.

### Files changed

- `src/components/SourcePicker.tsx` — outer element type, copy button, copied state
- `src/components/SourcePicker.css` — `.picker-copy-magnet` styles (small, muted, right-aligned)

---

## Feature 2: Magnet paste to play in Navbar

### Detection

In `handleSubmit` in `Navbar.tsx`, before the existing search logic, check:

```ts
const trimmed = query.trim();
if (trimmed.startsWith("magnet:?xt=urn:btih:")) {
  // handle magnet
  return;
}
// existing: navigate to /search?q=...
```

The prefix check is strict enough to avoid false positives on normal queries.

### Parsing

Extract fields from the magnet URI using `URL` + `URLSearchParams` (or manual string parsing):

- `infoHash`: from `xt=urn:btih:{hash}`, lowercased
- `name`: from `dn=...` if present, fallback to the raw infoHash string

### Play flow

1. Set `loading = true` (disables input, prevents double-submit)
2. Call `playTorrent(infoHash, name)` → `{ infoHash, fileIndex, tags }`
3. Navigate to `/play/{infoHash}/{fileIndex}` with state:
   ```ts
   { title: name, posterPath: null, sources: [], tags: result.tags }
   ```
4. On error: set `loading = false`, swallow silently (no toast, no redirect)

### No regressions

- Normal queries (non-magnet) hit the existing path unchanged.
- `playTorrent` is already used by Detail.tsx for the same purpose — no new API contract.

### Files changed

- `src/components/Navbar.tsx` — magnet detection, loading state, playTorrent call
- `src/lib/api.ts` — no changes needed; `playTorrent` is already exported

---

## Feature 3: Missing poster / source switcher (no changes required)

### Poster

`Player.tsx` already guards:
```ts
if (posterPath) mpvSetPoster(`https://image.tmdb.org/t/p/w1280${posterPath}`);
```
When `posterPath` is null (magnet play), the QML loading overlay shows the title without a backdrop image. This is acceptable UX.

### Source switcher

The player renders the source panel only when `sources.length > 1`. With `sources: []` from magnet state, the button never appears. No change needed.

---

## Constraints

- This is a low-priority convenience feature. If magnet play fails silently, that is acceptable.
- No regressions to normal search, auto-play, or source-picker-pick flows.
- No new API endpoints required.
