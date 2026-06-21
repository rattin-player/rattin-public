import { useState, useEffect } from "react";
import {
  getDebridStatus,
  verifyDebridKey,
  setDebridConfig,
  deleteDebridConfig,
  setDebridMode,
  getCacheSize,
  clearCache,
  clearWatchHistory,
  clearSavedList,
  getWatchHistoryCount,
  getSavedListCount,
  getPluginStatus,
  getPluginIndex,
  installPluginById,
  reloadPlugin,
  uninstallPlugin,
  getSettings,
  updateSettings,
  browseFolder,
  getTmdbStatus,
  setTmdbConfig,
  deleteTmdbConfig,
  type PluginIndexEntry,
  type PluginStatus,
} from "../lib/api";
import { usePlayer } from "../lib/PlayerContext";
import UpdateSection from "./UpdateSection";
import rattinMark from "../../packaging/linux/rattin.svg";
import "./SettingsModal.css";

type Tab = "plugins" | "streaming" | "metadata" | "storage" | "data" | "about";

interface SettingsModalProps {
  onClose: () => void;
}

const ICONS = {
  plugins: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v6M15 2v6" />
      <path d="M5 8h14v3a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5V8z" />
      <path d="M12 16v6" />
    </svg>
  ),
  streaming: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  metadata: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  storage: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  data: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  ),
  about: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  ),
};

const TABS: { id: Tab; label: string }[] = [
  { id: "plugins", label: "Plugins" },
  { id: "streaming", label: "Streaming" },
  { id: "metadata", label: "Metadata" },
  { id: "storage", label: "Storage" },
  { id: "data", label: "Data" },
  { id: "about", label: "About" },
];

