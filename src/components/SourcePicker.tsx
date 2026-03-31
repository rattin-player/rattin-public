import { useState, useMemo } from "react";
import { formatBytes } from "../lib/utils";
import "./SourcePicker.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stream = any;

const RES_OPTIONS = ["4K", "1080p", "720p", "480p"] as const;

function getRes(tags: string[]): string | null {
  for (const r of RES_OPTIONS) if (tags.includes(r)) return r;
  return null;
}

// Map flag emoji to short label for filter chips
const FLAG_LABELS: Record<string, string> = {
  "🇬🇧": "EN", "🇺🇸": "EN", "🇦🇺": "EN", "🇨🇦": "EN",
  "🇮🇹": "IT", "🇫🇷": "FR", "🇪🇸": "ES", "🇩🇪": "DE",
  "🇵🇹": "PT", "🇷🇺": "RU", "🇯🇵": "JA", "🇰🇷": "KO",
  "🇨🇳": "ZH", "🇸🇦": "AR", "🇮🇳": "HI", "🇳🇱": "NL",
  "🇵🇱": "PL", "🇹🇷": "TR", "🇸🇪": "SV", "🇳🇴": "NO",
  "🇩🇰": "DA", "🇫🇮": "FI", "🇬🇷": "EL", "🇮🇱": "HE",
  "🇨🇿": "CZ", "🇷🇴": "RO", "🇭🇺": "HU", "🇺🇦": "UA",
  "🇲🇽": "ES",
};

interface SourcePickerProps {
  streams: Stream[] | null;
  onPick: (stream: Stream) => void;
  onClose: () => void;
}

