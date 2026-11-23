import { useT } from '../../i18n/useT';
import { commands } from '../../tauri';
import { useHoverTip } from '../common/HoverTip';

/** 安装 on a tool that isn't installed: EchoBird's assistant installs and sets it up (environment, sign-in, models),
 *  as 切换模型 sends you there. Its own component, so the tip's state stays here (not in the whole start page) and
 *  goes with the chip when the tool turns up installed. */
export function InstallChip({ tool }: { tool: string }) {
  const t = useT();
  const { tipFor, tip } = useHoverTip();
  const tipText = t('launchpad.install_tip', { tool });
  const handlers = tipFor(tipText);
  return <>
    <button type="button" className="launchpad-install" aria-label={`${t('launchpad.install')} ${tool}`} aria-description={tipText}
      {...handlers}
      // The tip on focus only from the keyboard: a click leaves focus here, and coming back to the window would show it.
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) handlers.onFocus(event); }}
      onClick={event => { event.stopPropagation(); event.currentTarget.blur(); commands.openUrl('https://echobird.ai/').catch(() => {}); }}>
      {t('launchpad.install')}
    </button>
    {tip}
  </>;
}
