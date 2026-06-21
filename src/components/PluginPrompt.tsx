// src/components/PluginPrompt.tsx
import { useState, useEffect } from "react";
import { getPluginIndex, installPluginById } from "../lib/api";
import "./PluginPrompt.css";

interface PluginPromptProps {
  onInstalled: () => void;
  onClose: () => void;
}

export default function PluginPrompt({ onInstalled, onClose }: PluginPromptProps) {
  const [entry, setEntry] = useState<{ id: string; name: string; description: string; version: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getPluginIndex().then((index) => {
      // Prefer the default "official" plugin if listed, otherwise take the
      // first compatible entry. The registry is sorted newest-version first.
      const compatible = index
        .filter((e) => (e.apiVersion ?? 1) === 1)
        .sort((a, b) => b.version.localeCompare(a.version));
      const picked = compatible.find((e) => e.id === "official") ?? compatible[0];
      if (picked) {
        setEntry({ id: picked.id, name: picked.name, description: picked.description, version: picked.version });
      }
    }).catch(() => {});
  }, []);

  async function handleInstall() {
    if (!entry) return;
    setInstalling(true);
    setError("");
    try {
      await installPluginById(entry.id);
      onInstalled();
    } catch (err) {
      setError((err as Error).message || "Installation failed. Please try again.");
    }
    setInstalling(false);
  }

  return (
    <div className="plugin-prompt-overlay" onClick={onClose}>
      <div className="plugin-prompt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="plugin-prompt-header">
          <h3>Install a plugin</h3>
          <button className="plugin-prompt-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="plugin-prompt-body">
          <p className="plugin-prompt-desc">
            Rattin is intentionally minimal on its own. To play this title you need a
            plugin from the registry. Plugins are signed and reviewed before they're
            listed.
          </p>
          {entry ? (
            <div className="plugin-prompt-card">
              <div className="plugin-prompt-card-name">{entry.name}</div>
              <div className="plugin-prompt-card-desc">{entry.description}</div>
              <div className="plugin-prompt-card-version mono">v{entry.version}</div>
              <button className="plugin-prompt-install-btn" onClick={handleInstall} disabled={installing}>
                {installing ? "Installing…" : "Install"}
              </button>
            </div>
          ) : (
            <p className="plugin-prompt-empty">No plugins available. Check your connection and try again.</p>
          )}
          {error && <p className="plugin-prompt-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