export default function SourcePicker({ streams, onPick, onClose }: SourcePickerProps) {
  const [resFilter, setResFilter] = useState<Set<string>>(new Set());
  const [langFilter, setLangFilter] = useState<Set<string>>(new Set());
  const [featureFilter, setFeatureFilter] = useState<Set<string>>(new Set());

  // Discover available filter values from streams
  const available = useMemo(() => {
    if (!streams || streams.length === 0) return { resolutions: [], languages: [], features: [] };

    const resCounts = new Map<string, number>();
    const langSet = new Map<string, string>(); // label -> flag
    let hasFullSeek = false;
    let hasSubs = false;
    let hasMultiAudio = false;

    for (const s of streams) {
      const res = getRes(s.tags || []);
      if (res) resCounts.set(res, (resCounts.get(res) || 0) + 1);
      for (const flag of (s.languages || [])) {
        const label = FLAG_LABELS[flag] || flag;
        if (!langSet.has(label)) langSet.set(label, flag);
      }
      if (s.tags?.includes("Native")) hasFullSeek = true;
      if (s.hasSubs) hasSubs = true;
      if (s.multiAudio) hasMultiAudio = true;
    }

    const resolutions = RES_OPTIONS
      .filter((r) => resCounts.has(r))
      .map((r) => ({ label: r, count: resCounts.get(r)! }));

    // Dedupe languages, sort EN first then alphabetical
    const languages = [...langSet.entries()]
      .sort((a, b) => {
        if (a[0] === "EN") return -1;
        if (b[0] === "EN") return 1;
        return a[0].localeCompare(b[0]);
      })
      .map(([label, flag]) => ({ label, flag }));

    const features: { label: string; key: string }[] = [];
    if (hasFullSeek) features.push({ label: "Full Seek", key: "fullseek" });
    if (hasSubs) features.push({ label: "Subs", key: "subs" });
    if (hasMultiAudio) features.push({ label: "Multi Audio", key: "multiaudio" });

    return { resolutions, languages, features };
  }, [streams]);

  // Filter streams: OR within category, AND across categories
  const filtered = useMemo(() => {
    if (!streams) return null;
    if (streams.length === 0) return [];

    return streams.filter((s: Stream) => {
      // Resolution: OR — match any selected, or all if none selected
      if (resFilter.size > 0) {
        const res = getRes(s.tags || []);
        if (!res || !resFilter.has(res)) return false;
      }

      // Language: OR — match any selected flag
      // Torrents with no language info are treated as English
      if (langFilter.size > 0) {
        const streamLangs = (s.languages || []).map((f: string) => FLAG_LABELS[f] || f);
        const noLang = streamLangs.length === 0;
        const matchesEN = noLang && langFilter.has("EN");
        if (!matchesEN && !streamLangs.some((l: string) => langFilter.has(l))) return false;
      }

      // Features: AND — must have ALL selected features
      if (featureFilter.size > 0) {
        if (featureFilter.has("fullseek") && !s.tags?.includes("Native")) return false;
        if (featureFilter.has("subs") && !s.hasSubs) return false;
        if (featureFilter.has("multiaudio") && !s.multiAudio) return false;
      }

      return true;
    });
  }, [streams, resFilter, langFilter, featureFilter]);

  const toggleFilter = (set: Set<string>, setFn: React.Dispatch<React.SetStateAction<Set<string>>>, val: string) => {
    setFn((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  };

  const hasAnyFilter = resFilter.size > 0 || langFilter.size > 0 || featureFilter.size > 0;

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="picker-header">
          <h3>Select Source</h3>
          {filtered && (
            <span className="picker-count">
              {hasAnyFilter ? `${filtered.length} of ${streams!.length}` : `${streams!.length} sources`}
            </span>
          )}
          <button className="picker-close" onClick={onClose}>&#10005;</button>
        </div>

        {streams && streams.length > 0 && (
          <div className="picker-filters">
            {available.resolutions.length > 0 && (
              <div className="picker-filter-row">
                <span className="picker-filter-label">Quality</span>
                <div className="picker-chips">
                  {available.resolutions.map((r) => (
                    <button
                      key={r.label}
                      className={`picker-chip${resFilter.has(r.label) ? " active" : ""}`}
                      onClick={() => toggleFilter(resFilter, setResFilter, r.label)}
                    >
                      {r.label}
                      <span className="picker-chip-count">{r.count}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {available.languages.length > 0 && (
              <div className="picker-filter-row">
                <span className="picker-filter-label">Lang</span>
                <div className="picker-chips">
                  {available.languages.map((l) => (
                    <button
                      key={l.label}
                      className={`picker-chip${langFilter.has(l.label) ? " active" : ""}`}
                      onClick={() => toggleFilter(langFilter, setLangFilter, l.label)}
                    >
                      {l.flag} {l.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {available.features.length > 0 && (
              <div className="picker-filter-row">
                <span className="picker-filter-label">Features</span>
                <div className="picker-chips">
                  {available.features.map((f) => (
                    <button
                      key={f.key}
                      className={`picker-chip${featureFilter.has(f.key) ? " active" : ""}`}
                      onClick={() => toggleFilter(featureFilter, setFeatureFilter, f.key)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {hasAnyFilter && (
              <button
                className="picker-clear-filters"
                onClick={() => { setResFilter(new Set()); setLangFilter(new Set()); setFeatureFilter(new Set()); }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        <div className="picker-list">
          {filtered === null ? (
            <div className="picker-loading">Searching providers...</div>
          ) : filtered.length === 0 ? (
            <div className="picker-empty">{hasAnyFilter ? "No sources match filters" : "No streams found"}</div>
          ) : (
            filtered.map((s: Stream) => (
              <button
                key={s.infoHash}
                className="picker-item"
                onClick={() => onPick(s)}
              >
                <div className="picker-item-row">
                  <div className="picker-item-main">
                    <span className="picker-item-name">{s.name}</span>
                    <div className="picker-item-tags">
                      {s.cached && <span className="picker-tag cached">Cached</span>}
                      {s.seasonPack && <span className="picker-tag season-pack">Season Pack</span>}
                      {s.tags.map((t: string) => (
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
            ))
          )}
        </div>
      </div>
    </div>
  );
}
