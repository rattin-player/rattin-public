# UX Improvements v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 user-facing issues: loading spinner on pause, torrent picker rework with scoring rebalance, track popup overflow, direct play from continue watching, and English audio/subtitle auto-detection.

**Architecture:** All changes are frontend-only except: scoring rebalance (backend `lib/torrent-scoring.ts`), season pack fix (backend `lib/torrentio.ts`), watch history schema expansion (backend `lib/watch-history.ts` + `routes/storage.ts`), and language detection (frontend hooks). QML changes are in `shell/main.qml`.

**Tech Stack:** TypeScript, React, QML, Node.js

**Spec:** `docs/superpowers/specs/2026-04-04-ux-improvements-v3-design.md`

---

### Task 1: Fix loading spinner showing on pause

**Files:**
- Modify: `shell/main.qml:151-153` (onPauseChanged handler)
- Modify: `shell/main.qml:178` (seekBufferTimer start condition)
- Modify: `shell/main.qml:255` (seekBufferTimer onTriggered guard)

- [ ] **Step 1: Add pause guard to seekBufferTimer start condition**

In `shell/main.qml`, line 178, change:

```qml
// Before:
if (idle && root.playing && !root.loadingOverlay) {
    seekBufferTimer.start()
}

// After:
if (idle && root.playing && !root.loadingOverlay && !root.paused) {
    seekBufferTimer.start()
}
```

- [ ] **Step 2: Add pause guard to seekBufferTimer onTriggered**

In `shell/main.qml`, line 254-257, change:

```qml
// Before:
onTriggered: {
    if (root.coreIdle && root.playing && !root.loadingOverlay)
        root.seekBuffering = true
}

// After:
onTriggered: {
    if (root.coreIdle && root.playing && !root.loadingOverlay && !root.paused)
        root.seekBuffering = true
}
```

- [ ] **Step 3: Clear seekBuffering on pause**

In `shell/main.qml`, line 151-153, change:

```qml
// Before:
function onPauseChanged(p) {
    transport.pauseChanged(p)
    root.paused = p
}

// After:
function onPauseChanged(p) {
    transport.pauseChanged(p)
    root.paused = p
    if (p) {
        seekBufferTimer.stop()
        root.seekBuffering = false
    }
}
```

- [ ] **Step 4: Test manually**

1. Play any video, let it buffer and start
2. Pause the video — verify NO spinner appears
3. Seek while playing — verify the seek-buffering spinner DOES appear during rebuffer
4. Resume after pause — verify normal playback

- [ ] **Step 5: Commit**

```bash
git add shell/main.qml
git commit -m "fix: don't show buffering spinner when video is paused"
```

---

### Task 2: Fix season pack false positive for movies

**Files:**
- Modify: `lib/torrentio.ts:133-177` (searchTorrentio function)
- Test: `test/torrentio.test.ts`

- [ ] **Step 1: Check existing torrentio tests for season pack coverage**

Run: `npx tsx --test test/torrentio.test.ts`

Read the test file to understand existing test patterns.

- [ ] **Step 2: Write failing test**

Add to `test/torrentio.test.ts` a test that verifies movie results don't get `seasonPack: true`:

```ts
it("does not mark movie results as season packs", async () => {
  // Movies from Torrentio often have fileIdx set (for multi-file torrents)
  // but should never be flagged as season packs
  const results = await searchTorrentio("tt1234567", "movie");
  for (const r of results) {
    assert.strictEqual(r.seasonPack, false,
      `Movie torrent "${r.name}" should not be marked as season pack`);
  }
});
```

Note: This test depends on a live API call. If the existing tests mock Torrentio, follow that pattern instead. If they use live calls, this test may be flaky — in that case, test `parseTorrentioTitle` / the mapping logic directly.

**Alternative unit test** (if mocking is preferred — check existing patterns):

```ts
it("does not set seasonPack for movie type", () => {
  // Simulate: searchTorrentio maps streams, and for movies,
  // seasonPack should always be false regardless of fileIdx
  const stream = { infoHash: "abc123", title: "Movie.2024.1080p\n👤 100\n💾 2.1 GB\n⚙️ torrentio", fileIdx: 3 };
  // The fix: type === "tv" must be checked before setting seasonPack
});
```

- [ ] **Step 3: Fix searchTorrentio**

In `lib/torrentio.ts`, the `searchTorrentio` function — change the `seasonPack` mapping:

```ts
// Before (line 164-166):
seasonPack:
  s.fileIdx !== undefined &&
  !/S\d{1,2}E\d{1,2}/i.test(parsed.torrentName),

// After:
seasonPack:
  type === "tv" &&
  s.fileIdx !== undefined &&
  !/S\d{1,2}E\d{1,2}/i.test(parsed.torrentName),
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test test/torrentio.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/torrentio.ts test/torrentio.test.ts
git commit -m "fix: don't flag movie torrents as season packs"
```

---

### Task 3: Rebalance torrent scoring

**Files:**
- Modify: `lib/torrent-scoring.ts:22-63` (scoreTorrent function)
- Modify: `test/torrent-scoring.test.ts` (update scoring tests)

- [ ] **Step 1: Update existing tests to reflect new weights**

The test at line 115-119 asserts seeder cap at 30 — this changes to 50. Update:

```ts
it("caps seeder bonus at 50", () => {
  const big = scoreTorrent(makeTorrent("Inception.2010.1080p", 100000), "Inception", 2010, "movie");
  const huge = scoreTorrent(makeTorrent("Inception.2010.1080p", 10000000), "Inception", 2010, "movie");
  assert.ok(Math.abs(big - huge) < 1);
});
```

- [ ] **Step 2: Add test that high-seeder torrents beat low-seeder torrents with slightly better metadata**

```ts
it("200 seeders outranks 5 seeders even with slightly better metadata", () => {
  // 5-seeder torrent has year + source tag, 200-seeder torrent doesn't
  const fewSeeds = scoreTorrent(
    { name: "Inception.2010.1080p.WEB-DL", seeders: 5 },
    "Inception", 2010, "movie",
  );
  const manySeeds = scoreTorrent(
    { name: "Inception.1080p", seeders: 200 },
    "Inception", 2010, "movie",
  );
  assert.ok(manySeeds > fewSeeds,
    `200 seeders (${manySeeds}) should beat 5 seeders (${fewSeeds})`);
});
```

- [ ] **Step 3: Run tests to confirm they fail with current scoring**

Run: `npx tsx --test test/torrent-scoring.test.ts`

