import { useState } from 'react';
import { LLM_PRESETS } from './llm-presets';
import type { LLMConfig } from './llm-translate';

interface TranslateSettingsProps {
  initialConfig: LLMConfig;
  onSave: (config: LLMConfig) => void;
  onClose: () => void;
}

export function TranslateSettings({ initialConfig, onSave, onClose }: TranslateSettingsProps) {
  const [draft, setDraft] = useState<LLMConfig>(initialConfig);
  const [activePreset, setActivePreset] = useState<string | null>(() => {
    const match = LLM_PRESETS.find(p => p.baseUrl === initialConfig.baseUrl);
    return match?.id ?? null;
  });

  const apiKeyUrl = LLM_PRESETS.find(p => p.id === activePreset)?.apiKeyUrl ?? null;

  function selectPreset(id: string) {
    const preset = LLM_PRESETS.find(p => p.id === id);
    if (!preset) return;
    setActivePreset(id);
    setDraft(prev => ({ ...prev, baseUrl: preset.baseUrl, model: preset.model }));
  }

  function handleSave() {
    if (!draft.baseUrl.trim() || !draft.apiKey.trim() || !draft.model.trim()) return;
    onSave(draft);
  }

  return (
    <div className="ts-backdrop" onClick={onClose}>
      <div className="ts-panel" onClick={e => e.stopPropagation()}>

        <div className="ts-header">
          <span className="ts-title">Translate Settings</span>
          <button className="ts-close" onClick={onClose}>✕</button>
        </div>

        <div className="ts-section-label">Provider</div>
        <div className="ts-presets">
          {LLM_PRESETS.map(p => (
            <button
              key={p.id}
              className={`ts-preset-btn${activePreset === p.id ? ' active' : ''}`}
              onClick={() => selectPreset(p.id)}
            >
              {p.name}
              {p.free && <span className="ts-free-tag">free</span>}
            </button>
          ))}
        </div>

        <div className="ts-fields">
          <div className="ts-field">
            <label className="ts-label">Base URL</label>
            <input
              className="ts-input"
              value={draft.baseUrl}
              onChange={e => { setActivePreset(null); setDraft(prev => ({ ...prev, baseUrl: e.target.value })); }}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
            />
          </div>

          <div className="ts-field">
            <label className="ts-label">API Key</label>
            <input
              className="ts-input"
              type="password"
              value={draft.apiKey}
              onChange={e => setDraft(prev => ({ ...prev, apiKey: e.target.value }))}
              placeholder="sk-..."
              spellCheck={false}
            />
            {apiKeyUrl && (
              <button
                className="ts-key-link"
                onClick={() => window.open(apiKeyUrl, '_blank')}
              >
                Get API Key →
              </button>
            )}
          </div>

          <div className="ts-field">
            <label className="ts-label">Model</label>
            <input
              className="ts-input"
              value={draft.model}
              onChange={e => setDraft(prev => ({ ...prev, model: e.target.value }))}
              placeholder="gpt-4o-mini"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="ts-actions">
          <button className="ts-btn-cancel" onClick={onClose}>Cancel</button>
          <button
            className="ts-btn-save"
            onClick={handleSave}
            disabled={!draft.baseUrl.trim() || !draft.apiKey.trim() || !draft.model.trim()}
          >
            Save
          </button>
        </div>

      </div>
    </div>
  );
}
