import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { commands, invoke } from '../../tauri';
import { useAppState, type AgentPage } from '../../store/app-state';
import { formatAgentActivity, formatAgentError, formatAgentMessage, loadOlderAgentMessages, refreshChannels, sendAgentMessage, startNewAgentConversation, useAgentClient } from '../../lib/agent-client';
import { useT } from '../../i18n/useT';
import type { I18nKey } from '../../i18n/en';
import { clipboardRead, clipboardWrite } from '../../lib/clipboard';
import { useTextContextMenu } from '../../lib/use-text-context-menu';
import { MarkdownContent } from '../center/MarkdownContent';
import { Gambit } from '../center/Gambit';
import { ConversationNavigation, MessageCopyButton, type ConversationNavigationItem } from '../center/ConversationControls';
import '../center/ConversationView.css';
import '../common/SettingsModal.css';
import './AgentPages.css';

function AgentSelect<Value extends string>({ value, options, onChange, label, className = '' }: {
  value: Value; options: { value: Value; label: string }[]; onChange: (value: Value) => void; label: string; className?: string;
}) {
  const { state } = useAppState();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const visible = open && state.agentPageActive === 'config';
  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = Math.min(options.length * 34 + 10, 320);
    setPosition({ left: rect.left, top: rect.bottom + height + 4 > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : rect.bottom + 4, width: rect.width });
  }, [options.length]);
  const toggle = () => { if (!open) reposition(); setOpen(!open); };

  useEffect(() => {
    if (state.agentPageActive !== 'config') return;
    return () => setOpen(false);
  }, [state.agentPageActive]);

  useEffect(() => {
    if (!visible) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); };
  }, [visible, reposition]);

  return <>
    <button type="button" ref={triggerRef} className={`settings-font-trigger agent-select-trigger ${className}`} role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={visible} aria-controls={visible ? menuId : undefined} onClick={toggle} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) toggle(); }
    }}>
      <span className="settings-font-current">{options.find(option => option.value === value)?.label}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    {visible && createPortal(<>
      <div className="settings-font-backdrop" onClick={() => setOpen(false)} />
      <div ref={menuRef} id={menuId} className="settings-font-menu" role="listbox" aria-label={label} style={{ position: 'fixed', ...position }} onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
        <div className="settings-font-list">{options.map(option => <button type="button" key={option.value} className={`settings-font-opt${value === option.value ? ' active' : ''}`} role="option" aria-selected={value === option.value} onClick={() => {
          if (option.value !== value) onChange(option.value);
          setOpen(false); triggerRef.current?.focus();
        }}>{option.label}</button>)}</div>
      </div>
    </>, document.body)}
  </>;
}

function PageFrame({ page, children }: { page: AgentPage; children: ReactNode }) {
  const t = useT();
  return <section className={`agent-page agent-page-${page}`} aria-label={page === 'agent' ? 'Coffee Agent' : t('agent.page.settings')}>
    {children}
  </section>;
}