Expected: The "200 seeders outranks 5 seeders" test FAILS (this is the bug we're fixing).

- [ ] **Step 4: Rebalance scoring in scoreTorrent()**

Replace the scoring logic in `lib/torrent-scoring.ts:22-63`:

```ts
export function scoreTorrent(result: TorrentResult, title: string, year: number | undefined, type: string): number {
  let score = 0;
  const name = result.name.toLowerCase();
  const titleLower = title.toLowerCase();

  if (!name.includes(titleLower.split(" ")[0])) return -1;

  const titleWords = titleLower.split(/\s+/);
  const matchedWords = titleWords.filter((w) => name.includes(w)).length;
  score += (matchedWords / titleWords.length) * 50;

  // Year match is only meaningful for movies
  if (year && type === "movie" && name.includes(String(year))) score += 8;

  if (/1080p/.test(name)) score += 20;
  if (/2160p|4k/i.test(name)) score += 15;
  if (/720p/.test(name)) score += 10;
  if (/blu-?ray|bdremux/i.test(name)) score += 6;
  if (/web-?dl|webrip/i.test(name)) score += 8;
  if (/bdrip/i.test(name)) score += 5;
  if (/remux/i.test(name)) score += 3;

  if (/\bcam\b|hdcam|telecine|\bts\b|hdts|telesync/i.test(name)) score -= 50;

  if (result.seeders === 0) return -1;
  // Seeders: strongest real-world signal for availability
  // log2 curve: 5s→13, 50s→28, 200s→38, 1000s→50
  score += Math.min(50, Math.log2(result.seeders + 1) * 5);

  return score;
}
```

Key changes:
- Year bonus: 15 → 8
- Source quality: WEB-DL/WEBRip 12→8, BluRay 8→6, BDRip 8→5
- Seeders: cap 40→50, multiplier 3→5
- Removed: all `hasSubs`, `multiAudio`, `foreignOnly` scoring

- [ ] **Step 5: Run tests**

Run: `npx tsx --test test/torrent-scoring.test.ts`

Expected: ALL PASS — including the new "200 seeders outranks 5 seeders" test.

- [ ] **Step 6: Commit**

```bash
git add lib/torrent-scoring.ts test/torrent-scoring.test.ts
git commit -m "fix: rebalance torrent scoring — seeders now dominate over metadata"
```

---

### Task 4: Rework SourcePicker to grouped layout

**Files:**
- Rewrite: `src/components/SourcePicker.tsx`
- Rewrite: `src/components/SourcePicker.css`
- Modify: `src/pages/Player.tsx:608-663` (remove unreliable badges from in-player source switcher)

- [ ] **Step 1: Rewrite SourcePicker.tsx**

Replace `src/components/SourcePicker.tsx` with:

```tsx
import { useMemo } from "react";
import { formatBytes } from "../lib/utils";
import "./SourcePicker.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stream = any;

const RES_ORDER = ["4K", "1080p", "720p", "480p"] as const;

function getRes(tags: string[]): string | null {
  for (const r of RES_ORDER) if (tags.includes(r)) return r;
  return null;
}

interface ResGroup {
  resolution: string;
  streams: Stream[];
}

interface SourcePickerProps {
  streams: Stream[] | null;
  onPick: (stream: Stream) => void;
  onClose: () => void;
}

export default function SourcePicker({ streams, onPick, onClose }: SourcePickerProps) {
  const groups = useMemo<ResGroup[]>(() => {
    if (!streams || streams.length === 0) return [];

    const byRes = new Map<string, Stream[]>();
    for (const s of streams) {
      const res = getRes(s.tags || []);
      const key = res || "Other";
      const list = byRes.get(key) || [];
      list.push(s);
      byRes.set(key, list);
    }

    // Order: 4K, 1080p, 720p, 480p, Other
    const ordered: ResGroup[] = [];
    for (const r of RES_ORDER) {
      const list = byRes.get(r);
      if (list) ordered.push({ resolution: r, streams: list.slice(0, 3) });
    }
    const other = byRes.get("Other");
    if (other) ordered.push({ resolution: "Other", streams: other.slice(0, 3) });

    return ordered;
  }, [streams]);

  // The "default" pick is the first stream in the first group
  const defaultHash = groups[0]?.streams[0]?.infoHash;

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="picker-header">
          <h3>Select Source</h3>
          {streams && <span className="picker-count">{streams.length} sources</span>}
          <button className="picker-close" onClick={onClose}>&#10005;</button>
        </div>

        <div className="picker-list">
          {streams === null ? (
            <div className="picker-loading">Searching providers...</div>
          ) : groups.length === 0 ? (
            <div className="picker-empty">No streams found</div>
          ) : (
            groups.map((group) => (
              <div key={group.resolution} className="picker-group">
                <div className="picker-group-label">{group.resolution}</div>
                {group.streams.map((s: Stream, i: number) => {
                  const isDefault = s.infoHash === defaultHash;
                  return (
                    <button
                      key={s.infoHash}
                      className={`picker-item${isDefault ? " default" : ""}${i === 0 ? " first" : ""}`}
                      onClick={() => onPick(s)}
                    >
                      <div className="picker-item-row">
                        <div className="picker-item-main">
                          <span className="picker-item-name">{s.name}</span>
                          <div className="picker-item-tags">
                            {s.cached && <span className="picker-tag cached">Cached</span>}
                            {s.seasonPack && <span className="picker-tag season-pack">Season Pack</span>}
                            {s.tags.filter((t: string) => t !== "Native").map((t: string) => (
                              <span key={t} className="picker-tag">{t}</span>
                            ))}
                          </div>
                        </div>
                        <div className="picker-item-meta">
                          <span className="picker-source">{s.source.toUpperCase()}</span>
                          <span className="picker-seeds">
                            <span className="picker-seed-dot" />
                            {s.seeders}
                          </span>
                          <span className="picker-size">{formatBytes(s.size)}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite SourcePicker.css**

Replace `src/components/SourcePicker.css` — keep the existing modal/overlay styles, remove filter styles, add group styles:

```css
/* -- Source Picker Modal -- */

.picker-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  animation: fadeIn 0.2s ease-out;
}

.picker-modal {
  background: var(--bg-base);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  width: 100%;
  max-width: 760px;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
  animation: fadeUp 0.3s ease-out;
}

.picker-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 24px;
  border-bottom: 1px solid var(--border);
}

.picker-header h3 {
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 500;
}

.picker-count {
  font-size: 0.72rem;
  color: var(--text-muted);
  font-weight: 500;
  letter-spacing: 0.3px;
}

.picker-close {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: all var(--transition);
  margin-left: auto;
}

.picker-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* -- Source List -- */