const TAB_META: Record<Tab, { eyebrow: string; title: string; lede: string }> = {
  plugins: {
    eyebrow: "Plugins",
    title: "Extend Rattin with plugins",
    lede: "Rattin is intentionally minimal on its own. Plugins are signed packages from the Rattin registry that give it new ways to find and play media. Install only what you need.",
  },
  streaming: {
    eyebrow: "Streaming",
    title: "How media reaches the player",
    lede: "By default Rattin downloads over a decentralized network. Route through a private cache service for instant playback, full seeking, and IP privacy.",
  },
  metadata: {
    eyebrow: "Metadata",
    title: "Posters, ratings, and details",
    lede: "Rattin uses TMDB for movie and TV information. A built-in proxy works out of the box — no account needed. Add your own key for direct access.",
  },
  storage: {
    eyebrow: "Storage",
    title: "Where files live on disk",
    lede: "Rattin caches what you play and writes downloads to a folder of your choice. The cache clears itself; the download folder is yours to keep.",
  },
  data: {
    eyebrow: "Data",
    title: "Your history, your call",
    lede: "Everything Rattin stores is local. Clear what you want, when you want. Nothing here is sent anywhere.",
  },
  about: {
    eyebrow: "About",
    title: "Rattin",
    lede: "An open-source desktop media center. Browse, click, watch — no waiting, no accounts, no telemetry.",
  },
};

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("plugins");
  const { stopStream } = usePlayer();

  // ── Debrid ──
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

  // ── Plugin ──
  const [pluginStatus, setPluginStatus] = useState<PluginStatus | null>(null);
  const [pluginIndex, setPluginIndex] = useState<PluginIndexEntry[]>([]);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [pluginError, setPluginError] = useState("");

  // ── TMDB ──
  const [tmdbStatus, setTmdbStatus] = useState<{ configured: boolean; hasUserKey: boolean } | null>(null);
  const [tmdbKeyInput, setTmdbKeyInput] = useState("");
  const [tmdbSaving, setTmdbSaving] = useState(false);
  const [tmdbError, setTmdbError] = useState("");
  const [tmdbSuccess, setTmdbSuccess] = useState("");

  // ── Storage ──
  const [settings, setSettingsState] = useState<{ downloadPath?: string }>({});
  const [downloadPathInput, setDownloadPathInput] = useState("");
  const [downloadPathDirty, setDownloadPathDirty] = useState(false);
  const [cacheSize, setCacheSize] = useState<{ bytes: number; formatted: string } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cacheMessage, setCacheMessage] = useState<{ kind: "info" | "error" | "success"; text: string } | null>(null);

  // ── Data ──
  const [clearingHistory, setClearingHistory] = useState(false);
  const [clearingSaved, setClearingSaved] = useState(false);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);

  useEffect(() => {
    loadDebridStatus();
    loadCacheSize();
    loadDataCounts();
    loadPluginStatus();
    loadPluginIndex();
    loadSettings();
    loadTmdbStatus();
  }, []);

  // ── Loaders ──

  async function loadPluginIndex() {
    try {
      const index = await getPluginIndex();
      const compatible = index
        .filter((e) => (e.apiVersion ?? 1) === 1)
        .sort((a, b) => b.version.localeCompare(a.version));
      setPluginIndex(compatible);
    } catch {
      setPluginIndex([]);
    }
  }

  async function loadDebridStatus() {
    try {
      const s = await getDebridStatus();
      setDebridStatus(s);
      if (s.provider) setProvider(s.provider as "realdebrid" | "torbox");
      if (s.configured) {
        setVerifying(true);
        try {
          const v = await verifyDebridKey();
          setDebridStatus({ ...s, ...v });
        } finally {
          setVerifying(false);
        }
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

  async function loadTmdbStatus() {
    try {
      const s = await getTmdbStatus();
      setTmdbStatus(s);
    } catch {
      setTmdbStatus({ configured: true, hasUserKey: false });
    }
  }

  // ── Plugin handlers ──

  async function handleInstallPlugin(id: string) {
    setInstallingId(id);
    setPluginError("");
    try {
      await installPluginById(id);
      await loadPluginStatus();
    } catch (err) {
      setPluginError((err as Error).message || "Installation failed. Check your connection and try again.");
    }
    setInstallingId(null);
  }

  async function handleUninstallPlugin() {
    setPluginError("");
    try {
      await uninstallPlugin();
      await loadPluginStatus();
    } catch {
      setPluginError("Uninstall failed");
    }
  }

  async function handleReloadPlugin() {
    setPluginError("");
    try {
      await reloadPlugin();
      await loadPluginStatus();
    } catch {
      setPluginError("Reload failed");
    }
  }

  // ── TMDB handlers ──

  async function handleSaveTmdbKey() {
    if (!tmdbKeyInput.trim()) return;
    setTmdbSaving(true);
    setTmdbError("");
    setTmdbSuccess("");
    try {
      await setTmdbConfig(tmdbKeyInput.trim());
      setTmdbSuccess("Saved. Rattin now uses your TMDB key directly.");
      setTmdbKeyInput("");
      await loadTmdbStatus();
    } catch (err) {
      setTmdbError((err as Error).message || "Failed to save TMDB key");
    }
    setTmdbSaving(false);
  }

  async function handleRemoveTmdbKey() {
    setTmdbError("");
    setTmdbSuccess("");
    try {
      await deleteTmdbConfig();
      setTmdbSuccess("Removed. Rattin now uses the built-in proxy.");
      await loadTmdbStatus();
    } catch {
      setTmdbError("Failed to remove TMDB key");
    }
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
        setDebridError("Invalid API key. Double-check the token and try again.");
        setDebridStatus({ configured: true, valid: false });
      } else if (!v.premium) {
        setDebridError("Account isn't premium. Torrents require a premium subscription.");
        setDebridStatus({ configured: true, ...v });
      } else {
        setDebridSuccess(`Connected as ${v.username}.`);
        setDebridStatus({ configured: true, ...v });
        setApiKey("");
      }
    } catch {
      setDebridError("Couldn't reach the provider. Check your network and try again.");
    }
    setSaving(false);
  }

  async function handleRemoveDebrid() {
    setDebridError("");
    setDebridSuccess("");
    try {
      await deleteDebridConfig();
      await loadDebridStatus();
      setApiKey("");
    } catch {
      setDebridError("Failed to remove configuration");
    }
  }

  async function handleSetDebridMode(mode: "on" | "off") {
    if (!debridStatus) return;
    const prev = debridStatus.mode ?? "on";
    if (prev === mode) return;
    try {
      await setDebridMode(mode);
      await loadDebridStatus();
    } catch {
      setDebridError("Failed to change streaming mode");
    }
  }

  // ── Storage handlers ──

  async function handleSaveDownloadPath() {
    const normalized = downloadPathInput.trim().replace(/[/\\]+$/, "");
    if (!normalized) return;
    try {
      await updateSettings({ downloadPath: normalized });
      await loadSettings();
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
        setCacheMessage({
          kind: "error",
          text: `Some files are still in use (${data.remaining}). Stop playback first, then try again.`,
        });
        await loadCacheSize();
      } else {
        // Cache cleared — the active stream's files are gone.
        // Stop playback and close the MiniPlayer. You can't resume
        // something you just deleted.
        stopStream();
        await loadCacheSize();
        setCacheMessage({ kind: "success", text: "Cache cleared." });
      }
    } catch {
      setCacheMessage({ kind: "error", text: "Failed to clear cache." });
    }
    setClearing(false);
  }

  // ── Section renderers ──

  function StatusBar({ kind, children }: { kind: "error" | "success" | "info"; children: React.ReactNode }) {
    return (
      <div className={`settings-status-bar is-${kind}`}>
        {kind === "error" && (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        )}
        {kind === "success" && (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        {kind === "info" && (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        )}
        <span>{children}</span>
      </div>
    );
  }

  function TabHeader({ tab }: { tab: Tab }) {
    const meta = TAB_META[tab];
    return (
      <div className="settings-tab-title">
        <span className="settings-tab-eyebrow">{meta.eyebrow}</span>
        <h2>{meta.title}</h2>
        <p className="settings-tab-lede">{meta.lede}</p>
      </div>
    );
  }

  // ── Plugins tab ──

  function renderPlugins() {
    const installedId = pluginStatus?.plugin?.id ?? null;
    const isRunning = !!pluginStatus?.running;
    const hasAnyInstalled = pluginStatus?.installed && pluginStatus.plugin;

    return (
      <div className="settings-tab">
        <TabHeader tab="plugins" />

        <div className="settings-section">
          {!hasAnyInstalled && (
            <p className="settings-section-desc">
              Signed plugins from the Rattin registry. Install only what you need —
              each runs locally and stays separate from the rest of the app.
            </p>
          )}

          {pluginIndex.length === 0 ? (
            <div className="settings-status-inline">Loading registry…</div>
          ) : (
            <div className="plugin-list">
              {pluginIndex.map((entry) => {
                const isInstalled = entry.id === installedId;
                const isInstalling = installingId === entry.id;
                const updateAvailable =
                  isInstalled && pluginStatus?.plugin
                    ? entry.version !== pluginStatus.plugin.version &&
                      entry.version.localeCompare(pluginStatus.plugin.version, undefined, { numeric: true }) > 0
                    : false;

                return (
                  <div
                    key={entry.id}
                    className={`plugin-row ${isInstalled ? "is-installed" : ""}`}
                  >
                    <div className="plugin-row-main">
                      <div className="plugin-row-icon">
                        <PluginIcon />
                      </div>
                      <div className="plugin-row-text">
                        <div className="plugin-row-head">
                          <span className="plugin-row-name">{entry.name}</span>
                          <span className="plugin-row-version mono">v{entry.version}</span>
                          {isInstalled && (
                            <span className={`settings-badge ${isRunning ? "settings-badge-green" : "settings-badge-red"}`}>
                              <span className="settings-badge-dot" />
                              {isRunning ? "Running" : "Stopped"}
                            </span>
                          )}
                          {updateAvailable && (
                            <span className="settings-badge settings-badge-accent">Update available</span>
                          )}
                        </div>
                        <div className="plugin-row-desc">{entry.description}</div>
                        {isInstalled && (
                          <div className="plugin-row-actions">
                            {updateAvailable && (
                              <button
                                className="settings-btn settings-btn-primary settings-btn-sm"
                                onClick={() => handleInstallPlugin(entry.id)}
                                disabled={isInstalling}
                              >
                                {isInstalling ? "Updating…" : "Update"}
                              </button>
                            )}
                            <button
                              className="settings-btn settings-btn-secondary settings-btn-sm"
                              onClick={handleReloadPlugin}
                            >
                              Restart
                            </button>
                            <button
                              className="settings-btn settings-btn-danger settings-btn-sm"
                              onClick={handleUninstallPlugin}
                            >
                              Uninstall
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    {!isInstalled && (
                      <div className="plugin-row-action">
                        <button
                          className="settings-btn settings-btn-secondary"
                          onClick={() => handleInstallPlugin(entry.id)}
                          disabled={isInstalling || installingId !== null}
                        >
                          {isInstalling ? <><Spinner /> Installing…</> : <><DownloadIcon /> Install</>}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {pluginError && <StatusBar kind="error">{pluginError}</StatusBar>}
      </div>
    );
  }

  // ── Streaming tab ──

  function renderStreaming() {
    const configured = debridStatus?.configured && debridStatus?.valid && debridStatus?.premium;
    return (
      <div className="settings-tab">
        <TabHeader tab="streaming" />

        <div className="settings-section">
          <div className="settings-section-header">
            <h3>Debrid service</h3>
            {debridStatus?.configured && debridStatus?.valid && (
              <span className="settings-badge settings-badge-green">
                <span className="settings-badge-dot" />
                Connected
              </span>
            )}
            {debridStatus?.configured && debridStatus?.valid === false && (
              <span className="settings-badge settings-badge-red">
                <span className="settings-badge-dot" />
                Invalid
              </span>
            )}
            {debridStatus && !debridStatus.configured && (
              <span className="settings-badge settings-badge-muted">Not connected</span>
            )}
          </div>

          <p className="settings-section-desc">
            Route torrents through{" "}
            <a href="https://real-debrid.com" target="_blank" rel="noopener noreferrer">Real-Debrid</a>
            {" or "}
            <a href="https://torbox.app" target="_blank" rel="noopener noreferrer">TorBox</a>
            {" "}for instant HTTPS streaming, full seeking, and privacy protection. Optional — you
            can keep using the direct streaming engine if you prefer.
          </p>

          {!debridStatus ? (
            <div className="settings-skeleton">
              <div className="settings-skeleton-line settings-skeleton-line-long" />
              <div className="settings-skeleton-line settings-skeleton-line-short" />
            </div>
          ) : configured ? (
            <div className="settings-card is-elevated is-active">
              <div className="settings-info-row">
                <span className="settings-info-label">Account</span>
                <span className="settings-info-value">{debridStatus.username}</span>
              </div>
              <div className="settings-info-row">
                <span className="settings-info-label">Provider</span>
                <span className="settings-info-value">
                  {debridStatus.provider === "torbox" ? "TorBox" : "Real-Debrid"}
                </span>
              </div>
              {debridStatus.expiration && (
                <div className="settings-info-row">
                  <span className="settings-info-label">Subscription</span>
                  <span className="settings-info-value">
                    Premium until {new Date(debridStatus.expiration).toLocaleDateString(undefined, {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </div>
              )}
              <div className="settings-info-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 10, paddingTop: 14, paddingBottom: 14 }}>
                <span className="settings-info-label">Mode</span>
                <div className="debrid-mode-options" style={{ width: "100%" }}>
                  <button
                    className={`debrid-mode-option ${debridStatus.mode !== "off" ? "is-active" : ""}`}
                    onClick={() => handleSetDebridMode("on")}
                    type="button"
                  >
                    <span className="debrid-mode-option-title">
                      <CheckIcon /> Always use debrid
                    </span>
                    <span className="debrid-mode-option-desc">
                      Every play goes through {debridStatus.provider === "torbox" ? "TorBox" : "Real-Debrid"}.
                      Cold start on uncached content; full seeking.
                    </span>
                  </button>
                  <button
                    className={`debrid-mode-option ${debridStatus.mode === "off" ? "is-active" : ""}`}
                    onClick={() => handleSetDebridMode("off")}
                    type="button"
                  >
                    <span className="debrid-mode-option-title">
                      {debridStatus.mode === "off" ? <CheckIcon /> : <span style={{ width: 14, display: "inline-block" }} />}
                      Cached only
                    </span>
                    <span className="debrid-mode-option-desc">
                      Use the cache when media is already there. Fall back to direct streaming for the rest.
                    </span>
                  </button>
                </div>
              </div>
              <div className="settings-row-actions">
                <button className="settings-btn settings-btn-danger" onClick={handleRemoveDebrid}>
                  <UnlinkIcon /> Disconnect
                </button>
              </div>
            </div>
          ) : (
            <div className="settings-card is-elevated">
              <div className="settings-form" style={{ padding: 16, gap: 12 }}>
                <label className="settings-info-label" style={{ marginBottom: -4 }}>Provider</label>
                <div className="debrid-mode-options">
                  <button
                    type="button"
                    className={`debrid-mode-option ${provider === "realdebrid" ? "is-active" : ""}`}
                    onClick={() => setProvider("realdebrid")}
                  >
                    <span className="debrid-mode-option-title">Real-Debrid</span>
                    <span className="debrid-mode-option-desc">The original, biggest cache.</span>
                  </button>
                  <button
                    type="button"
                    className={`debrid-mode-option ${provider === "torbox" ? "is-active" : ""}`}
                    onClick={() => setProvider("torbox")}
                  >
                    <span className="debrid-mode-option-title">TorBox</span>
                    <span className="debrid-mode-option-desc">Newer, growing cache.</span>
                  </button>
                </div>
                <label className="settings-info-label" style={{ marginBottom: -4, marginTop: 4 }}>API key</label>
                <input
                  className="settings-input"
                  type="password"
                  placeholder={provider === "realdebrid" ? "Paste your Real-Debrid API token" : "Paste your TorBox API key"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveDebrid()}
                  autoComplete="off"
                />
                <p className="settings-section-desc" style={{ fontSize: 12, marginTop: -2 }}>
                  {provider === "realdebrid" ? (
                    <>Find it on the <a href="https://real-debrid.com/apitoken" target="_blank" rel="noopener noreferrer">API token page</a> after signing in.</>
                  ) : (
                    <>Found in TorBox under Settings → API.</>
                  )}
                </p>
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={handleSaveDebrid}
                  disabled={saving || !apiKey.trim()}
                >
                  {saving ? <><Spinner /> Verifying…</> : <>Connect</>}
                </button>
              </div>
            </div>
          )}

          {verifying && <p className="settings-status-inline">Verifying credentials…</p>}
          {debridError && <StatusBar kind="error">{debridError}</StatusBar>}
          {debridSuccess && <StatusBar kind="success">{debridSuccess}</StatusBar>}
        </div>
      </div>
    );
  }

  // ── Metadata tab ──

  function renderMetadata() {
    const hasUserKey = tmdbStatus?.hasUserKey;
    return (
      <div className="settings-tab">
        <TabHeader tab="metadata" />

        <div className="settings-section">
          <div className="settings-section-header">
            <h3>TMDB</h3>
            {hasUserKey ? (
              <span className="settings-badge settings-badge-green">
                <span className="settings-badge-dot" />
                Personal key
              </span>
            ) : tmdbStatus ? (
              <span className="settings-badge settings-badge-amber">
                <span className="settings-badge-dot" />
                Built-in proxy
              </span>
            ) : null}
          </div>

          <p className="settings-section-desc">
            Rattin uses{" "}
            <a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer">TMDB</a>
            {" "}for posters, ratings, cast, and episode guides. The built-in proxy works out of
            the box — no account needed. Add your own key for direct, unmetered access.
          </p>

          {tmdbStatus ? (
            hasUserKey ? (
              // ── Personal key view: one coherent card, not two contradictory ones
              <div className="settings-card is-elevated is-active">
                <div className="tmdb-source-head">
                  <div className="tmdb-source-icon">
                    <KeyIcon />
                  </div>
                  <div className="tmdb-source-text">
                    <div className="tmdb-source-name">Your TMDB API key</div>
                    <div className="tmdb-source-sub">Direct requests to themoviedb.org</div>
                  </div>
                  <span className="settings-badge settings-badge-green">
                    <span className="settings-badge-dot" />
                    Active
                  </span>
                </div>
                <div className="tmdb-source-body">
                  <p className="settings-section-desc" style={{ fontSize: 12, marginTop: -2 }}>
                    Requests go straight to TMDB using your key. Rate limits and quotas
                    are your own.
                  </p>
                  <button
                    className="settings-btn settings-btn-secondary"
                    onClick={handleRemoveTmdbKey}
                    style={{ alignSelf: "flex-start" }}
                  >
                    <UnlinkIcon /> Switch back to the built-in proxy
                  </button>
                </div>
              </div>
            ) : (
              // ── Built-in proxy view: one card, optional upgrade path inline
              <div className="settings-card is-elevated">
                <div className="tmdb-source-head">
                  <div className="tmdb-source-icon is-proxy">
                    <GlobeIcon />
                  </div>
                  <div className="tmdb-source-text">
                    <div className="tmdb-source-name">Built-in proxy</div>
                    <div className="tmdb-source-sub">rattin-tmdb.pages.dev</div>
                  </div>
                  <span className="settings-badge settings-badge-muted">No setup</span>
                </div>
                <div className="tmdb-source-body">
                  <p className="settings-section-desc" style={{ fontSize: 12, marginTop: -2 }}>
                    A shared endpoint we run so the app works on first launch. Fine for
                    normal use, but a personal key is faster and never rate-limited.
                  </p>

                  <div className="settings-divider" style={{ margin: "2px 0" }} />

                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <span className="settings-info-label" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.18em" }}>
                      Use your own key instead
                    </span>
                    <div className="settings-form-row">
                      <input
                        className="settings-input is-mono-input"
                        type="password"
                        placeholder="Paste your TMDB v3 auth key"
                        value={tmdbKeyInput}
                        onChange={(e) => setTmdbKeyInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSaveTmdbKey()}
                        autoComplete="off"
                      />
                      <button
                        className="settings-btn settings-btn-primary"
                        onClick={handleSaveTmdbKey}
                        disabled={tmdbSaving || !tmdbKeyInput.trim()}
                      >
                        {tmdbSaving ? "Saving…" : "Save"}
                      </button>
                    </div>
                    <p className="settings-section-desc" style={{ fontSize: 11.5, marginTop: 0 }}>
                      Free from{" "}
                      <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">
                        themoviedb.org/settings/api
                      </a>
                      . Takes about a minute.
                    </p>
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="settings-skeleton">
              <div className="settings-skeleton-line settings-skeleton-line-long" />
              <div className="settings-skeleton-line settings-skeleton-line-short" />
            </div>
          )}

          {tmdbError && <StatusBar kind="error">{tmdbError}</StatusBar>}
          {tmdbSuccess && <StatusBar kind="success">{tmdbSuccess}</StatusBar>}
        </div>
      </div>
    );
  }

  // ── Storage tab ──

  function renderStorage() {
    const cacheBytes = cacheSize?.bytes ?? 0;
    // Pretend a "full" cache is around 20 GB for the meter
    const meterPct = Math.min(100, Math.round((cacheBytes / (20 * 1024 ** 3)) * 100));
    const pathDirty = downloadPathDirty;
    return (
      <div className="settings-tab">
        <TabHeader tab="storage" />

        <div className="settings-section">
          <div className="settings-section-header">
            <h3>Download folder</h3>
            {pathDirty && <span className="settings-badge settings-badge-amber">Unsaved</span>}
          </div>
          <p className="settings-section-desc">
            Where downloads are stored on disk. Changes take effect after restarting
            Rattin.
          </p>
          <div className="settings-card is-elevated">
            <div className="settings-info-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10, padding: 14 }}>
              <span className="settings-info-label">Path</span>
              <div className="settings-form-row">
                <input
                  className="settings-input"
                  type="text"
                  placeholder="/home/you/Downloads"
                  value={downloadPathInput}
                  onChange={(e) => {
                    setDownloadPathInput(e.target.value);
                    setDownloadPathDirty(true);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveDownloadPath()}
                  autoComplete="off"
                />
                <button className="settings-btn settings-btn-secondary" onClick={handleBrowse}>
                  <FolderIcon /> Browse
                </button>
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={handleSaveDownloadPath}
                  disabled={!pathDirty || !downloadPathInput.trim()}
                >
                  Save
                </button>
              </div>
              {pathDirty && (
                <p className="settings-section-desc" style={{ fontSize: 11.5, color: "var(--accent-bright)", marginTop: 0 }}>
                  Restart Rattin to start writing downloads here.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">
            <h3>Stream cache</h3>
            {cacheSize && <span className="settings-badge settings-badge-muted mono">{cacheSize.formatted}</span>}
          </div>
          <p className="settings-section-desc">
            Rattin keeps streamed files locally for instant replay. Anything older than 24
            hours is cleared on startup; you can clear it manually here too.
          </p>
          <div className="settings-card is-elevated">
            <div className="storage-meter">
              <div className="storage-meter-head">
                <span className="storage-meter-label">In use</span>
                <span className="storage-meter-value">{cacheSize?.formatted ?? "—"}</span>
              </div>
              <div className="storage-meter-track">
                <div className="storage-meter-fill" style={{ width: `${meterPct}%` }} />
              </div>
            </div>
            <div className="settings-row-actions">
              <button
                className="settings-btn settings-btn-danger"
                onClick={handleClearCache}
                disabled={clearing || !cacheSize || cacheSize.bytes === 0}
              >
                {clearing ? <><Spinner /> Clearing…</> : <><TrashIcon /> Clear cache</>}
              </button>
            </div>
          </div>
          {cacheMessage && <StatusBar kind={cacheMessage.kind}>{cacheMessage.text}</StatusBar>}
        </div>
      </div>
    );
  }

  // ── Data tab ──

  function renderData() {
    return (
      <div className="settings-tab">
        <TabHeader tab="data" />

        <div className="settings-section">
          <div className="settings-section-header">
            <h3>Local data</h3>
          </div>
          <p className="settings-section-desc">
            Wipe what's stored on this machine. Nothing here was ever sent anywhere — clearing
            just removes it from your disk.
          </p>
          <div className="settings-card is-elevated">
            <div className="data-row">
              <div className="data-row-text">
                <div className="data-row-name">
                  Watch history
                  {historyCount !== null && historyCount > 0 && (
                    <span className="data-row-count">{historyCount}</span>
                  )}
                </div>
                <div className="data-row-desc">
                  What you've played, where you left off, what you've finished. Used to resume shows
                  and remember your place.
                </div>
              </div>
              <button
                className="settings-btn settings-btn-danger"
                onClick={async () => {
                  setClearingHistory(true);
                  try {
                    await clearWatchHistory();
                    await loadDataCounts();
                    window.dispatchEvent(new Event("storage-cleared"));
                  } catch {}
                  setClearingHistory(false);
                }}
                disabled={clearingHistory || historyCount === 0}
              >
                {clearingHistory ? "Clearing…" : "Clear history"}
              </button>
            </div>
            <div className="data-row" style={{ borderTop: "1px solid var(--border)" }}>
              <div className="data-row-text">
                <div className="data-row-name">
                  Saved list
                  {savedCount !== null && savedCount > 0 && (
                    <span className="data-row-count">{savedCount}</span>
                  )}
                </div>
                <div className="data-row-desc">
                  Movies and shows you bookmarked for later. Independent of your watch history.
                </div>
              </div>
              <button
                className="settings-btn settings-btn-danger"
                onClick={async () => {
                  setClearingSaved(true);
                  try {
                    await clearSavedList();
                    await loadDataCounts();
                    window.dispatchEvent(new Event("storage-cleared"));
                  } catch {}
                  setClearingSaved(false);
                }}
                disabled={clearingSaved || savedCount === 0}
              >
                {clearingSaved ? "Clearing…" : "Clear saved list"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── About tab ──

  function renderAbout() {
    return (
      <div className="settings-tab">
        <TabHeader tab="about" />

        <div className="settings-section">
          <div className="about-mark">
            <img src={rattinMark} alt="Rattin" className="about-mark-logo" />
            <div className="about-mark-text">
              <div className="about-mark-name">Rattin</div>
              <div className="about-mark-tagline">Open-source desktop media center</div>
            </div>
          </div>
          <div className="about-baseline" />
          <p className="about-statement">
            A single desktop app for browsing, clicking, and watching —{" "}
            <strong>no waiting, no accounts, no telemetry</strong>.
            Built on libmpv, decentralized streaming, TMDB, and a signed add-on system.
          </p>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">
            <h3>The short version</h3>
          </div>
          <div className="about-pillars">
            <div className="about-pillar">
              <div className="about-pillar-icon"><PlayIcon /></div>
              <div className="about-pillar-title">Every format, native</div>
              <div className="about-pillar-desc">
                MKV, HEVC, AV1, HDR. Played by libmpv with hardware decoding. Zero transcoding.
              </div>
            </div>
            <div className="about-pillar">
              <div className="about-pillar-icon"><ShieldIcon /></div>
              <div className="about-pillar-title">Privacy by default</div>
              <div className="about-pillar-desc">
                No signup, no analytics, no phone-home. Optional private cache and per-app VPN.
              </div>
            </div>
            <div className="about-pillar">
              <div className="about-pillar-icon"><PlugIcon /></div>
              <div className="about-pillar-title">Signed add-ons</div>
              <div className="about-pillar-desc">
                Extend Rattin with signed add-ons from the registry. Install, update, switch — all from the app.
              </div>
            </div>
            <div className="about-pillar">
              <div className="about-pillar-icon"><PhoneIcon /></div>
              <div className="about-pillar-title">Phone remote</div>
              <div className="about-pillar-desc">
                Scan a QR code from the navbar. No app install, no accounts — just a web page.
              </div>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">
            <h3>Project facts</h3>
          </div>
          <div className="about-factsheet">
            <div className="about-factsheet-label">Version</div>
            <div className="about-factsheet-value mono">3.0.0</div>

            <div className="about-factsheet-label">License</div>
            <div className="about-factsheet-value">GPL-3.0-only</div>

            <div className="about-factsheet-label">Platforms</div>
            <div className="about-factsheet-value">Linux · Windows</div>

            <div className="about-factsheet-label">Stack</div>
            <div className="about-factsheet-value mono">
              React 19 · Vite 6 · Express 5 · libmpv · TMDB
            </div>

            <div className="about-factsheet-label">Source</div>
            <div className="about-factsheet-value">
              <a href="https://github.com/rattin-player/rattin-public" target="_blank" rel="noopener noreferrer">
                <ExternalIcon /> github.com/rattin-player/rattin-public
              </a>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <UpdateSection />
        </div>

        <div className="settings-section">
          <div className="settings-section-header">
            <h3>Help &amp; community</h3>
          </div>
          <p className="settings-section-desc">
            File a bug, request a feature, or read what changed. Issues get read by a human.
          </p>
          <div className="about-links">
            <a className="about-link" href="https://github.com/rattin-player/rattin-public/issues" target="_blank" rel="noopener noreferrer">
              <BugIcon /> Report an issue
            </a>
            <a className="about-link" href="https://github.com/rattin-player/rattin-public/releases" target="_blank" rel="noopener noreferrer">
              <TagIcon /> Release notes
            </a>
            <a className="about-link" href="https://github.com/rattin-player/rattin-public#readme" target="_blank" rel="noopener noreferrer">
              <BookIcon /> Read the docs
            </a>
          </div>
        </div>

        <div className="settings-section">
          <p className="about-credits">
            <strong>Credits.</strong>{" "}
            Built on the shoulders of libmpv, the decentralized streaming stack behind it, TMDB, Express, React,
            and the open-source community. Poster and metadata art is © their respective rights
            holders; Rattin just looks it up.
          </p>
        </div>
      </div>
    );
  }

  const sectionRenderers: Record<Tab, () => JSX.Element> = {
    plugins: renderPlugins,
    streaming: renderStreaming,
    metadata: renderMetadata,
    storage: renderStorage,
    data: renderData,
    about: renderAbout,
  };

  return (
    <div className="pair-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>Settings</h3>
          <button className="settings-close" onClick={onClose} aria-label="Close settings">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-sidebar" aria-label="Settings sections">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`settings-nav-item${activeTab === tab.id ? " active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {ICONS[tab.id]}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-content" key={activeTab}>
            {sectionRenderers[activeTab]()}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Inline icons (kept compact, consistent 1.6 stroke) ─── */

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ animation: "settingsSpin 0.8s linear infinite" }}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function PluginIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v6M15 2v6" />
      <path d="M5 8h14v3a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5V8z" />
      <path d="M12 16v6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function UninstallIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18.84 12.61a4 4 0 0 0-5.66-5.66l-1.41 1.41" />
      <path d="M5.16 11.39a4 4 0 0 0 5.66 5.66l1.41-1.41" />
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function UnlinkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18.84 12.61a4 4 0 0 0-5.66-5.66l-1.41 1.41" />
      <path d="M5.16 11.39a4 4 0 0 0 5.66 5.66l1.41-1.41" />
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v6M15 2v6" />
      <path d="M5 8h14v3a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5V8z" />
      <path d="M12 16v6" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function BugIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="6" width="8" height="14" rx="4" />
      <line x1="3" y1="13" x2="6" y2="13" />
      <line x1="18" y1="13" x2="21" y2="13" />
      <line x1="3" y1="18" x2="6" y2="17" />
      <line x1="18" y1="17" x2="21" y2="18" />
      <path d="M12 20v-6" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.59 13.41L13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
