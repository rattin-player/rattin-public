import { useState } from "react";
import { setTmdbConfig } from "../lib/api";
import "./SettingsModal.css";

interface TmdbSetupProps {
  onComplete: () => void;
}

export default function TmdbSetup({ onComplete }: TmdbSetupProps) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError("");
    try {
      await setTmdbConfig(apiKey.trim());
      onComplete();
    } catch (e) {
      setError((e as Error).message || "Failed to save key");
    }
    setSaving(false);
  }

  return (
    <div className="tmdb-setup-overlay">
      <div className="tmdb-setup-modal">
        <span className="app-eyebrow">First-time setup</span>
        <h2>TMDB API key</h2>
        <p>
          Rattin uses <a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer">TMDB</a> for
          movie and TV metadata. The app won't work without it.
        </p>
        <p>
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer" className="settings-link">
            Get a free API key from TMDB
          </a>{" "}
          (requires a free account).
        </p>
        <div className="settings-form">
          <input
            className="settings-input"
            type="password"
            placeholder="Paste your TMDB API key (v3 auth)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            autoComplete="off"
            autoFocus
          />
          <button
            className="settings-btn settings-btn-primary settings-btn-full"
            onClick={handleSave}
            disabled={saving || !apiKey.trim()}
          >
            {saving ? "Verifying..." : "Save & Continue"}
          </button>
        </div>
        {error && (
          <div className="app-status-bar is-error">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