.picker-list {
  overflow-y: auto;
  padding: 4px 8px 8px;
}

.picker-loading,
.picker-empty {
  padding: 48px 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.9rem;
}

/* -- Resolution Groups -- */

.picker-group {
  margin-bottom: 4px;
}

.picker-group-label {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 12px 14px 4px;
}

/* -- Source Items -- */

.picker-item {
  display: block;
  width: 100%;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background var(--transition);
  border: 1px solid transparent;
}

.picker-item:hover {
  background: var(--bg-hover);
  border-color: var(--border);
}

.picker-item.default {
  background: var(--accent-subtle);
  border-color: var(--accent);
}

.picker-item.default:hover {
  background: var(--accent-subtle);
  border-color: var(--accent-bright);
}

.picker-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.picker-item-main {
  flex: 1;
  min-width: 0;
}

.picker-item-name {
  display: block;
  font-size: 0.82rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 5px;
  color: var(--text-primary);
}

.picker-item-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.picker-tag {
  padding: 2px 6px;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--accent-bright);
}

.picker-tag.season-pack {
  background: var(--accent-subtle);
  color: var(--accent-bright);
}

.picker-tag.cached {
  background: rgba(250, 204, 21, 0.12);
  color: var(--accent-bright);
}

.picker-item-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 0 0 auto;
}

.picker-source {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 3px 8px;
  border-radius: 3px;
  background: var(--accent-subtle);
  color: var(--accent-bright);
}

.picker-seeds {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.76rem;
  color: var(--green);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.picker-seed-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 4px rgba(74, 222, 128, 0.4);
}

