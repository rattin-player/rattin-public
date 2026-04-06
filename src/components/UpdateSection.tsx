import { useState, useEffect } from "react";
import { checkForUpdate, type UpdateInfo } from "../lib/api";
import "./UpdateSection.css";

// Shared promise so Navbar and UpdateSection don't fire duplicate requests
let sharedPromise: Promise<UpdateInfo> | null = null;
function getUpdateInfo(): Promise<UpdateInfo> {
  if (!sharedPromise) {
    sharedPromise = checkForUpdate().catch(() => ({
      available: false,
      current: "unknown",
      latest: "unknown",
      releases: [],
    }));
  }
  return sharedPromise;
}

export default function UpdateSection() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    getUpdateInfo().then(setInfo);
  }, []);

  if (!info) {
    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <h4>Updates</h4>
        </div>
        <div className="update-checking">Checking for updates...</div>
      </div>
    );
  }

  if (!info.available) {
    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <h4>Updates</h4>
          <span className="settings-badge settings-badge-green">Up to date</span>
        </div>
        <p className="pair-desc">
          You're running v{info.current} — the latest version.
        </p>
      </div>
    );
  }

  const platform = detectPlatform();
  const latestRelease = info.releases[0];
  const downloadAsset = latestRelease?.assets.find((a) => {
    if (platform === "linux") return a.name.endsWith(".AppImage");
    if (platform === "windows") return a.name.endsWith("-Setup.exe");
    return false;
  });

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h4>Updates</h4>
        <span className="update-version-badge">v{info.latest}</span>
      </div>

      <p className="pair-desc">
        You're on <strong>v{info.current}</strong>. Version <strong>v{info.latest}</strong> is available.
      </p>

      {downloadAsset && (
        <a
          href={downloadAsset.url}
          target="_blank"
          rel="noopener noreferrer"
          className="update-download-btn"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
          </svg>
          Download v{info.latest}
          <span className="update-download-size">{formatSize(downloadAsset.size)}</span>
        </a>
      )}

      {!downloadAsset && latestRelease && (
        <a
          href={latestRelease.url}
          target="_blank"
          rel="noopener noreferrer"
          className="update-download-btn"
        >
          View release on GitHub
        </a>
      )}

      <div className="update-changelog">
        <button
          className="update-changelog-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="currentColor"
            className={`update-chevron ${expanded ? "expanded" : ""}`}
          >
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
          </svg>
          What's new
          {info.releases.length > 1 && (
            <span className="update-release-count">{info.releases.length} releases</span>
          )}
        </button>

        {expanded && (
          <div className="update-changelog-body">
            {info.releases.map((release) => (
              <div key={release.version} className="update-release">
                <div className="update-release-header">
                  <span className="update-release-version">v{release.version}</span>
                  <span className="update-release-date">
                    {new Date(release.date).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </div>
                <div className="update-release-body">
                  {renderMarkdown(release.body)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function detectPlatform(): "linux" | "windows" | "unknown" {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("linux")) return "linux";
  if (ua.includes("win")) return "windows";
  return "unknown";
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Minimal markdown → JSX: handles headers, bold, lists, and links. */
function renderMarkdown(md: string) {
  if (!md.trim()) return <p className="update-release-empty">No release notes.</p>;

  const lines = md.split("\n");
  const elements: JSX.Element[] = [];
  let listItems: string[] = [];
  let key = 0;

  function flushList() {
    if (listItems.length === 0) return;
    elements.push(
      <ul key={key++}>
        {listItems.map((item, i) => (
          <li key={i}>{inlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      continue;
    }

    // Header
    const headerMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      flushList();
      const level = headerMatch[1].length;
      const Tag = `h${Math.min(level + 3, 6)}` as keyof JSX.IntrinsicElements;
      elements.push(<Tag key={key++} className="update-md-heading">{inlineMarkdown(headerMatch[2])}</Tag>);
      continue;
    }

    // List item
    const listMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (listMatch) {
      listItems.push(listMatch[1]);
      continue;
    }

    // Plain paragraph
    flushList();
    elements.push(<p key={key++}>{inlineMarkdown(trimmed)}</p>);
  }

  flushList();
  return <>{elements}</>;
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url, "https://placeholder.invalid");
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function inlineMarkdown(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  // Match **bold**, [links](url), and `code`
  const regex = /\*\*(.+?)\*\*|\[(.+?)\]\((.+?)\)|`(.+?)`/g;
  let last = 0;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[1]) parts.push(<strong key={key++}>{match[1]}</strong>);
    else if (match[2] && match[3] && isSafeUrl(match[3])) {
      parts.push(
        <a key={key++} href={match[3]} target="_blank" rel="noopener noreferrer" className="settings-link">
          {match[2]}
        </a>,
      );
    } else if (match[2] && match[3]) {
      // Unsafe URL scheme — render as plain text
      parts.push(<span key={key++}>{match[2]}</span>);
    } else if (match[4]) parts.push(<code key={key++} className="update-md-code">{match[4]}</code>);
    last = match.index + match[0].length;
  }

  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Hook for other components (e.g. Navbar) to know if an update is available */
export function useUpdateAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    getUpdateInfo().then((info) => setAvailable(info.available));
  }, []);
  return available;
}