function AgentChatPage() {
  const t = useT();
  const { state } = useAppState();
  const { conversationId, messages, hasOlder, loadingOlder, running, activity, error } = useAgentClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = conversationId || 'desktop';
  const draft = drafts[draftKey] ?? '';
  const setDraft = (text: string) => setDrafts(current => ({ ...current, [draftKey]: text }));
  const [localError, setLocalError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [navigationItems, setNavigationItems] = useState<ConversationNavigationItem[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const prependAnchorRef = useRef<{ messageId: number; scrollTop: number; messageTop: number } | null>(null);
  const followOutput = useRef(true);
  useLayoutEffect(() => { followOutput.current = true; prependAnchorRef.current = null; }, [conversationId]);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const scroll = threadRef.current;
    const anchor = prependAnchorRef.current;
    if (!scroll || !anchor || messages[0]?.id === anchor.messageId) return;
    prependAnchorRef.current = null;
    const row = scroll.querySelector<HTMLElement>(`[data-conversation-navigation-id="${CSS.escape(String(anchor.messageId))}"]`);
    if (row) scroll.scrollTop = anchor.scrollTop + row.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - anchor.messageTop;
  }, [messages]);

  useLayoutEffect(() => {
    const scroll = threadRef.current;
    if (!scroll) return;
    const measure = () => {
      if (scroll.clientHeight === 0) return;
      const scrollTop = scroll.getBoundingClientRect().top;
      const rows = new Map(Array.from(scroll.querySelectorAll<HTMLElement>('[data-conversation-navigation-id]')).map(row => [row.dataset.conversationNavigationId, row]));
      const next = messages.flatMap((message, messageIndex) => {
        if (message.role !== 'user') return [];
        const id = String(message.id);
        const row = rows.get(id);
        return row ? [{ id, sourceMessageId: id, content: message.text, messageIndex, top: row.getBoundingClientRect().top - scrollTop + scroll.scrollTop, cursor: null }] : [];
      });
      setNavigationItems(current => current.length === next.length && current.every((item, index) => item.id === next[index].id && item.top === next[index].top && item.content === next[index].content && item.messageIndex === next[index].messageIndex) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    if (messageListRef.current) observer.observe(messageListRef.current);
    return () => observer.disconnect();
  }, [messages, running, state.agentPageActive]);

  useEffect(() => {
    if (followOutput.current && threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, running, activity]);

  const jumpToMessage = useCallback((item: ConversationNavigationItem) => {
    const scroll = threadRef.current;
    const row = scroll?.querySelector<HTMLElement>(`[data-conversation-navigation-id="${CSS.escape(item.sourceMessageId)}"]`);
    if (!scroll || !row) return;
    followOutput.current = false;
    scroll.scrollTo({ top: row.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop, behavior: 'auto' });
  }, []);

  const copyMessage = (messageId: number, content: string) => {
    const key = `${conversationId}:${messageId}`;
    void clipboardWrite(content).then(() => {
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
      setCopiedMessageId(key);
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedMessageId(current => current === key ? null : current);
        copyResetTimerRef.current = null;
      }, 1_500);
    });
  };

  const loadOlder = async () => {
    const scroll = threadRef.current;
    const first = messages[0];
    const row = first && scroll?.querySelector<HTMLElement>(`[data-conversation-navigation-id="${CSS.escape(String(first.id))}"]`);
    followOutput.current = false;
    prependAnchorRef.current = scroll && row ? { messageId: first.id, scrollTop: scroll.scrollTop, messageTop: row.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop } : null;
    try { await loadOlderAgentMessages(); }
    catch (failure) { prependAnchorRef.current = null; setLocalError(String(failure)); }
  };

  const send = async (prompt: string): Promise<boolean> => {
    const text = prompt.trim();
    if (!text || running) return false;
    setLocalError('');
    followOutput.current = true;
    try { await sendAgentMessage(text); return true; }
    catch (failure) { setLocalError(String(failure)); return false; }
  };
  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    setLocalError('');
    try { await invoke('agent_cancel', { conversationId: conversationId || 'desktop' }); }
    catch (failure) { setLocalError(String(failure)); }
    finally { setCancelling(false); }
  };

  const startNew = () => { setLocalError(''); startNewAgentConversation().catch(failure => setLocalError(String(failure))); };

  const newChat = messages.length > 0 && <button type="button" className="gambit-new-chat" disabled={running} onClick={startNew}>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>{t('agent.chat.new')}
  </button>;

  return <PageFrame page="agent">
    <div className={`conversation-view agent-chat-surface${navigationItems.length > 1 ? ' agent-chat-surface--has-navigation' : ''}`}>
    {navigationItems.length > 1 && state.agentPageActive === 'agent' && <ConversationNavigation items={navigationItems} scrollRef={threadRef} onJump={jumpToMessage} />}
    <div className="agent-chat-thread" ref={threadRef} onScroll={() => {
      const node = threadRef.current;
      if (node) followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    }}>
      {hasOlder && <button type="button" className="agent-button quiet" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? t('agent.chat.loading') : t('agent.chat.older')}</button>}
      {messages.length === 0 ? <div className="agent-welcome">
        <h2>Coffee Agent</h2>
        <p>{t('agent.chat.welcome')}</p>
        <div className="agent-suggestions">{[t('agent.chat.suggestion.terminals'), t('agent.chat.suggestion.progress'), t('agent.chat.suggestion.history')].map(text =>
          <button type="button" key={text} onClick={() => { setDraft(text); document.querySelector<HTMLTextAreaElement>('.gambit-textarea')?.focus(); }}>{text}<span aria-hidden="true">↗</span></button>)}</div>
      </div> : <div className="agent-message-list" ref={messageListRef}>{messages.map((message, index) =>
        <article className={`conversation-message conversation-message--${message.role}`} data-conversation-navigation-id={String(message.id)} aria-label={message.role === 'user' ? t('agent.chat.user') : 'Coffee Agent'} key={message.id}>
          {!!message.tools?.length && <details className="agent-tool-summary">
            <summary>{t('agent.chat.tools', { count: message.tools.length })}{message.tools.some(tool => !tool.ok) ? ` · ${t('agent.chat.tools_failed', { count: message.tools.filter(tool => !tool.ok).length })}` : ''}</summary>
            <ol>{message.tools.map((tool, i) => <li key={i} className={tool.ok ? undefined : 'failed'}><span aria-hidden="true">{tool.ok ? '✓' : '✕'}</span><code>{tool.name}</code></li>)}</ol>
          </details>}
          <div className="conversation-bubble"><MarkdownContent content={message.role === 'assistant' ? formatAgentMessage(message.text, t) : message.text} /></div>
          {(message.role === 'user' || !running || index < messages.length - 1) && <MessageCopyButton copied={copiedMessageId === `${conversationId}:${message.id}`} onCopy={() => copyMessage(message.id, message.role === 'assistant' ? formatAgentMessage(message.text, t) : message.text)} />}
        </article>)}
        {running && <div className="agent-activity" role="status"><span className="agent-working-dot" />{formatAgentActivity(activity, t) || t('agent.activity.thinking')}</div>}
      </div>}
    </div>
    </div>
    {(localError || error) && <p className="agent-chat-feedback agent-feedback error" role="alert">{formatAgentError(localError || error, t)}</p>}
    {state.agentPageActive === 'agent' && <Gambit
      sessionId={`coffee-agent:${conversationId || 'desktop'}`} draft={draft} onDraftChange={setDraft}
      onClose={() => {}} onSend={send} running={running}
      onCancel={cancelling ? undefined : () => void cancel()}
      sendFailedHint={t('agent.chat.send_failed')}
      workspaceName="Coffee Agent" worktreeControl={newChat}
      leftPanelHidden={state.leftPanelHidden} rightPanelHidden={state.rightPanelHidden}
    />}
  </PageFrame>;
}

