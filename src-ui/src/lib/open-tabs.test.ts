import { parseOpenTabs, serializeOpenTabs } from './open-tabs';
import type { TerminalSession } from '../store/app-state';

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export async function main(): Promise<void> {
  const tab = (id: string, extra: Partial<TerminalSession>): TerminalSession => ({ id, tool: null, folderPath: 'E:/work', ...extra });
  const terminals = [
    tab('a', { tool: 'claude', resumeToken: 'tok-a', claudeMode: 'terminal', pinnedTitle: '重构' }),
    tab('b', { tool: 'codex' }),
    tab('c', { tool: 'terminal', resumeToken: 'ignored' }),
    tab('d', { tool: 'remote', toolData: '{"host":"x"}', resumeToken: 'tok-d' }),
    tab('e', { tool: 'claude', resumeToken: 'tok-e', isHidden: true }),
    tab('f', {}),
    tab('g', { tool: 'codex', resumeToken: 'tok-g', parentId: 'a' }),
  ];
  const text = serializeOpenTabs({ terminals, tabOrder: ['c', 'a', 'b', 'd', 'e', 'f', 'g'], activeTerminalId: 'a' });
  check(!text.includes('host'), 'SSH connection data is never saved');
  const restored = parseOpenTabs(text);
  check(!!restored, 'tabs restore');
  const tabs = restored!.terminals;
  check(tabs.length === 2, 'only resumable tool tabs and plain shells return');
  check(tabs[0].tool === 'terminal' && !tabs[0].resumeToken, 'a shell restores fresh, in tab order');
  check(tabs[1].tool === 'claude' && tabs[1].resumeToken === 'tok-a' && tabs[1].pinnedTitle === '重构' && tabs[1].claudeMode === 'terminal', 'a tool tab resumes its own session');
  check(restored!.activeId === tabs[1].id && !tabs.some(item => item.id === 'a'), 'active tab follows with a fresh id');
  check(parseOpenTabs('not json') === null && parseOpenTabs('[]') === null && parseOpenTabs('[{"tool":"claude","folderPath":"E:/w"}]') === null, 'nothing unusable restores');
  console.log('open tabs: ok');
}