.picker-size {
  font-size: 0.76rem;
  color: var(--text-muted);
  min-width: 56px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* -- Mobile -- */
@media (max-width: 768px) {
  .picker-overlay {
    padding: 0;
    align-items: flex-end;
  }

  .picker-modal {
    max-height: 92vh;
    border-radius: var(--radius) var(--radius) 0 0;
    max-width: 100%;
  }

  .picker-item-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .picker-item-name {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 0.78rem;
    line-height: 1.4;
  }

  .picker-item-meta {
    width: 100%;
    justify-content: flex-start;
    gap: 10px;
  }

  .picker-size {
    min-width: auto;
    text-align: left;
  }
}
```

- [ ] **Step 3: Clean up in-player source switcher badges**

In `src/pages/Player.tsx`, around lines 630-644, remove the unreliable badges from the source switcher. Remove these lines:

```tsx
// Remove these:
{s.multiAudio && <span className="player-source-tag multi-audio">Multi Audio</span>}
{s.subLanguages?.length > 0
  ? <span className="player-source-tag has-subs">Subs: {s.subLanguages.join(", ")}</span>
  : s.hasSubs && <span className="player-source-tag has-subs">Subs</span>}
{s.foreignOnly && <span className="player-source-tag foreign">Foreign</span>}
{s.languages?.length > 0 && (
  <span className="player-source-tag languages">{s.languages.join(" ")}</span>
)}
```

Keep: `isCurrent`, `cached`, `seasonPack`, and quality tags.

- [ ] **Step 4: Test manually**

1. Open any movie detail page, click the source picker button
2. Verify torrents are grouped by resolution (4K, 1080p, 720p)
3. Verify max 3 per group
4. Verify the first item in the top group has a highlighted/selected look
5. Verify clicking any row plays the video
6. Verify no language flags, multi-audio, subs, or foreign badges appear
7. Verify tag text (resolution, codec, source type) uses accent color
8. Verify movies don't show "Season Pack" badge

- [ ] **Step 5: Commit**

```bash
git add src/components/SourcePicker.tsx src/components/SourcePicker.css src/pages/Player.tsx
git commit -m "feat: rework source picker — grouped by resolution, top 3 per group"
```

---

### Task 5: Fix track picker popup overflow

**Files:**
- Modify: `shell/main.qml:599-715` (trackPopup)

- [ ] **Step 1: Add max height and Flickable scroll**

Replace the trackPopup Rectangle and its children (`shell/main.qml:599-715`) with:

```qml
// -- Track picker popup --
Rectangle {
    id: trackPopup
    visible: false
    anchors.right: parent.right
    anchors.bottom: bottomBar.top
    anchors.rightMargin: 16
    anchors.bottomMargin: 8
    width: 260
    height: Math.min(trackCol.height + 24, 340)
    radius: 8
    color: "#E0181818"
    clip: true

    MouseArea { anchors.fill: parent }

    Flickable {
        id: trackFlick
        anchors.fill: parent
        anchors.margins: 12
        contentHeight: trackCol.height
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: trackCol
            width: trackFlick.width
            spacing: 4

            Text {
                text: "Subtitles"
                color: "#888"
                font.pixelSize: 11
                font.bold: true
                visible: root.subTracks.length > 0
            }

            Rectangle {
                width: parent.width; height: 28; radius: 4
                color: root.activeSub === 0 ? "#30c9a84c" : "transparent"
                visible: root.subTracks.length > 0
                Text {
                    anchors.left: parent.left; anchors.leftMargin: 8
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Off"
                    color: root.activeSub === 0 ? "#c9a84c" : "#ccc"
                    font.pixelSize: 13
                }
                MouseArea {
                    anchors.fill: parent; cursorShape: Qt.PointingHandCursor
                    onClicked: { bridge.setProperty("sid", 0); root.activeSub = 0; transport.nativeSubChanged(0) }
                }
            }

            Repeater {
                model: root.subTracks
                Rectangle {
                    width: trackCol.width; height: 28; radius: 4
                    color: root.activeSub === modelData.id ? "#30c9a84c" : "transparent"
                    Text {
                        anchors.left: parent.left; anchors.leftMargin: 8
                        anchors.right: parent.right; anchors.rightMargin: 8
                        anchors.verticalCenter: parent.verticalCenter
                        text: modelData.label
                        color: root.activeSub === modelData.id ? "#c9a84c" : "#ccc"
                        font.pixelSize: 13; elide: Text.ElideRight
                    }
                    MouseArea {
                        anchors.fill: parent; cursorShape: Qt.PointingHandCursor
                        onClicked: { bridge.setProperty("sid", modelData.id); root.activeSub = modelData.id; transport.nativeSubChanged(modelData.id) }
                    }
                }
            }

            Text {
                text: "Audio"; color: "#888"; font.pixelSize: 11; font.bold: true
                topPadding: 8; visible: root.audioTracks.length > 1
            }

            Repeater {
                model: root.audioTracks.length > 1 ? root.audioTracks : []
                Rectangle {
                    width: trackCol.width; height: 28; radius: 4
                    color: root.activeAudio === modelData.id ? "#30c9a84c" : "transparent"
                    Text {
                        anchors.left: parent.left; anchors.leftMargin: 8
                        anchors.right: parent.right; anchors.rightMargin: 8
                        anchors.verticalCenter: parent.verticalCenter
                        text: modelData.label
                        color: root.activeAudio === modelData.id ? "#c9a84c" : "#ccc"
                        font.pixelSize: 13; elide: Text.ElideRight
                    }
                    MouseArea {
                        anchors.fill: parent; cursorShape: Qt.PointingHandCursor
                        onClicked: { bridge.setProperty("aid", modelData.id); root.activeAudio = modelData.id; transport.nativeAudioChanged(modelData.id) }
                    }
                }
            }

            Text {
                text: "Size"; color: "#888"; font.pixelSize: 11; font.bold: true
                topPadding: 8; visible: root.subTracks.length > 0
            }
            Row {
                spacing: 8; visible: root.subTracks.length > 0
                Text {
                    text: "A\u2212"; color: "#ccc"; font.pixelSize: 14
                    MouseArea {
                        anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor
                        onClicked: { root.subSize = Math.max(20, root.subSize - 5); bridge.setProperty("sub-font-size", root.subSize); transport.nativeSubSizeChanged(root.subSize) }
                    }
                }
                Text { text: root.subSize.toString(); color: "#888"; font.pixelSize: 12; width: 24; horizontalAlignment: Text.AlignHCenter }
                Text {
                    text: "A+"; color: "#ccc"; font.pixelSize: 14
                    MouseArea {
                        anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor
                        onClicked: { root.subSize = Math.min(100, root.subSize + 5); bridge.setProperty("sub-font-size", root.subSize); transport.nativeSubSizeChanged(root.subSize) }
                    }
                }
            }
        }

        ScrollBar.vertical: ScrollBar {
            policy: trackFlick.contentHeight > trackFlick.height ? ScrollBar.AlwaysOn : ScrollBar.AlwaysOff
        }
    }
}
```

Key changes:
- `height: Math.min(trackCol.height + 24, 340)` — caps at 340px
- `clip: true` on the outer Rectangle
- Content wrapped in `Flickable` with `clip: true` and `boundsBehavior: Flickable.StopAtBounds`
- `ScrollBar.vertical` only shows when content overflows
- `trackCol` now uses `width: trackFlick.width` instead of anchoring left/right to parent

- [ ] **Step 2: Test manually**

1. Play a video with many subtitle tracks (e.g., a remux with 10+ subtitle languages)
2. Open the track picker (CC button)
3. Verify the popup doesn't extend beyond the screen
4. Verify scrollbar appears and works
5. Verify selecting a track still works while scrolling
6. Test with few tracks — verify scrollbar is hidden, popup is compact

- [ ] **Step 3: Commit**

```bash
git add shell/main.qml
git commit -m "fix: cap track picker popup height and add scrollbar for overflow"
```

---

### Task 6: Expand WatchRecord schema for direct play

**Files:**
- Modify: `lib/watch-history.ts:3-17` (WatchRecord interface)
- Modify: `routes/storage.ts:22-53` (handleProgress)
- Modify: `src/lib/api.ts:252-261` (reportWatchProgress)
- Modify: `src/pages/Player.tsx:398-417` (reportProgressRef)
- Modify: `src/pages/Player.tsx:431-441` (beaconProgressRef payload)
- Modify: `shell/main.qml:47-61` (saveProgressAndStop)
- Test: `test/routes/storage.test.ts`, `test/lib/watch-history.test.ts`

- [ ] **Step 1: Add imdbId and year to WatchRecord**

In `lib/watch-history.ts`, add to the interface (after line 16):

```ts
export interface WatchRecord {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  posterPath: string | null;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  seasonEpisodeCount?: number;
  position: number;
  duration: number;
  finished: boolean;
  updatedAt: string;
  dismissed?: boolean;
  imdbId?: string;    // NEW: for Torrentio search
  year?: number;      // NEW: for movie search quality
}
```

- [ ] **Step 2: Accept imdbId and year in handleProgress**

In `routes/storage.ts`, update `handleProgress` (line 22-53):

```ts
function handleProgress(req: Request, res: Response) {
  const { tmdbId, mediaType, title, posterPath, season, episode, episodeTitle, seasonEpisodeCount, position, duration, imdbId, year } = req.body;
  // ... existing validation unchanged ...
  watchHistory.recordProgress({
    tmdbId: Number(tmdbId),
    mediaType,
    title,
    posterPath: posterPath ?? null,
    season: season != null ? Number(season) : undefined,
    episode: episode != null ? Number(episode) : undefined,
    episodeTitle: episodeTitle ?? undefined,
    seasonEpisodeCount: seasonEpisodeCount != null ? Number(seasonEpisodeCount) : undefined,
    position: pos,
    duration: dur,
    finished: false,
    updatedAt: "",
    imdbId: imdbId ?? undefined,
    year: year != null ? Number(year) : undefined,
  });
  res.json({ ok: true });
}
```

- [ ] **Step 3: Send imdbId and year from frontend reportWatchProgress**

In `src/lib/api.ts`, update the `reportWatchProgress` function signature:

```ts
export async function reportWatchProgress(data: {
  tmdbId: number; mediaType: string; title: string; posterPath: string | null;
  season?: number; episode?: number; episodeTitle?: string; seasonEpisodeCount?: number;
  position: number; duration: number;
  imdbId?: string; year?: number;
}): Promise<void> {
  await fetch("/api/watch-history/progress", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
```

- [ ] **Step 4: Pass imdbId and year in Player.tsx progress reporting**

In `src/pages/Player.tsx`, update `reportProgressRef.current` (around line 398-417) — add `imdbId` and `year` to the `reportWatchProgress` call:

```ts
reportWatchProgress({
  tmdbId,
  mediaType: state.type || "movie",
  title: mediaTitle,
  posterPath: state.posterPath ?? null,
  season: state.season != null ? Number(state.season) : undefined,
  episode: state.episode != null ? Number(state.episode) : undefined,
  episodeTitle: state.episodeTitle ?? undefined,
  seasonEpisodeCount: state.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : undefined,
  position: pos,
  duration: dur,
  imdbId: state.imdbId ?? undefined,
  year: state.year != null ? Number(state.year) : undefined,
}).catch(() => {});
```

Update `beaconProgressRef.current` (around line 431-441) similarly — add `imdbId` and `year` to the JSON payload:

```ts
const payload = JSON.stringify({
  tmdbId,
  mediaType: state.type || "movie",
  title: mediaTitle,
  posterPath: state.posterPath ?? null,
  season: state.season != null ? Number(state.season) : undefined,
  episode: state.episode != null ? Number(state.episode) : undefined,
  episodeTitle: state.episodeTitle ?? undefined,
  seasonEpisodeCount: state.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : undefined,
  position: pos,
  duration: Math.floor(time.duration),
  imdbId: state.imdbId ?? undefined,
  year: state.year != null ? Number(state.year) : undefined,
});
```

- [ ] **Step 5: Update QML saveProgressAndStop**

In `shell/main.qml`, update the `saveProgressAndStop()` function (lines 49-61) to pass through the extra fields. The QML function reads `window.__rattinWatchState` which is set by Player.tsx — the extra fields will already be in that object since Player.tsx sets it from `state`. But verify: check the `useEffect` at Player.tsx line 465-486 that sets `window.__rattinWatchState`.

Update that useEffect to include `imdbId` and `year`:

```ts
(window as any).__rattinWatchState = {
  tmdbId,
  mediaType: state.type || "movie",
  title: mediaTitle,
  posterPath: state.posterPath ?? null,
  season: state.season != null ? Number(state.season) : undefined,
  episode: state.episode != null ? Number(state.episode) : undefined,
  episodeTitle: state.episodeTitle ?? undefined,
  seasonEpisodeCount: state.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : undefined,
  position: 0,
  duration: 0,
  imdbId: state.imdbId ?? undefined,
  year: state.year != null ? Number(state.year) : undefined,
};
```

The QML `saveProgressAndStop` sends the full object via `JSON.stringify(s)`, so no QML changes needed.

- [ ] **Step 6: Run existing tests**

Run: `npx tsx --test test/routes/storage.test.ts test/lib/watch-history.test.ts`

Expected: PASS — new fields are optional, so existing tests should not break.

- [ ] **Step 7: Commit**

```bash
git add lib/watch-history.ts routes/storage.ts src/lib/api.ts src/pages/Player.tsx
git commit -m "feat: store imdbId and year in watch history for direct play"
```

---

### Task 7: Continue Watching direct play

**Files:**
- Modify: `src/components/WatchHistoryRow.tsx`
- Modify: `src/components/WatchHistoryRow.css` (add loading state)
- Modify: `src/pages/Home.tsx`

- [ ] **Step 1: Add onPlay prop to WatchHistoryRow**

In `src/components/WatchHistoryRow.tsx`, update the interface and component:

```tsx
interface WatchHistoryRowProps {
  title: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchFn: () => Promise<{ items: any[] }>;
  showProgress?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onRemove?: (item: any) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onPlay?: (item: any) => Promise<void>;
}
```

Update the component signature:

```tsx
export default function WatchHistoryRow({ title, fetchFn, showProgress = false, onRemove, onPlay }: WatchHistoryRowProps) {
```

Add loading state:

```tsx
const [playingId, setPlayingId] = useState<string | null>(null);
```

Update the card's `onClick` handler (currently at line 62):

```tsx
onClick={async () => {
  if (onPlay) {
    const id = `${type}:${item.tmdbId}:${item.season ?? ""}:${item.episode ?? ""}`;
    setPlayingId(id);
    try {
      await onPlay(item);
    } catch {
      // Fallback to detail page on failure
      navigate(`/${type}/${item.tmdbId}`);
    } finally {
      setPlayingId(null);
    }
  } else {
    navigate(`/${type}/${item.tmdbId}`);
  }
}}
```

Add loading class to the card:

```tsx
className={`movie-card wh-card${playingId === `${type}:${item.tmdbId}:${item.season ?? ""}:${item.episode ?? ""}` ? " loading" : ""}`}
```

- [ ] **Step 2: Add loading CSS**

Add to `src/components/WatchHistoryRow.css`:

```css
.wh-card.loading .movie-card-poster {
  opacity: 0.5;
}

.wh-card.loading .movie-card-poster::after {
  content: "";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  border-radius: inherit;
}
```

- [ ] **Step 3: Wire up onPlay in Home.tsx**

In `src/pages/Home.tsx`, add the import and handler. Add to imports:

```tsx
import { autoPlay } from "../lib/api";
```

Add handler function inside the Home component:

```tsx
const handleContinuePlay = useCallback(async (item: any) => {
  const result = await autoPlay(
    item.title,
    item.year,
    item.mediaType,
    item.season,
    item.episode,
    item.imdbId,
  );
  const navState: any = {
    tags: result.tags,
    title: item.mediaType === "tv" && item.season != null
      ? `${item.title} S${item.season}E${item.episode}${item.episodeTitle ? ` — ${item.episodeTitle}` : ""}`
      : item.title,
    tmdbId: item.tmdbId,
    year: item.year,
    type: item.mediaType,
    imdbId: item.imdbId,
    posterPath: item.posterPath,
    season: item.season,
    episode: item.episode,
    episodeTitle: item.episodeTitle,
    seasonEpisodeCount: item.seasonEpisodeCount,
    resumePosition: item.position > 0 ? item.position : undefined,
  };
  if (result.debridStreamKey) navState.debridStreamKey = result.debridStreamKey;
  navigate(`/play/${result.infoHash}/${result.fileIndex}`, { state: navState });
}, [navigate]);
```

Pass it to the Continue Watching row:

```tsx
<WatchHistoryRow
  title="Continue Watching"
  fetchFn={fetchContinueWatching}
  showProgress
  onPlay={handleContinuePlay}
  onRemove={(item) => dismissWatchHistory({ tmdbId: item.tmdbId, mediaType: item.mediaType, season: item.season, episode: item.episode })}
/>
```

- [ ] **Step 4: Test manually**

1. Watch a video for a few minutes, then go back to Home
2. Click the poster in Continue Watching
3. Verify: loading state shows on card, then navigates directly to Player
4. Verify: video resumes at the saved position
5. If autoPlay fails (e.g., network error), verify it falls back to Detail page

- [ ] **Step 5: Commit**

```bash
git add src/components/WatchHistoryRow.tsx src/components/WatchHistoryRow.css src/pages/Home.tsx
git commit -m "feat: direct play from Continue Watching — skip detail page"
```

---

### Task 8: Fix English audio/subtitle auto-detection

**Files:**
- Modify: `src/lib/useAudioTracks.ts:64-73`
- Modify: `src/lib/useSubtitles.ts:4-12, 80-82`

- [ ] **Step 1: Fix isEnglish in useSubtitles.ts**

In `src/lib/useSubtitles.ts`, replace the `isEnglish` function (line 80-83):

```ts
// Before:
function isEnglish(lang: string): boolean {
  const l = lang.toLowerCase();
  return l === "eng" || l === "en" || l === "english";
}

// After:
function isEnglish(lang: string): boolean {
  const base = lang.toLowerCase().split(/[-_]/)[0];
  return base === "eng" || base === "en" || base === "english";
}
```

- [ ] **Step 2: Fix LANG_MAP lookup to strip region**

In `src/lib/useSubtitles.ts`, the `LANG_MAP` is used for display labels. Find all places that do `LANG_MAP[t.lang]` or similar and update to strip region first. The main usage is in `useAudioTracks.ts:61`:

```ts
// Before:
label: (t.title || LANG_MAP[t.lang] || t.lang || `Track ${t.streamIndex}`) + ...

// After:
label: (t.title || LANG_MAP[(t.lang || "").split(/[-_]/)[0]] || t.lang || `Track ${t.streamIndex}`) + ...
```

- [ ] **Step 3: Fix English detection in useAudioTracks.ts**

In `src/lib/useAudioTracks.ts`, replace the English track detection (lines 67-70):

```ts
// Before:
const englishTrack = data.tracks.length > 1 ? data.tracks.find((t: any) => {
  const lang = (t.lang || "").toLowerCase();
  return lang === "eng" || lang === "en" || lang === "english";
}) : null;

// After:
const englishTrack = data.tracks.length > 1 ? data.tracks.find((t: any) => {
  const base = (t.lang || "").toLowerCase().split(/[-_]/)[0];
  return base === "eng" || base === "en" || base === "english";
}) : null;
```

- [ ] **Step 4: Test manually**

1. Play Avatar (or any content with multiple audio tracks including region-tagged ones like "fr-CA")
2. Verify English audio track is auto-selected (not French)
3. Open the track selector — verify language labels display correctly
4. Verify English subtitles are auto-selected when available
5. Test with content that has "en-US" or "en-GB" tagged tracks

- [ ] **Step 5: Commit**

```bash
git add src/lib/useSubtitles.ts src/lib/useAudioTracks.ts
git commit -m "fix: detect English audio/subs with region tags (en-US, fr-CA, etc.)"
```
