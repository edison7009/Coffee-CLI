import { useEffect } from 'react';
import type { AppState } from '../store/app-state';
import { splitSessionIds } from './session-split-layout';
import { onWindowBackground, onWindowForeground } from './window-focus-filter';
import { updateSessionReplyReaders } from './session-replies';

export function useSessionReplyVisibility(state: AppState) {
  const { terminals, activeTerminalId, sessionSplit, usageOpen, toolSettingsOpen, diffTabActive, agentPageActive, settingsOpen } = state;
  useEffect(() => {
    const ids = splitSessionIds(sessionSplit);
    const shown = usageOpen || toolSettingsOpen || diffTabActive || agentPageActive || settingsOpen || !activeTerminalId ? []
      : ids.length > 1 && ids.includes(activeTerminalId) ? ids : [activeTerminalId];
    const update = () => updateSessionReplyReaders(terminals, shown);
    update();
    const foreground = onWindowForeground(update), background = onWindowBackground(update);
    document.addEventListener('visibilitychange', update);
    return () => { foreground(); background(); document.removeEventListener('visibilitychange', update); };
  }, [terminals, activeTerminalId, sessionSplit, usageOpen, toolSettingsOpen, diffTabActive, agentPageActive, settingsOpen]);
}