/** A plain text field with the shared right-click menu and a paste button inside its right edge. */
function AgentPasteInput({ label, value, onValue, openMenu, ...input }: {
  label: string; value: string; onValue: (value: string) => void;
  openMenu: ReturnType<typeof useTextContextMenu>['openMenu'];
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const t = useT();
  // Pasting replaces the whole value: copied URLs and keys often carry a trailing newline.
  const paste = () => void clipboardRead().then(text => { const next = text.trim(); if (next) onValue(next); });
  return <label className="agent-field"><span>{label}</span><span className="agent-paste-input">
    <input {...input} aria-label={label} value={value} spellCheck={false} onChange={event => onValue(event.target.value)} onContextMenu={event => openMenu(event, onValue)} />
    <button type="button" aria-label={`${t('menu.paste')} ${label}`} onClick={paste}>{t('menu.paste')}</button>
  </span></label>;
}

interface ModelSettings {
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  apiKey: string;
}
const DEFAULT_URL = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' };

function AgentModelSection() {
  const t = useT();
  const [config, setConfig] = useState<ModelSettings>({ provider: 'openai', baseUrl: DEFAULT_URL.openai, model: '', apiKey: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<I18nKey | ''>('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    invoke<ModelSettings>('agent_get_model').then(value => {
      if (active) setConfig(value);
    }).catch(failure => { if (active) setError(String(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const { menu, openMenu } = useTextContextMenu();
  const setBaseUrl = (baseUrl: string) => { setConfig(current => ({ ...current, baseUrl })); setFeedback(''); };
  const setModel = (model: string) => { setConfig(current => ({ ...current, model })); setFeedback(''); };
  const setKey = (apiKey: string) => { setConfig(current => ({ ...current, apiKey })); setFeedback(''); };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(''); setFeedback('');
    try {
      await invoke('agent_save_model', { config: { provider: config.provider, baseUrl: config.baseUrl.trim(), model: config.model.trim(), apiKey: config.apiKey.trim() } });
      const next = await invoke<ModelSettings>('agent_get_model');
      setConfig(next); setFeedback('agent.model.saved');
    } catch (failure) { setError(String(failure)); }
    finally { setSaving(false); }
  };

  return <section className="agent-settings-section">
      <h2>{t('agent.model.title')}</h2>
      <form className="agent-model-form" onSubmit={save}>
        <fieldset disabled={loading || saving}>
          <label className="agent-field"><span>{t('agent.model.provider')}</span><AgentSelect label={t('agent.model.provider')} value={config.provider} options={[{ value: 'openai', label: t('agent.model.provider_openai') }, { value: 'anthropic', label: t('agent.model.provider_anthropic') }]} onChange={provider => {
            setConfig({ ...config, provider, baseUrl: DEFAULT_URL[provider] }); setFeedback('');
          }} /></label>
          <AgentPasteInput label={t('agent.model.url')} type="url" value={config.baseUrl} placeholder={DEFAULT_URL[config.provider]} onValue={setBaseUrl} openMenu={openMenu} />
          <AgentPasteInput label={t('agent.model.id')} value={config.model} maxLength={200} placeholder={t('agent.model.id_placeholder')} onValue={setModel} openMenu={openMenu} />
          <AgentPasteInput label={t('agent.model.api_key')} value={config.apiKey} autoComplete="off" placeholder={t('agent.model.api_key_placeholder')} onValue={setKey} openMenu={openMenu} />
          <div className="agent-form-footer"><button type="submit" className="agent-button primary">{saving ? t('agent.model.saving') : t('agent.model.save')}</button><span className="agent-feedback" role="status">{loading ? t('agent.model.loading') : feedback && t(feedback)}</span></div>
        </fieldset>
        {error && <p className="agent-feedback error" role="alert">{formatAgentError(error, t)}</p>}
      </form>
      {menu}
  </section>;
}

interface WorkModes { sentinel: boolean; projectManager: boolean; expertConfig: boolean }
type WorkMode = keyof WorkModes;

function AgentModeRow({ title, description, enabled, saving, onToggle }: {
  title: string; description: string; enabled: boolean | null; saving: boolean; onToggle: () => void;
}) {
  const { state } = useAppState();
  const id = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const visible = (hovered || focused) && !dismissed && state.agentPageActive === 'config';
  const reposition = useCallback(() => {
    const row = rowRef.current?.getBoundingClientRect();
    const node = tipRef.current;
    if (!row || !node) return;
    const tip = node.getBoundingClientRect();
    const left = Math.max(8, Math.min(row.right - tip.width, window.innerWidth - tip.width - 8));
    const below = row.bottom + 6;
    const preferredTop = below + tip.height <= window.innerHeight - 8 ? below : row.top - tip.height - 6;
    const top = Math.max(8, Math.min(preferredTop, window.innerHeight - tip.height - 8));
    node.style.left = `${left}px`; node.style.top = `${top}px`; node.style.visibility = 'visible';
  }, []);

  useLayoutEffect(() => {
    if (!visible) return;
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); };
  }, [visible, description, reposition]);

  return <div ref={rowRef} className="agent-mode-row" onMouseEnter={() => { setHovered(true); setDismissed(false); }} onMouseLeave={() => setHovered(false)} onKeyDown={event => { if (event.key === 'Escape') setDismissed(true); }}>
    <span id={`${id}-label`}>{title}</span>
    <span id={`${id}-description`} className="agent-mode-description">{description}</span>
    <button type="button" className={`library-toggle agent-mode-switch${enabled ? ' on' : ''}`} role="switch" aria-checked={enabled === true} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} aria-busy={saving || undefined} aria-disabled={enabled === null || saving} disabled={enabled === null} onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)} onClick={onToggle}><span className="library-toggle-knob" aria-hidden="true" /></button>
    {visible && createPortal(<div ref={tipRef} className="agent-mode-tip" role="tooltip" style={{ visibility: 'hidden' }}>{description}</div>, document.body)}
  </div>;
}

