// src/components/PluginPrompt.tsx
import { useState, useEffect } from "react";
import { getPluginIndex, installPlugin } from "../lib/api";
import "./PluginPrompt.css";

interface PluginPromptProps {
  onInstalled: () => void;
  onClose: () => void;
}

export default function PluginPrompt({ onInstalled, onClose }: PluginPromptProps) {
  const [entry, setEntry] = useState<{
    downloadUrl: string; sha256: string; version: string; apiVersion: number;
  } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getPluginIndex().then((index) => {
      const compatible = index
        .filter((e: { apiVersion?: number }) => (e.apiVersion ?? 1) === 1)
        .sort((a: { version: string }, b: { version: string }) => b.version.localeCompare(a.version));
      if (compatible.length > 0) setEntry(compatible[0]);
    }).catch(() => {});
  }, []);

  async function handleInstall() {
    if (!entry) return;
    setInstalling(true);
    setError("");
    try {
      await installPlugin(entry.downloadUrl, {
        id: "community", name: "Community Content Source", description: "Search and play from multiple sources",
        author: "community", downloadUrl: entry.downloadUrl,
        sha256: entry.sha256, version: entry.version, apiVersion: entry.apiVersion,
      });
      onInstalled();
    } catch {
      setError("Installation failed. Please try again.");
    }
    setInstalling(false);
  }

  return (
    <div className="plugin-prompt-overlay" onClick={onClose}>
      <div className="plugin-prompt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="plugin-prompt-header">
          <h3>Install Content Source Plugin</h3>
          <button className="plugin-prompt-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="plugin-prompt-body">
          <p className="plugin-prompt-desc">
            Install a community-made and verified content source plugin to enable search and play.
            The plugin runs locally on your machine.
          </p>
          {entry ? (
            <button className="plugin-prompt-install-btn" onClick={handleInstall} disabled={installing}>
              {installing ? "Installing content source plugin..." : "Install Content Source Plugin"}
            </button>
          ) : (
            <p className="plugin-prompt-empty">No compatible content sources available. Check your connection and try again.</p>
          )}
          {error && <p className="plugin-prompt-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
