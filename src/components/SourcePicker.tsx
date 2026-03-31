import { useState, useMemo } from "react";
import { formatBytes } from "../lib/utils";
import "./SourcePicker.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stream = any;

const RES_ORDER = ["4K", "1080p", "720p", "480p", "Other"] as const;

function getResGroup(tags: string[]): string {
  if (tags.includes("4K")) return "4K";
  if (tags.includes("1080p")) return "1080p";
  if (tags.includes("720p")) return "720p";
  if (tags.includes("480p")) return "480p";
  return "Other";
}

interface SourcePickerProps {
  streams: Stream[] | null;
  onPick: (stream: Stream) => void;
  onClose: () => void;
}

export default function SourcePicker({ streams, onPick, onClose }: SourcePickerProps) {
  // Group streams by resolution
  const groups = useMemo(() => {
    if (!streams || streams.length === 0) return [];
    const map = new Map<string, Stream[]>();
    for (const s of streams) {
      const group = getResGroup(s.tags || []);
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(s);
    }
    return RES_ORDER.filter((r) => map.has(r)).map((r) => ({
      label: r,
      streams: map.get(r)!,
    }));
  }, [streams]);

  // First non-empty group starts expanded
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    let first = true;
    for (const g of groups) {
      init[g.label] = !first;
      first = false;
    }
    return init;
  });

  const toggle = (label: string) =>
    setCollapsed((prev) => ({ ...prev, [label]: !prev[label] }));

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="picker-header">
          <h3>Select Source</h3>
          {streams && streams.length > 0 && (
            <span className="picker-count">{streams.length} sources</span>
          )}
          <button className="picker-close" onClick={onClose}>&#10005;</button>
        </div>

        <div className="picker-list">
          {streams === null ? (
            <div className="picker-loading">Searching providers...</div>
          ) : streams.length === 0 ? (
            <div className="picker-empty">No streams found</div>
          ) : (
            groups.map((g) => (
              <div key={g.label} className="picker-group">
                <button
                  className={`picker-group-header${collapsed[g.label] ? " collapsed" : ""}`}
                  onClick={() => toggle(g.label)}
                >
                  <span className="picker-group-label">{g.label}</span>
                  <span className="picker-group-count">{g.streams.length}</span>
                  <svg className="picker-group-chevron" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
                  </svg>
                </button>
                {!collapsed[g.label] && (
                  <div className="picker-group-items">
                    {g.streams.map((s: Stream) => (
                      <button
                        key={s.infoHash}
                        className="picker-item"
                        onClick={() => onPick(s)}
                      >
                        <div className="picker-item-row">
                          <div className="picker-item-main">
                            <span className="picker-item-name">{s.name}</span>
                            <div className="picker-item-tags">
                              {s.seasonPack && <span className="picker-tag season-pack">Season Pack</span>}
                              {s.tags.filter((t: string) => !["4K", "1080p", "720p", "480p"].includes(t)).map((t: string) => (
                                <span key={t} className={`picker-tag${t === "Native" ? " native" : ""}`}>{t === "Native" ? "Full Seek" : t}</span>
                              ))}
                              {s.multiAudio && <span className="picker-tag multi-audio">Multi Audio</span>}
                              {s.hasSubs && <span className="picker-tag has-subs">Subs</span>}
                              {s.foreignOnly && <span className="picker-tag foreign">Foreign</span>}
                              {s.languages?.length > 0 && (
                                <span className="picker-tag languages">{s.languages.join(" ")}</span>
                              )}
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
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