function AgentWorkModesSection() {
  const t = useT();
  const { state } = useAppState();
  const [english, setEnglish] = useState<boolean | null>(null);
  const [modes, setModes] = useState<WorkModes | null>(null);
  const [saving, setSaving] = useState<WorkMode | 'english' | null>(null);
  const savingRef = useRef(false);
  const modesRevisionRef = useRef(0);
  const englishRevisionRef = useRef(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (state.agentPageActive !== 'config') return;
    let active = true;
    const revision = modesRevisionRef.current;
    const englishRevision = englishRevisionRef.current;
    void invoke<boolean>('agent_get_english_delegation').then(value => {
      if (active && englishRevision === englishRevisionRef.current) setEnglish(value);
    }).catch(failure => { if (active) setError(String(failure)); });
    void invoke<WorkModes>('agent_get_work_modes').then(value => {
      if (active && revision === modesRevisionRef.current) setModes(value);
    }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [state.agentPageActive]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const stop = await listen<WorkModes>('agent-work-modes', event => {
        if (active) { modesRevisionRef.current += 1; setModes(event.payload); }
      });
      if (active) unlisten = stop;
      else stop();
    }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; unlisten?.(); };
  }, []);

  const toggle = async (mode: WorkMode | 'english') => {
    const enabled = mode === 'english' ? english : modes?.[mode];
    if (enabled == null || savingRef.current) return;
    savingRef.current = true;
    setSaving(mode); setError('');
    try {
      if (mode === 'english') { await invoke('agent_set_english_delegation', { enabled: !enabled }); englishRevisionRef.current += 1; setEnglish(!enabled); }
      else {
        const revision = modesRevisionRef.current;
        const next = await invoke<WorkModes>('agent_set_work_mode', { mode, enabled: !enabled });
        if (revision === modesRevisionRef.current) setModes(next);
      }
    }
    catch (failure) { setError(String(failure)); }
    finally { savingRef.current = false; setSaving(null); }
  };

  return <section className="agent-settings-section">
    <h2>{t('agent.modes.title')}</h2>
    <div className="agent-mode-list">
      <AgentModeRow title={t('agent.delegation.title')} description={`${t('agent.delegation.description')} ${t('agent.delegation.status')}`} enabled={english} saving={saving !== null} onToggle={() => void toggle('english')} />
      <AgentModeRow title={t('agent.modes.sentinel.title')} description={t('agent.modes.sentinel.description')} enabled={modes?.sentinel ?? null} saving={saving !== null} onToggle={() => void toggle('sentinel')} />
      <AgentModeRow title={t('agent.modes.project_manager.title')} description={t('agent.modes.project_manager.description')} enabled={modes?.projectManager ?? null} saving={saving !== null} onToggle={() => void toggle('projectManager')} />
      <AgentModeRow title={t('agent.modes.expert_config.title')} description={t('agent.modes.expert_config.description')} enabled={modes?.expertConfig ?? null} saving={saving !== null} onToggle={() => void toggle('expertConfig')} />
    </div>
    {error && <p className="agent-feedback error" role="alert">{formatAgentError(error, t)}</p>}
  </section>;
}

