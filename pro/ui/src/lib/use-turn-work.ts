// Hooks behind a finished turn's fold row and changed-files card (components/center/TurnWork.tsx).
import { useCallback, useContext, useMemo, useState } from 'react';
import { useAppState } from '../store/app-state';
import { commands } from '../tauri';
import { ConversationDirectory } from './conversation-links';
import { absoluteToolPath, changedFiles, changedFileSelection, turnFolds, type ChangedFile, type TurnFold, type TurnWorkMessage } from './turn-work';

/** Opens a file a turn changed in the diff view: its uncommitted diff while git has one, else the file itself. */
export function useOpenChangedFile() {
  const cwd = useContext(ConversationDirectory);
  const { dispatch } = useAppState();
  return useCallback((path: string) => {
    const folder = cwd ?? absoluteToolPath(path, null).replace(/\/[^/]*$/, '');
    void commands.gitChanges(folder).catch(() => null).then(changes => dispatch({ type: 'SET_DIFF_SELECTION', selection: changedFileSelection(path, cwd, changes) }));
  }, [cwd, dispatch]);
}

// Which finished turns are unfolded, kept outside the rows so a remounted row keeps it.
const openTurnFolds = new Set<string>();

/** A finished turn folds its work into 「工作了 45 秒」 and lists the files it changed after its reply. */
export function useTurnFolds(messages: readonly (TurnWorkMessage & { id: string })[], busy: boolean) {
  const [, setVersion] = useState(0);
  const folds = useMemo(() => {
    const { lead } = turnFolds(messages, busy);
    const owner = new Map<number, TurnFold>(), byReply = new Map<number, ChangedFile[]>();
    for (const fold of lead.values()) {
      for (let i = fold.start; i <= fold.end; i++) owner.set(i, fold);
      const files = changedFiles(messages.slice(fold.start, fold.end + 1));
      if (files.length && fold.reply !== undefined) byReply.set(fold.reply, files);
    }
    return { owner, byReply };
  }, [messages, busy]);
  const key = (fold: TurnFold) => messages[fold.start]?.id ?? '';
  return {
    ...folds,
    isOpen: (fold: TurnFold) => openTurnFolds.has(key(fold)),
    toggle: (fold: TurnFold) => { const k = key(fold); if (!openTurnFolds.delete(k)) openTurnFolds.add(k); setVersion(v => v + 1); },
  };
}
