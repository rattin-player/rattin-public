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
                  return (
                    <button
                      key={`${s.infoHash}:${s.fileIdx ?? ""}`}
                      className="picker-item"
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