interface TelegramPairing { botName: string; pairingCode: string }
interface WeixinLogin { sessionId: string; qrDataUrl: string }
interface WeixinPoll { status: string; connected: boolean; message?: string }
const CHANNEL_STATUS: Record<string, I18nKey> = { disconnected: 'agent.channels.status.disconnected', connecting: 'agent.channels.status.connecting', waiting_pairing: 'agent.channels.status.waiting_pairing', waiting_scan: 'agent.channels.status.waiting_scan', connected: 'agent.channels.status.connected', error: 'agent.channels.status.error' };
const WEIXIN_LOGIN_STATUS: Record<string, I18nKey> = {
  start: 'agent.channels.login.start', wait: 'agent.channels.login.waiting_scan', waiting_scan: 'agent.channels.login.waiting_scan', scaned_but_redirect: 'agent.channels.login.waiting_scan',
  scaned: 'agent.channels.login.scaned', need_verifycode: 'agent.channels.login.need_verifycode', verify_code_blocked: 'agent.channels.login.verify_code_blocked',
  expired: 'agent.channels.login.expired', binded_redirect: 'agent.channels.login.binded_redirect', connected: 'agent.channels.feedback.weixin_connected',
};

function AgentChannelsSection() {
  const t = useT();
  const { state } = useAppState();
  const { channels } = useAgentClient();
  const [channelChoice, setSelectedChannel] = useState<'weixin' | 'telegram' | null>(null);
  const selectedChannel = channelChoice ?? (state.currentLang.startsWith('zh') ? 'weixin' : 'telegram');
  const [token, setToken] = useState('');
  const [pairing, setPairing] = useState<TelegramPairing | null>(null);
  const [login, setLogin] = useState<WeixinLogin | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [needsVerify, setNeedsVerify] = useState(false);
  const [loginStatus, setLoginStatus] = useState<Pick<WeixinPoll, 'status' | 'message'> | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<I18nKey | ''>('');
  const loginMessageKey = loginStatus && WEIXIN_LOGIN_STATUS[loginStatus.status];
  const loginMessage = loginMessageKey ? t(loginMessageKey) : loginStatus?.message || (loginStatus ? t('agent.channels.login.waiting_scan') : '');

  useEffect(() => {
    if (state.agentPageActive === 'config') refreshChannels().catch(failure => setError(String(failure)));
  }, [state.agentPageActive]);

  const acceptPoll = useCallback((result: WeixinPoll) => {
    setLoginStatus({ status: result.status, message: result.message });
    if (result.connected) {
      setLogin(null); setNeedsVerify(false); setVerifyCode(''); setFeedback('agent.channels.feedback.weixin_connected');
      refreshChannels().catch(failure => setError(String(failure)));
    } else if (result.status === 'need_verifycode') setNeedsVerify(true);
    else if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(result.status)) { setLogin(null); setNeedsVerify(false); }
    else setNeedsVerify(false);
  }, []);

  useEffect(() => {
    if (!login || needsVerify) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await invoke<WeixinPoll>('channel_weixin_poll', { sessionId: login.sessionId });
        if (!active) return;
        acceptPoll(result);
        if (!result.connected && !['need_verifycode', 'expired', 'verify_code_blocked', 'binded_redirect'].includes(result.status)) timer = setTimeout(() => void poll(), 2000);
      } catch (failure) { if (active) { setError(String(failure)); setLogin(null); } }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { active = false; clearTimeout(timer); };
  }, [login, needsVerify, acceptPoll]);

  const connectTelegram = async (event: FormEvent) => {
    event.preventDefault(); setBusy('telegram'); setError(''); setFeedback('');
    try {
      const result = await invoke<TelegramPairing>('channel_connect_telegram', { token: token.trim() });
      setPairing(result); setToken(''); await refreshChannels();
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(''); }
  };
  const connectWeixin = async () => {
    setBusy('weixin'); setError(''); setFeedback(''); setLogin(null); setNeedsVerify(false); setVerifyCode(''); setLoginStatus(null);
    try {
      const result = await invoke<{ sessionId: string; qrCodeUrl: string }>('channel_weixin_start');
      const qrDataUrl = await QRCode.toDataURL(result.qrCodeUrl, { width: 240, margin: 3, errorCorrectionLevel: 'M' });
      setLogin({ sessionId: result.sessionId, qrDataUrl }); setLoginStatus({ status: 'start' }); await refreshChannels();
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(''); }
  };
  const verify = async (event: FormEvent) => {
    event.preventDefault(); if (!login) return;
    setBusy('verify'); setError('');
    try { acceptPoll(await invoke<WeixinPoll>('channel_weixin_poll', { sessionId: login.sessionId, verifyCode: verifyCode.trim() })); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(''); }
  };
  const disconnect = async (channel: 'telegram' | 'weixin') => {
    setBusy(channel); setError(''); setFeedback('');
    try {
      await invoke('channel_disconnect', { channel });
      if (channel === 'telegram') setPairing(null);
      else { setLogin(null); setNeedsVerify(false); setLoginStatus(null); }
      await refreshChannels(); setFeedback(channel === 'weixin' ? 'agent.channels.feedback.weixin_disconnected' : 'agent.channels.feedback.telegram_disconnected');
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(''); }
  };

  return <section className="agent-settings-section">
    <div className="agent-section-heading"><h2>{t('agent.channels.title')}</h2><AgentSelect className="agent-channel-select" label={t('agent.channels.select')} value={selectedChannel} options={[{ value: 'weixin', label: t('agent.channels.weixin') }, { value: 'telegram', label: 'Telegram' }]} onChange={setSelectedChannel} /></div>
    <div className={`agent-channel-layout ${selectedChannel === 'weixin' && login ? '' : 'agent-channel-layout-single'}`}>
      <div className="agent-channel-list">
        {selectedChannel === 'weixin' ? <section className="agent-channel-row">
          <span className="agent-channel-mark weixin" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 3C5.6 3 2 5.7 2 9c0 1.8 1.1 3.5 2.8 4.6L4 16l3-1.4c.6.2 1.2.3 1.9.4-.5-.8-.8-1.7-.8-2.6 0-3.2 3.2-5.8 7.1-5.8h1.7C15.7 4.5 13.1 3 10 3Zm-3 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm6 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" /><path d="M22 13c0-2.8-2.8-5-6.3-5s-6.3 2.2-6.3 5 2.8 5 6.3 5c.7 0 1.4-.1 2.1-.3L20 19l-.5-2.1C21 16 22 14.6 22 13Zm-8.5-2a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Zm4.5 0a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z" /></svg></span>
          <div className="agent-channel-content">
            <div className="agent-channel-heading"><h3>{t('agent.channels.weixin')}</h3><span className={`agent-status ${channels?.status.weixin === 'connected' ? 'connected' : ''}`}>{t(CHANNEL_STATUS[channels?.status.weixin ?? 'disconnected'] ?? 'agent.channels.status.disconnected')}</span></div>
            <p className="agent-channel-description">{t('agent.channels.weixin_description')}</p>
            {channels?.status.weixin === 'connected' && <p className="agent-channel-account">{channels.weixin.accountId}</p>}
            {!login && loginMessage && <p className="agent-field-hint" role="status">{loginMessage}</p>}
            <div className="agent-channel-controls"><button type="button" className="agent-button" disabled={!!busy} onClick={() => void connectWeixin()}>{t(busy === 'weixin' ? 'agent.channels.connecting' : login ? 'agent.channels.refresh_qr' : channels?.weixin.enabled ? 'agent.channels.reconnect' : 'agent.channels.connect_weixin')}</button>{(channels?.weixin.enabled || login) && <button type="button" className="agent-button quiet" disabled={!!busy} onClick={() => void disconnect('weixin')}>{t('agent.channels.disconnect')}</button>}</div>
            {needsVerify && <form className="agent-channel-controls" onSubmit={verify}><input className="agent-inline-input" aria-label={t('agent.channels.verify_label')} required autoComplete="one-time-code" placeholder={t('agent.channels.verify_label')} value={verifyCode} onChange={event => setVerifyCode(event.target.value)} /><button type="submit" className="agent-button" disabled={!!busy}>{t('agent.channels.submit')}</button></form>}
            {channels?.status.weixinError && <p className="agent-feedback error">{formatAgentError(channels.status.weixinError, t)}</p>}
          </div>
        </section> : <section className="agent-channel-row">
          <span className="agent-channel-mark telegram" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="m20.7 4.2-3.2 15c-.2 1-1 1.2-1.8.7l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.6-.6-.3L5 12.7 1.2 11.5c-.9-.3-.9-.9.2-1.3L19 3.4c.8-.3 1.5.2 1.7.8Z" /></svg></span>
          <div className="agent-channel-content">
            <div className="agent-channel-heading"><h3>Telegram</h3><span className={`agent-status ${channels?.status.telegram === 'connected' ? 'connected' : ''}`}>{t(CHANNEL_STATUS[channels?.status.telegram ?? 'disconnected'] ?? 'agent.channels.status.disconnected')}</span></div>
            <p className="agent-channel-description">{t('agent.channels.telegram_description')}</p>
            {channels?.telegram.botName && <p className="agent-channel-account">@{channels.telegram.botName}</p>}
            <form className="agent-channel-controls" onSubmit={connectTelegram}><input className="agent-inline-input" aria-label={t('agent.channels.token_label')} autoComplete="off" value={token} spellCheck={false} placeholder={t(channels?.telegram.hasToken ? 'agent.channels.token_reconnect' : 'agent.channels.token_placeholder')} onChange={event => setToken(event.target.value)} /><button type="submit" className="agent-button" disabled={!!busy || !token.trim()}>{t(busy === 'telegram' ? 'agent.channels.connecting' : 'agent.channels.connect')}</button>{channels?.telegram.enabled && <button type="button" className="agent-button quiet" disabled={!!busy} onClick={() => void disconnect('telegram')}>{t('agent.channels.disconnect')}</button>}</form>
            {pairing && channels?.status.telegram !== 'connected' && <div className="agent-pairing"><p>{t('agent.channels.pairing_prompt', { bot: pairing.botName })}</p><code>/pair {pairing.pairingCode}</code></div>}
            {channels?.status.telegram === 'waiting_pairing' && !pairing && <p className="agent-field-hint">{t('agent.channels.pairing_refresh')}</p>}
            {channels?.status.telegramError && <p className="agent-feedback error">{formatAgentError(channels.status.telegramError, t)}</p>}
          </div>
        </section>}
      </div>
      {selectedChannel === 'weixin' && login && <aside className="agent-qr" aria-label={t('agent.channels.qr_label')}><img src={login.qrDataUrl} width="160" height="160" alt={t('agent.channels.qr_alt')} /><p role="status">{loginMessage}</p></aside>}
    </div>
    {feedback && <p className="agent-feedback" role="status">{t(feedback)}</p>}{error && <p className="agent-feedback error" role="alert">{formatAgentError(error, t)}</p>}
  </section>;
}

function AgentHelpModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [feedbackBefore, feedbackAfter] = t('agent.help.feedback').split('{issues}');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!previousFocus.current && document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement;
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previousFocus.current?.focus();
  }, []);

  return createPortal(<dialog ref={dialogRef} className="settings-modal agent-help-modal" aria-labelledby="agent-help-title" onClose={onClose} onMouseDown={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="settings-content">
    <div className="settings-header"><span className="settings-header-title" id="agent-help-title">{t('agent.help.title')}</span><button type="button" className="settings-close close-button" aria-label={t('agent.help.close')} onClick={() => dialogRef.current?.close()}>×</button></div>
    <div className="settings-body agent-help-content">
    <h3>{t('agent.help.workflow_heading')}</h3>
    <p>{t('agent.help.workflow_intro')}</p>
    <p>{t('agent.help.workflow_usage')}</p>
    <p>{feedbackBefore}<a className="agent-help-link" href="https://github.com/edison7009/Coffee-CLI/issues" onClick={event => { event.preventDefault(); void commands.openUrl(event.currentTarget.href).catch(() => {}); }}>GitHub Issues</a>{feedbackAfter}</p>
    <h3>{t('agent.help.delegation_heading')}</h3>
    <p>{t('agent.help.delegation_description')}</p>
    <p>{t('agent.help.delegation_tip')}</p>
    <h3>{t('agent.modes.sentinel.title')}</h3>
    <p>{t('agent.help.sentinel_description')}</p>
    <h3>{t('agent.modes.project_manager.title')}</h3>
    <p>{t('agent.help.project_manager_description')}</p>
    <h3>{t('agent.modes.expert_config.title')}</h3>
    <p>{t('agent.help.expert_config_description')}</p>
    <h3>{t('agent.help.examples_heading')}</h3>
    <dl className="agent-command-examples">{[
      [t('agent.help.example.open_label'), t('agent.help.example.open')],
      [t('agent.help.example.directory_label'), t('agent.help.example.directory')],
      [t('agent.help.example.progress_label'), t('agent.help.example.progress')],
      [t('agent.help.example.task_label'), t('agent.help.example.task')],
      [t('agent.help.example.resume_label'), t('agent.help.example.resume')],
      [t('agent.help.example.history_label'), t('agent.help.example.history')],
      [t('agent.help.example.remember_label'), t('agent.help.example.remember')],
      [t('agent.help.example.memory_label'), t('agent.help.example.memory')],
      [t('agent.help.example.forget_label'), t('agent.help.example.forget')],
      [t('agent.help.example.new_label'), t('agent.help.example.new')],
      [t('agent.help.example.cancel_label'), t('agent.help.example.cancel')],
    ].map(([label, command]) => <div key={label}><dt>{label}</dt><dd>{command}</dd></div>)}</dl>
    <p className="agent-field-hint">{t('agent.help.examples_hint')}</p>
    </div>
    </div>
  </dialog>, document.body);
}

