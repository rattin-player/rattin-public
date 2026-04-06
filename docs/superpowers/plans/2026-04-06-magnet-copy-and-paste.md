# Magnet Copy & Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Copy Magnet" button to each SourcePicker row and let users paste a magnet link into the search bar to play it directly.

**Architecture:** Extract magnet URI parsing into a pure utility (`src/lib/magnet.ts`) so it's testable in isolation. SourcePicker's outer `<button>` becomes a `<div role="button">` so a real `<button>` for copy can be nested inside. Navbar detects a magnet paste on submit, calls `playTorrent`, and navigates straight to the player with no TMDB context.

**Tech Stack:** React 18, TypeScript, Node's built-in `node:test` runner for the unit test.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/magnet.ts` | **Create** | Pure `parseMagnet()` utility — no side-effects |
| `test/magnet.test.ts` | **Create** | Unit tests for `parseMagnet` |
| `src/components/SourcePicker.tsx` | **Modify** | Outer div, per-row copied state, copy button |
| `src/components/SourcePicker.css` | **Modify** | `.picker-copy-magnet` styles |
| `src/components/Navbar.tsx` | **Modify** | Magnet detection on submit, loading state |

---

## Task 1: `parseMagnet` utility + unit tests

**Files:**
- Create: `src/lib/magnet.ts`
- Create: `test/magnet.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/magnet.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMagnet } from "../src/lib/magnet.js";

describe("parseMagnet", () => {
  it("returns null for a plain search query", () => {
    assert.equal(parseMagnet("breaking bad"), null);
  });

  it("returns null for an empty string", () => {
    assert.equal(parseMagnet(""), null);
  });

  it("returns null for a magnet missing xt param", () => {
    assert.equal(parseMagnet("magnet:?dn=Something"), null);
  });

  it("parses a minimal magnet with only infoHash", () => {
    const result = parseMagnet("magnet:?xt=urn:btih:abc123def456abc123def456abc123def456abc1");
    assert.deepEqual(result, {
      infoHash: "abc123def456abc123def456abc123def456abc1",
      name: "abc123def456abc123def456abc123def456abc1",
    });
  });

  it("parses a magnet with dn and lowercases the hash", () => {
    const result = parseMagnet(
      "magnet:?xt=urn:btih:ABC123DEF456ABC123DEF456ABC123DEF456ABC1&dn=Breaking%20Bad%20S01"
    );
    assert.deepEqual(result, {
      infoHash: "abc123def456abc123def456abc123def456abc1",
      name: "Breaking Bad S01",
    });
  });

  it("parses a full magnet with trackers and extra params", () => {
    const result = parseMagnet(
      "magnet:?xt=urn:btih:aabbccddeeff0011223344556677889900aabbcc&dn=Some+Movie+2024&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&xl=1234567890"
    );
    assert.deepEqual(result, {
      infoHash: "aabbccddeeff0011223344556677889900aabbcc",
      name: "Some Movie 2024",
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
node --import tsx/esm --test test/magnet.test.ts
```

Expected: all tests fail with `Cannot find module '../src/lib/magnet.js'` or similar.

- [ ] **Step 3: Implement `parseMagnet`**

Create `src/lib/magnet.ts`:

```ts
export interface ParsedMagnet {
  infoHash: string;
  name: string;
}

/**
 * Parse a magnet URI into its infoHash and display name.
 * Returns null if the input is not a valid magnet with a btih hash.
 */
export function parseMagnet(uri: string): ParsedMagnet | null {
  if (!uri.startsWith("magnet:?")) return null;

  // URLSearchParams can't parse magnet: scheme directly — strip the scheme part
  const params = new URLSearchParams(uri.slice("magnet:?".length));

  const xt = params.get("xt");
  if (!xt || !xt.startsWith("urn:btih:")) return null;

  const infoHash = xt.slice("urn:btih:".length).toLowerCase();
  if (!infoHash) return null;

  const dn = params.get("dn");
  const name = dn ? decodeURIComponent(dn.replace(/\+/g, " ")) : infoHash;

  return { infoHash, name };
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
node --import tsx/esm --test test/magnet.test.ts
```

