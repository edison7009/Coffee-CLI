import { useCallback, useEffect, useRef, useState } from 'react';
import { clearTerminalInteraction, type TerminalInteraction } from '../../lib/terminal-interaction';
import { getTabActions } from '../../lib/tab-actions';
import { useT } from '../../i18n/useT';
import './TerminalInteractionCard.css';

interface TerminalInteractionCardProps {
  sessionId: string;
  interaction: TerminalInteraction;
  keyboardEnabled: boolean;
}

export function TerminalInteractionCard({
  sessionId,
  interaction,
  keyboardEnabled,
}: TerminalInteractionCardProps) {
  const t = useT();
  const [customIndex, setCustomIndex] = useState<number | null>(null);
  const [customText, setCustomText] = useState('');
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (customIndex !== null) inputRef.current?.focus();
  }, [customIndex]);

  const respond = useCallback((optionIndex: number, text?: string) => {
    const ok = getTabActions(sessionId)?.respondToInteraction({
      optionIndex,
      optionCount: interaction.options.length,
      customText: text,
    }) ?? false;
    if (!ok) {
      setFailed(true);
      return;
    }
    clearTerminalInteraction(sessionId);
  }, [interaction.options.length, sessionId]);

  const selectOption = useCallback((option: TerminalInteraction['options'][number]) => {
    setFailed(false);
    if (option.acceptsText) setCustomIndex(option.position);
    else respond(option.position);
  }, [respond]);

  const submitCustom = useCallback(() => {
    if (customIndex === null || !customText.trim()) return;
    respond(customIndex, customText.trim());
  }, [customIndex, customText, respond]);

  useEffect(() => {
    if (!keyboardEnabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (!/^[1-9]$/.test(event.key)) return;
      const option = interaction.options.find(item => item.number === Number(event.key));
      if (!option) return;
      event.preventDefault();
      event.stopPropagation();
      selectOption(option);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [interaction.options, keyboardEnabled, selectOption]);

  return (
    <section
      className={`terminal-interaction terminal-interaction--${interaction.kind}`}
      aria-labelledby={`terminal-interaction-${interaction.fingerprint}`}
    >
      <div className="terminal-interaction-heading">
        <span className="terminal-interaction-icon" aria-hidden="true">
          {interaction.kind === 'permission' ? '!' : '?'}
        </span>
        <div>
          <div className="terminal-interaction-eyebrow">
            {t(interaction.kind === 'permission' ? 'interaction.permission' : 'interaction.question')}
          </div>
          <div
            id={`terminal-interaction-${interaction.fingerprint}`}
            className="terminal-interaction-title"
          >
            {interaction.title}
          </div>
        </div>
      </div>

      <div className="terminal-interaction-options">
        {interaction.options.map(option => {
          const expanded = customIndex === option.position;
          return (
            <div className="terminal-interaction-option-wrap" key={`${option.number}:${option.label}`}>
              <button
                type="button"
                className={`terminal-interaction-option${expanded ? ' is-expanded' : ''}${option.focused ? ' is-native-selected' : ''}`}
                aria-keyshortcuts={String(option.number)}
                onClick={() => selectOption(option)}
              >
                <span className="terminal-interaction-number">{option.number}</span>
                <span className="terminal-interaction-label">{option.label}</span>
                {option.acceptsText && <span className="terminal-interaction-pencil" aria-hidden="true">✎</span>}
              </button>
              {option.acceptsText && expanded && (
                <div className="terminal-interaction-custom">
                  <textarea
                    ref={inputRef}
                    value={customText}
                    rows={2}
                    placeholder={t('interaction.custom_placeholder')}
                    onChange={event => setCustomText(event.target.value)}
                    onKeyDown={event => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        submitCustom();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="terminal-interaction-submit"
                    disabled={!customText.trim()}
                    onClick={submitCustom}
                  >
                    {t('interaction.submit')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {failed && <div className="terminal-interaction-error" role="status">{t('interaction.failed')}</div>}
    </section>
  );
}