export function AgentPages({ page }: { page: AgentPage }) {
  const t = useT();
  const { state } = useAppState();
  const [helpOpen, setHelpOpen] = useState(false);
  if (page === 'config') return <PageFrame page="config"><div className="agent-settings-scroll"><div className="agent-settings-content"><p className="agent-settings-intro">{t('agent.settings.intro')}{' '}<button type="button" className="agent-help-link" onClick={() => setHelpOpen(true)}>{t('agent.settings.help')}</button></p><AgentModelSection /><AgentWorkModesSection /><AgentChannelsSection /></div></div>{helpOpen && state.agentPageActive === 'config' && <AgentHelpModal onClose={() => setHelpOpen(false)} />}</PageFrame>;
  return <AgentChatPage />;
}

export function ChannelConnectionSummary() {
  const t = useT();
  const { state, dispatch } = useAppState();
  const { channels } = useAgentClient();
  const weixin = channels?.status.weixin === 'connected';
  const telegram = channels?.status.telegram === 'connected';
  const defaultChannel = state.currentLang.startsWith('zh') ? t('agent.channels.weixin') : 'Telegram';
  const label = weixin || telegram
    ? t(weixin && telegram ? 'agent.sidebar.both_connected' : weixin ? 'agent.sidebar.weixin_connected' : 'agent.sidebar.telegram_connected')
    : `${defaultChannel} · ${t('agent.channels.status.disconnected')}`;
  return <div className="agent-channel-summary">
    <button type="button" className="agent-channel-summary-label" aria-label={t('agent.sidebar.open_settings', { status: label })} onClick={() => dispatch({ type: 'OPEN_AGENT_PAGE', page: 'config' })}>{label}</button>
    <button type="button" className="agent-sidebar-button" aria-label={t('agent.sidebar.open_agent')} aria-pressed={state.agentPageActive === 'agent'} onClick={() => dispatch({ type: 'OPEN_AGENT_PAGE', page: 'agent' })}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 14H6l-4 3V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3" /><path d="M10 8h10a2 2 0 0 1 2 2v12l-4-3h-8a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" /></svg>
    </button>
  </div>;
}
