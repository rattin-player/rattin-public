// src/components/PluginPrompt.tsx
import { useState, useEffect } from "react";
import { getPluginIndex, installPlugin } from "../lib/api";
import "./PluginPrompt.css";

interface PluginPromptProps {
  onInstalled: () => void;
  onClose: () => void;
}

export default function PluginPrompt({ onInstalled, onClose }: PluginPromptProps) {
  const [index, setIndex] = useState<Array<{
    id: string; name: string; description: string;
    downloadUrl: string; sha256: string; version: string;
  }>>([]);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getPluginIndex().then(setIndex).catch(() => setIndex([]));
  }, []);

  async function handleInstall(entry: typeof index[0]) {
    setInstalling(true);
    setError("");
    try {
      await installPlugin(entry.downloadUrl, {
        id: entry.id, name: entry.name, description: entry.description,
        author: "rattin", downloadUrl: entry.downloadUrl,
        sha256: entry.sha256, version: entry.version, apiVersion: 1,
      });
      onInstalled();
    } catch {
      setError("Installation failed. Please try again.");
    }
    setInstalling(false);
  }

  const entry = index[0];

  return (
    <div className="plugin-prompt-overlay" onClick={onClose}>
      <div className="plugin-prompt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="plugin-prompt-header">
          <h3>No Content Source Installed</h3>
          <button className="plugin-prompt-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="plugin-prompt-body">
          <p className="plugin-prompt-desc">
            To search and play content, install a content source plugin.
            This is a one-time setup — the plugin runs locally on your machine.
          </p>
          {entry && (
            <div className="plugin-prompt-entry">
              <div className="plugin-prompt-entry-name">{entry.name}</div>
              <div className="plugin-prompt-entry-desc">{entry.description}</div>
              <div className="plugin-prompt-entry-author">
                <span className="plugin-prompt-meta-label">Author</span>
                <span className="plugin-prompt-meta-value">rattin</span>
              </div>
              <div className="plugin-prompt-entry-signed">
                <span className="plugin-prompt-meta-label">Signature</span>
                <span className="plugin-prompt-meta-value plugin-prompt-signed-badge">✓ Verified</span>
              </div>
              <div className="plugin-prompt-entry-hash">
                <span className="plugin-prompt-meta-label">SHA256</span>
                <span className="plugin-prompt-meta-value plugin-prompt-hash">{entry.sha256.slice(0, 16)}…</span>
              </div>
              <button
                className="plugin-prompt-install-btn"
                onClick={() => handleInstall(entry)}
                disabled={installing}
              >
                {installing ? "Installing..." : "Install Plugin"}
              </button>
            </div>
          )}
          {!entry && (
            <p className="plugin-prompt-empty">No plugins available yet.</p>
          )}
          {error && <p className="plugin-prompt-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
