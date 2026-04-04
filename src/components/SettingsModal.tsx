import { useState, useEffect } from "react";
import { getDebridStatus, verifyDebridKey, setDebridConfig, deleteDebridConfig, setDebridMode, getCacheSize, clearCache, clearWatchHistory, clearSavedList, getWatchHistoryCount, getSavedListCount } from "../lib/api";
import "./SettingsModal.css";

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<"realdebrid" | "torbox">("realdebrid");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [status, setStatus] = useState<{
    configured: boolean;
    valid?: boolean;
    premium?: boolean;
    username?: string | null;
    expiration?: string | null;
    mode?: "on" | "off";
    provider?: string | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [cacheSize, setCacheSize] = useState<{ bytes: number; formatted: string } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [clearingSaved, setClearingSaved] = useState(false);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);

  useEffect(() => {
    loadStatus();
    loadCacheSize();
    loadDataCounts();
  }, []);

  async function loadStatus() {
    try {
      const s = await getDebridStatus();
      setStatus(s);
      if (s.provider) setProvider(s.provider as "realdebrid" | "torbox");
      if (s.configured) {
        setVerifying(true);
        const v = await verifyDebridKey();
        setStatus({ ...s, ...v });
        setVerifying(false);
      }
    } catch {
      setStatus({ configured: false });
    }
  }

  async function loadCacheSize() {
    try {
      setCacheSize(await getCacheSize());
    } catch {
      setCacheSize({ bytes: 0, formatted: "0 B" });
    }
  }

  async function loadDataCounts() {
    try {
      const [h, s] = await Promise.all([getWatchHistoryCount(), getSavedListCount()]);
      setHistoryCount(h.count);
      setSavedCount(s.count);
    } catch {}
  }

  async function handleClearCache() {
    setClearing(true);
    try {
      await clearCache();
      await loadCacheSize();
    } catch {}
    setClearing(false);
  }

  async function handleSave() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await setDebridConfig(apiKey.trim(), provider);
      const v = await verifyDebridKey();
      if (!v.valid) {
        setError("Invalid API key");
        setStatus({ configured: true, valid: false });
      } else if (!v.premium) {
        setError("Account is not premium — torrents require a premium subscription");
        setStatus({ configured: true, ...v });
      } else {
        setSuccess(`Connected as ${v.username}`);
        setStatus({ configured: true, ...v });
        setApiKey("");
      }
    } catch {
      setError("Failed to save configuration");
    }
    setSaving(false);
  }

  async function handleRemove() {
    try {
      await deleteDebridConfig();
      setStatus({ configured: false });
      setApiKey("");
      setError("");
      setSuccess("");
    } catch {
      setError("Failed to remove configuration");
    }
  }

  return (
    <div className="pair-overlay" onClick={onClose}>
      <div className="pair-modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pair-header">
          <h3>Settings</h3>
          <button className="pair-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="pair-body">
          <div className="settings-section">
            <div className="settings-section-header">
              <h4>Debrid Service</h4>
              {status?.configured && status?.valid && (
                <span className="settings-badge settings-badge-green">Connected</span>
              )}
              {status?.configured && status?.valid === false && (
                <span className="settings-badge settings-badge-red">Invalid</span>
              )}
            </div>
            <p className="pair-desc">
              Route torrents through a debrid service for instant streaming, full seeking, and IP privacy.
              Supports{" "}
              <a href="https://real-debrid.com" target="_blank" rel="noopener noreferrer" className="settings-link">
                Real-Debrid
              </a>{" "}
              and{" "}
              <a href="https://torbox.app" target="_blank" rel="noopener noreferrer" className="settings-link">
                TorBox
              </a>
              . Requires your own account — this is optional.
            </p>

            {!status ? (
              <div className="settings-skeleton">
                <div className="settings-skeleton-line settings-skeleton-line-long" />
                <div className="settings-skeleton-line settings-skeleton-line-short" />
              </div>
            ) : status.configured && status.valid && status.premium ? (
              <div className="settings-info">
                <div className="settings-info-row">
                  <span className="settings-info-label">Account</span>
                  <span className="settings-info-value">{status.username}</span>
                </div>
                <div className="settings-info-row">
                  <span className="settings-info-label">Provider</span>
                  <span className="settings-info-value">
                    {status.provider === "torbox" ? "TorBox" : "Real-Debrid"}
                  </span>
                </div>
                {status.expiration && (
                  <div className="settings-info-row">
                    <span className="settings-info-label">Expires</span>
                    <span className="settings-info-value">
                      {new Date(status.expiration).toLocaleDateString()}
                    </span>
                  </div>
                )}
                <div className="settings-info-row">
                  <span className="settings-info-label">Enabled</span>
                  <select
                    className="settings-mode-select"
                    value={status.mode === "off" ? "off" : "on"}
                    onChange={async (e) => {
                      const mode = e.target.value as "on" | "off";
                      try {
                        await setDebridMode(mode);
                        setStatus((prev) => prev ? { ...prev, mode } : prev);
                      } catch {}
                    }}
                  >
                    <option value="on">On</option>
                    <option value="off">Off (use WebTorrent)</option>
                  </select>
                </div>
                <button className="settings-remove-btn" onClick={handleRemove}>
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="settings-form">
                <select
                  className="settings-mode-select"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as "realdebrid" | "torbox")}
                >
                  <option value="realdebrid">Real-Debrid</option>
                  <option value="torbox">TorBox</option>
                </select>
                <input
                  className="settings-input"
                  type="password"
                  placeholder={provider === "realdebrid" ? "Real-Debrid API key" : "TorBox API key"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSave()}
                  autoComplete="off"
                />
                <button
                  className="pair-create-btn"
                  onClick={handleSave}
                  disabled={saving || !apiKey.trim()}
                >
                  {saving ? "Connecting..." : "Connect"}
                </button>
              </div>
            )}

            {verifying && <p className="settings-status">Verifying...</p>}
            {error && <p className="settings-error">{error}</p>}
            {success && <p className="settings-success">{success}</p>}
          </div>

          <div className="settings-divider" />
          <div className="settings-section">
            <div className="settings-section-header">
              <h4>Storage</h4>
              {cacheSize && (
                <span className="settings-badge settings-badge-muted">{cacheSize.formatted}</span>
              )}
            </div>
            <p className="pair-desc">
              Streamed video files are cached locally for faster replay. Files older than 24 hours are automatically cleaned on startup.
            </p>
            <button
              className="settings-clear-btn"
              onClick={handleClearCache}
              disabled={clearing || !cacheSize || cacheSize.bytes === 0}
            >
              {clearing ? "Clearing..." : "Clear cache"}
            </button>
          </div>

          <div className="settings-divider" />
          <div className="settings-section">
            <div className="settings-section-header">
              <h4>Data</h4>
            </div>
            <p className="pair-desc">
              Reset watch history, saved list, or all data. This cannot be undone.
            </p>
            <div className="settings-data-actions">
              <button
                className="settings-clear-btn"
                onClick={async () => {
                  setClearingHistory(true);
                  try { await clearWatchHistory(); setHistoryCount(0); window.dispatchEvent(new Event("storage-cleared")); } catch {}
                  setClearingHistory(false);
                }}
                disabled={clearingHistory || historyCount === 0}
              >
                {clearingHistory ? "Clearing..." : `Clear watch history${historyCount ? ` (${historyCount})` : ""}`}
              </button>
              <button
                className="settings-clear-btn"
                onClick={async () => {
                  setClearingSaved(true);
                  try { await clearSavedList(); setSavedCount(0); window.dispatchEvent(new Event("storage-cleared")); } catch {}
                  setClearingSaved(false);
                }}
                disabled={clearingSaved || savedCount === 0}
              >
                {clearingSaved ? "Clearing..." : `Clear saved list${savedCount ? ` (${savedCount})` : ""}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