Expected output: all 5 tests pass, no failures.

- [ ] **Step 5: Commit**

```bash
git add src/lib/magnet.ts test/magnet.test.ts
git commit -m "feat: add parseMagnet utility with unit tests"
```

---

## Task 2: Copy Magnet button in SourcePicker

**Files:**
- Modify: `src/components/SourcePicker.tsx`
- Modify: `src/components/SourcePicker.css`

- [ ] **Step 1: Restructure picker-item and add copy button in SourcePicker.tsx**

Replace the entire `SourcePicker.tsx` with the following (the only structural changes are: outer `<button>` → `<div role="button">`, `useState` for `copiedId`, and the copy button at the end of `.picker-item-meta`):

```tsx
import { useMemo, useState, useCallback } from "react";
import { formatBytes } from "../lib/utils";
import { parseMagnet } from "../lib/magnet";
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
  const [copiedId, setCopiedId] = useState<string | null>(null);

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

    const ordered: ResGroup[] = [];
    for (const r of RES_ORDER) {
      const list = byRes.get(r);
      if (list) ordered.push({ resolution: r, streams: list.slice(0, 3) });
    }
    const other = byRes.get("Other");
    if (other) ordered.push({ resolution: "Other", streams: other.slice(0, 3) });

    return ordered;
  }, [streams]);

  const handleCopy = useCallback((e: React.MouseEvent, s: Stream) => {
    e.stopPropagation();
    const magnet = `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(s.name)}`;
    navigator.clipboard.writeText(magnet).then(() => {
      const id = `${s.infoHash}:${s.fileIdx ?? ""}`;
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    }).catch(() => {});
  }, []);

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
                {group.streams.map((s: Stream) => {
                  const rowId = `${s.infoHash}:${s.fileIdx ?? ""}`;
                  const copied = copiedId === rowId;
                  return (
                    <div
                      key={rowId}
                      className="picker-item"
                      role="button"
                      tabIndex={0}
                      onClick={() => onPick(s)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(s); } }}
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
                          <button
                            className={`picker-copy-magnet${copied ? " copied" : ""}`}
                            onClick={(e) => handleCopy(e, s)}
                            title="Copy magnet link"
                          >
                            {copied ? "Copied!" : "Copy magnet"}
                          </button>
                        </div>
                      </div>
                    </div>
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

Note: the `parseMagnet` import is not used in the component itself (magnet is built inline for copy), but the import validates the module resolves. You can remove it if a linter complains — it's not needed here.

Actually, remove the `parseMagnet` import from SourcePicker.tsx — it's not used there. The final import block should be:

```tsx
import { useMemo, useState, useCallback } from "react";
import { formatBytes } from "../lib/utils";
import "./SourcePicker.css";
```

- [ ] **Step 2: Add `.picker-copy-magnet` styles to SourcePicker.css**

Append to the end of `src/components/SourcePicker.css` (before the closing mobile media query, or after it — either works, but after is simpler):

```css
.picker-copy-magnet {
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.3px;
  padding: 3px 8px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-muted);
  transition: background var(--transition), color var(--transition);
  white-space: nowrap;
  flex-shrink: 0;
}

.picker-copy-magnet:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-secondary);
}

