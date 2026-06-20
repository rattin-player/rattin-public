import { useState, useEffect } from "react";
import { getDebridStatus, verifyDebridKey, setDebridConfig, deleteDebridConfig, setDebridMode, getCacheSize, clearCache, clearWatchHistory, clearSavedList, getWatchHistoryCount, getSavedListCount, getPluginStatus, getPluginIndex, installPlugin, installPluginFromUrl, reloadPlugin, uninstallPlugin, getSettings, updateSettings, browseFolder } from "../lib/api";
import UpdateSection from "./UpdateSection";
import "./SettingsModal.css";

type Tab = "sources" | "streaming" | "storage" | "data" | "about";

interface SettingsModalProps {
  onClose: () => void;
}

const TABS: { id: Tab; label: string; icon: JSX.Element }[] = [
  {
    id: "sources",
    label: "Sources",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
  },
  {
    id: "streaming",
    label: "Streaming",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="5 3 19 12 5 21 5 3" />
      </svg>
    ),
  },
  {
    id: "storage",
    label: "Storage",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      </svg>
    ),
  },
  {
    id: "data",
    label: "Data",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
      </svg>
    ),
  },
  {
    id: "about",
    label: "About",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
      </svg>
    ),
  },
];

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("sources");

  // ── Debrid state ──
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<"realdebrid" | "torbox">("realdebrid");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [debridStatus, setDebridStatus] = useState<{
    configured: boolean; valid?: boolean; premium?: boolean;
    username?: string | null; expiration?: string | null;
    mode?: "on" | "off"; provider?: string | null;
  } | null>(null);
  const [debridError, setDebridError] = useState("");
  const [debridSuccess, setDebridSuccess] = useState("");

  // ── Plugin state ──
  const [pluginStatus, setPluginStatus] = useState<{
    installed: boolean; running: boolean;
    plugin: { id: string; name: string; version: string } | null;
    sourceUrl: string | null;
  } | null>(null);
  const [pluginInstalling, setPluginInstalling] = useState(false);
  const [pluginError, setPluginError] = useState("");
  const [sourceUrlInput, setSourceUrlInput] = useState("https://rattin-plugins.pages.dev/plugins/rattin-sources/1.0.0.js");
  const [devMode, setDevMode] = useState(false);

  // ── Storage state ──
  const [settings, setSettingsState] = useState<{ downloadPath?: string }>({});
  const [downloadPathInput, setDownloadPathInput] = useState("");
  const [downloadPathDirty, setDownloadPathDirty] = useState(false);
  const [cacheSize, setCacheSize] = useState<{ bytes: number; formatted: string } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);

  // ── Data state ──
  const [clearingHistory, setClearingHistory] = useState(false);
  const [clearingSaved, setClearingSaved] = useState(false);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);

  useEffect(() => {
    loadDebridStatus();
    loadCacheSize();
    loadDataCounts();
    loadPluginStatus();
    loadSettings();
  }, []);

  // ── Loaders ──

  async function loadDebridStatus() {
    try {
      const s = await getDebridStatus();
      setDebridStatus(s);
      if (s.provider) setProvider(s.provider as "realdebrid" | "torbox");
      if (s.configured) {
        setVerifying(true);
        const v = await verifyDebridKey();
        setDebridStatus({ ...s, ...v });
        setVerifying(false);
      }
    } catch {
      setDebridStatus({ configured: false });
    }
  }

  async function loadCacheSize() {
    try { setCacheSize(await getCacheSize()); }
    catch { setCacheSize({ bytes: 0, formatted: "0 B" }); }
  }

  async function loadDataCounts() {
    try {
      const [h, s] = await Promise.all([getWatchHistoryCount(), getSavedListCount()]);
      setHistoryCount(h.count);
      setSavedCount(s.count);
    } catch {}
  }

  async function loadPluginStatus() {
    try {
      const status = await getPluginStatus();
      setPluginStatus(status);
      if (status.sourceUrl) {
        setSourceUrlInput(status.sourceUrl);
      }
    } catch {
      setPluginStatus({ installed: false, running: false, plugin: null, sourceUrl: null });
    }
  }

  async function loadSettings() {
    try {
      const s = await getSettings();
      setSettingsState(s);
      setDownloadPathInput(s.downloadPath || "");
    } catch {}
  }

  // ── Plugin handlers ──

  async function handleInstallPlugin() {
    if (!sourceUrlInput.trim()) return;
    setPluginInstalling(true);
    setPluginError("");
    try {
      await installPluginFromUrl(sourceUrlInput.trim());
      await loadPluginStatus();
    } catch (err) {
      setPluginError((err as Error).message || "Installation failed");
    }
    setPluginInstalling(false);
  }

  async function handleUninstallPlugin() {
    try { await uninstallPlugin(); await loadPluginStatus(); }
    catch { setPluginError("Uninstall failed"); }
  }

  async function handleReloadPlugin() {
    try { await reloadPlugin(); await loadPluginStatus(); }
    catch { setPluginError("Reload failed"); }
  }

  // ── Debrid handlers ──

  async function handleSaveDebrid() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setDebridError("");
    setDebridSuccess("");
    try {
      await setDebridConfig(apiKey.trim(), provider);
      const v = await verifyDebridKey();
      if (!v.valid) {
        setDebridError("Invalid API key");
        setDebridStatus({ configured: true, valid: false });
      } else if (!v.premium) {
        setDebridError("Account is not premium — torrents require a premium subscription");
        setDebridStatus({ configured: true, ...v });
      } else {
        setDebridSuccess(`Connected as ${v.username}`);
        setDebridStatus({ configured: true, ...v });
        setApiKey("");
      }
    } catch { setDebridError("Failed to save configuration"); }
    setSaving(false);
  }

  async function handleRemoveDebrid() {
    try {
      await deleteDebridConfig();
      setDebridStatus({ configured: false });
      setApiKey("");
      setDebridError("");
      setDebridSuccess("");
    } catch { setDebridError("Failed to remove configuration"); }
  }

  // ── Storage handlers ──

  async function handleSaveDownloadPath() {
    const normalized = downloadPathInput.trim().replace(/[/\\]+$/, "");
    if (!normalized) return;
    try {
      await updateSettings({ downloadPath: normalized });
      setSettingsState((prev) => ({ ...prev, downloadPath: normalized }));
      setDownloadPathDirty(false);
    } catch {}
  }

  async function handleBrowse() {
    try {
      const selected = await browseFolder();
      if (selected) {
        setDownloadPathInput(selected);
        setDownloadPathDirty(true);
      }
    } catch {}
  }

  async function handleClearCache() {
    setClearing(true);
    setCacheMessage(null);
    try {
      const res = await fetch("/api/cache", { method: "DELETE" });
      const data = await res.json() as { cleared: boolean; remaining?: string };
      if (!data.cleared && data.remaining) {
        setCacheMessage(`Some files are still in use (${data.remaining}). Stop playback first, then try again.`);
        await loadCacheSize();
      } else {
        setCacheSize({ bytes: 0, formatted: "0 B" });
        setCacheMessage("Cache cleared.");
      }
    } catch {
      setCacheMessage("Failed to clear cache.");
    }
    setClearing(false);
  }

  // ── Section renderers ──

  function renderSources() {
    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <h4>Content Sources</h4>
          {pluginStatus?.installed && pluginStatus?.running && (
            <span className="settings-badge settings-badge-green">Running</span>
          )}
          {pluginStatus?.installed && !pluginStatus?.running && (
            <span className="settings-badge settings-badge-red">Stopped</span>
          )}
        </div>
        <p className="settings-desc">
          Content source plugins provide search results. Enter the URL of a signed plugin to install.
        </p>
        <div className="settings-form">
          <input className="settings-input" type="text" placeholder="Plugin URL..."
            value={sourceUrlInput} onChange={(e) => setSourceUrlInput(e.target.value)}
            autoComplete="off" />
          <button className="settings-btn-primary" onClick={handleInstallPlugin}
            disabled={pluginInstalling || !sourceUrlInput.trim()}>
            {pluginInstalling ? "Installing..." : pluginStatus?.installed ? "Reinstall" : "Install"}
          </button>
        </div>
        {pluginStatus?.installed && (
          <div className="settings-card" style={{ marginTop: 12 }}>
            <div className="settings-info-row">
              <span className="settings-info-label">Plugin</span>
              <span className="settings-info-value">{pluginStatus.plugin?.name}</span>
            </div>
            <div className="settings-info-row">
              <span className="settings-info-label">Version</span>
              <span className="settings-info-value">{pluginStatus.plugin?.version}</span>
            </div>
            <div className="settings-info-row">
              <span className="settings-info-label">Source</span>
              <span className="settings-info-value settings-info-url">{pluginStatus.sourceUrl}</span>
            </div>
            <div className="settings-row-actions">
              <button className="settings-btn-secondary" onClick={handleReloadPlugin}>Restart</button>
              <button className="settings-btn-danger" onClick={handleUninstallPlugin}>Uninstall</button>
            </div>
          </div>
        )}
        <div className="settings-divider" />
        <label className="settings-toggle-row">
          <span className="settings-info-label">Developer mode</span>
          <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} />
        </label>
        {devMode && (
          <p className="settings-warning">
            Allows unsigned plugins from local files. Use at your own risk.
          </p>
        )}
        {pluginError && <p className="settings-error">{pluginError}</p>}
      </div>
    );
  }

  function renderStreaming() {
    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <h4>Debrid Service</h4>
          {debridStatus?.configured && debridStatus?.valid && (
            <span className="settings-badge settings-badge-green">Connected</span>
          )}
          {debridStatus?.configured && debridStatus?.valid === false && (
            <span className="settings-badge settings-badge-red">Invalid</span>
          )}
        </div>
        <p className="settings-desc">
          Route torrents through a debrid service for instant streaming, full seeking, and IP privacy.
          Supports{" "}
          <a href="https://real-debrid.com" target="_blank" rel="noopener noreferrer" className="settings-link">Real-Debrid</a>{" "}
          and{" "}
          <a href="https://torbox.app" target="_blank" rel="noopener noreferrer" className="settings-link">TorBox</a>.
          Requires your own account — this is optional.
        </p>

        {!debridStatus ? (
          <div className="settings-skeleton">
            <div className="settings-skeleton-line settings-skeleton-line-long" />
            <div className="settings-skeleton-line settings-skeleton-line-short" />
          </div>
        ) : debridStatus.configured && debridStatus.valid && debridStatus.premium ? (
          <div className="settings-card">
            <div className="settings-info-row">
              <span className="settings-info-label">Account</span>
              <span className="settings-info-value">{debridStatus.username}</span>
            </div>
            <div className="settings-info-row">
              <span className="settings-info-label">Provider</span>
              <span className="settings-info-value">{debridStatus.provider === "torbox" ? "TorBox" : "Real-Debrid"}</span>
            </div>
            {debridStatus.expiration && (
              <div className="settings-info-row">
                <span className="settings-info-label">Expires</span>
                <span className="settings-info-value">{new Date(debridStatus.expiration).toLocaleDateString()}</span>
              </div>
            )}
            <div className="settings-info-row">
              <span className="settings-info-label">Enabled</span>
              <select className="settings-select" value={debridStatus.mode === "off" ? "off" : "on"}
                onChange={async (e) => {
                  const mode = e.target.value as "on" | "off";
                  try { await setDebridMode(mode); setDebridStatus((prev) => prev ? { ...prev, mode } : prev); } catch {}
                }}>
                <option value="on">On</option>
                <option value="off">Off (use WebTorrent)</option>
              </select>
            </div>
            <button className="settings-btn-danger" onClick={handleRemoveDebrid}>Disconnect</button>
          </div>
        ) : (
          <div className="settings-form">
            <select className="settings-select" value={provider}
              onChange={(e) => setProvider(e.target.value as "realdebrid" | "torbox")}>
              <option value="realdebrid">Real-Debrid</option>
              <option value="torbox">TorBox</option>
            </select>
            <input className="settings-input" type="password"
              placeholder={provider === "realdebrid" ? "Real-Debrid API key" : "TorBox API key"}
              value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveDebrid()} autoComplete="off" />
            <button className="settings-btn-primary" onClick={handleSaveDebrid} disabled={saving || !apiKey.trim()}>
              {saving ? "Connecting..." : "Connect"}
            </button>
          </div>
        )}

        {verifying && <p className="settings-status">Verifying...</p>}
        {debridError && <p className="settings-error">{debridError}</p>}
        {debridSuccess && <p className="settings-success">{debridSuccess}</p>}
      </div>
    );
  }

  function renderStorage() {
    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <h4>Download Location</h4>
        </div>
        <p className="settings-desc">
          Choose where downloaded files are stored. Changes take effect after restarting the app.
        </p>
        <div className="settings-form">
          <div className="settings-path-row">
            <input className="settings-input settings-input-path" type="text"
              placeholder="Download path..."
              value={downloadPathInput}
              onChange={(e) => { setDownloadPathInput(e.target.value); setDownloadPathDirty(true); }}
              onKeyDown={(e) => e.key === "Enter" && handleSaveDownloadPath()}
              autoComplete="off" />
            <button className="settings-btn-secondary" onClick={handleBrowse}>Browse</button>
            <button className="settings-btn-secondary" onClick={handleSaveDownloadPath}
              disabled={!downloadPathDirty || !downloadPathInput.trim()}>
              Save
            </button>
          </div>
          {downloadPathDirty && (
            <p className="settings-status" style={{ color: "var(--accent)" }}>
              Restart the app to apply the new download location.
            </p>
          )}
        </div>

        <div className="settings-divider" />
        <div className="settings-section-header">
          <h4>Cache</h4>
          {cacheSize && <span className="settings-badge settings-badge-muted">{cacheSize.formatted}</span>}
        </div>
        <p className="settings-desc">
          Streamed video files are cached locally for faster replay. Files older than 24 hours are automatically cleaned on startup.
        </p>
        <button className="settings-btn-danger" onClick={handleClearCache}
          disabled={clearing || !cacheSize || cacheSize.bytes === 0}>
          {clearing ? "Clearing..." : "Clear cache"}
        </button>
        {cacheMessage && <p className="settings-status">{cacheMessage}</p>}
      </div>
    );
  }

  function renderData() {
    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <h4>Data</h4>
        </div>
        <p className="settings-desc">
          Reset watch history, saved list, or all data. This cannot be undone.
        </p>
        <div className="settings-row-actions">
          <button className="settings-btn-danger" onClick={async () => {
            setClearingHistory(true);
            try { await clearWatchHistory(); setHistoryCount(0); window.dispatchEvent(new Event("storage-cleared")); } catch {}
            setClearingHistory(false);
          }} disabled={clearingHistory || historyCount === 0}>
            {clearingHistory ? "Clearing..." : `Clear watch history${historyCount ? ` (${historyCount})` : ""}`}
          </button>
          <button className="settings-btn-danger" onClick={async () => {
            setClearingSaved(true);
            try { await clearSavedList(); setSavedCount(0); window.dispatchEvent(new Event("storage-cleared")); } catch {}
            setClearingSaved(false);
          }} disabled={clearingSaved || savedCount === 0}>
            {clearingSaved ? "Clearing..." : `Clear saved list${savedCount ? ` (${savedCount})` : ""}`}
          </button>
        </div>
      </div>
    );
  }

  function renderAbout() {
    return (
      <div className="settings-section">
        <UpdateSection />
        <div className="settings-divider" />
        <div className="settings-card">
          <div className="settings-info-row">
            <span className="settings-info-label">Version</span>
            <span className="settings-info-value">3.0.0</span>
          </div>
          <div className="settings-info-row">
            <span className="settings-info-label">License</span>
            <span className="settings-info-value">GPL-3.0</span>
          </div>
          <div className="settings-info-row">
            <span className="settings-info-label">Source</span>
            <a href="https://github.com/rattin-player/rattin-public" target="_blank" rel="noopener noreferrer" className="settings-link">
              github.com/rattin-player/rattin-public
            </a>
          </div>
        </div>
      </div>
    );
  }

  const sectionRenderers: Record<Tab, () => JSX.Element> = {
    sources: renderSources,
    streaming: renderStreaming,
    storage: renderStorage,
    data: renderData,
    about: renderAbout,
  };

  return (
    <div className="pair-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>Settings</h3>
          <button className="pair-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-sidebar">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`settings-nav-item${activeTab === tab.id ? " active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {sectionRenderers[activeTab]()}
          </div>
        </div>
      </div>
    </div>
  );
}
