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
        <h2>TMDB API Key Required</h2>
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
            className="pair-create-btn"
            onClick={handleSave}
            disabled={saving || !apiKey.trim()}
          >
            {saving ? "Verifying..." : "Save & Continue"}
          </button>
        </div>
        {error && <p className="settings-error">{error}</p>}
      </div>
    </div>
  );
}