.picker-copy-magnet.copied {
  background: rgba(74, 222, 128, 0.15);
  color: var(--green);
}
```

- [ ] **Step 3: Manual verification**

Open the app, search for any movie, open the source picker. For each row:
- Clicking the row body still picks that source and starts playback (no regression).
- Clicking "Copy magnet" does NOT pick the source.
- After clicking "Copy magnet", the button label changes to "Copied!" for ~1.5 s.
- Paste the clipboard contents somewhere — it should be a valid `magnet:?xt=urn:btih:...` URI.

- [ ] **Step 4: Commit**

```bash
git add src/components/SourcePicker.tsx src/components/SourcePicker.css
git commit -m "feat: add copy magnet button to source picker rows"
```

---

## Task 3: Magnet paste detection in Navbar

**Files:**
- Modify: `src/components/Navbar.tsx`

- [ ] **Step 1: Add magnet handling to Navbar.tsx**

The only changes are: import `parseMagnet` and `playTorrent`, add a `loading` state, and branch `handleSubmit`. The rest of the file is unchanged.

Replace `handleSubmit` and the relevant imports/state in `Navbar.tsx`:

At the top of the file, add to the existing imports:

```ts
import { parseMagnet } from "../lib/magnet";
import { getVpnStatus, toggleVpn, playTorrent } from "../lib/api";
```

(Replace the existing `import { getVpnStatus, toggleVpn } from "../lib/api";` line.)

Add `loading` state next to the other `useState` declarations:

```ts
const [loading, setLoading] = useState(false);
```

Replace the existing `handleSubmit` function:

```ts
async function handleSubmit(e: React.FormEvent) {
  e.preventDefault();
  const trimmed = query.trim();
  if (!trimmed) return;

  const magnet = parseMagnet(trimmed);
  if (magnet) {
    setLoading(true);
    try {
      const result = await playTorrent(magnet.infoHash, magnet.name);
      navigate(`/play/${result.infoHash}/${result.fileIndex}`, {
        state: {
          title: magnet.name,
          posterPath: null,
          sources: [],
          tags: result.tags ?? [],
        },
      });
    } catch {
      // silently ignore — magnet play is best-effort
    } finally {
      setLoading(false);
    }
    return;
  }

  navigate(`/search?q=${encodeURIComponent(trimmed)}`);
}
```

Disable the search input while loading by updating the `<input>` element:

```tsx
<input
  type="text"
  placeholder="Search movies & shows..."
  value={query}
  onChange={(e) => setQuery(e.target.value)}
  disabled={loading}
/>
```

- [ ] **Step 2: Manual verification — normal search not broken**

Type a normal search term (e.g., "inception") and press Enter. The app should navigate to `/search?q=inception` as before. No loading state should appear.

- [ ] **Step 3: Manual verification — magnet paste**

Paste a magnet URI into the search bar (e.g., one copied from the source picker in Task 2) and press Enter:
- Input disables briefly while `playTorrent` resolves.
- App navigates to `/play/:infoHash/:fileIndex`.
- QML loading overlay appears with the title from the magnet's `dn` param (or the hash if none).
- Video starts streaming.
- Source switcher button does NOT appear (sources is empty).
- No poster image in the loading overlay — just the title — which is fine.

- [ ] **Step 4: Commit**

```bash
git add src/components/Navbar.tsx
git commit -m "feat: play magnet links pasted into the search bar"
```

---

## Self-Review

**Spec coverage:**
- Copy magnet button in source picker, right of size ✓ (Task 2)
- Search bar handles pasted magnet ✓ (Task 3)
- No source switching when launched from magnet ✓ (`sources: []` → `sources.length > 1` false → button hidden)
- Missing poster handled ✓ (existing guard in Player.tsx, no changes needed)
- No regressions to normal search ✓ (branch is strict prefix check via `parseMagnet`)

**Placeholder scan:** No TBDs, no "implement later", no vague steps. All code is complete.

**Type consistency:**
- `parseMagnet` returns `{ infoHash: string; name: string } | null` — used as `magnet.infoHash` and `magnet.name` in Navbar ✓
- `playTorrent` returns `{ infoHash, fileIndex, tags, ... }` — accessed as `result.infoHash`, `result.fileIndex`, `result.tags` ✓ (matches existing usage in Detail.tsx)
- `copiedId` is `string | null`, keyed by `${s.infoHash}:${s.fileIdx ?? ""}` — same key used in both `setCopiedId` and the `copied` check ✓
