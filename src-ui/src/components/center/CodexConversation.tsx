import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { startErrorText } from '../../lib/start-error';
import { TurnSummary } from './TurnSummary';
import { useWorktreePending } from '../../lib/worktree-pending';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { orchestrationToolLabel } from '../../lib/orchestration-label';
import { arr, obj, str, num, pretty, codexSubTasks, type CodexMessage, type CodexRequest, type Json } from '../../lib/codex-protocol';
import { approveCodexPlan, continueCodexInNewThread, interruptCodex, loadCodexHistory, respondCodex, retainCodexSession, settleCodexColdReturn, useCodexSession } from '../../lib/codex-session';
import { clipboardWrite } from '../../lib/clipboard';
import { directoryFailure, directoryFailureMessage } from '../../lib/session-directory';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { useConversationVirtualizer } from './conversation-virtualizer';
import { MarkdownContent } from './MarkdownContent';
import { WelcomeGreeting, WelcomeRestoring, WelcomeSessionMeta } from './WelcomeGreeting';
import { CodexWelcomeIcon } from './CodexWelcomeIcon';
import { ConversationDirectory } from '../../lib/conversation-links';
import { useConversationMenu } from '../../lib/use-conversation-menu';
import { CollapsibleUserMessage, ColdReturnCard, ConversationNavigation, MessageCopyButton, type ConversationNavigationItem, Chevron } from './ConversationControls';
import './ConversationView.css';
import './ClaudeConversation.css';
import './CodexConversation.css';
import commandSpriteUrl from './codex-activity-command.webp';
import readSpriteUrl from './codex-activity-read.webp';
import searchSpriteUrl from './codex-activity-search.webp';
import { pasteImageIntoAnswer } from '../../lib/answer-image-paste';
import { ScrollLatestIcon } from './ScrollLatestIcon';

function Measured({ id, measure, children }: { id: string; measure: (id: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const node = ref.current; if (!node) return; const update = () => measure(id, node.getBoundingClientRect().height); update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect(); }, [id, measure]);
  return <div ref={ref}>{children}</div>;
}
function title(message: CodexMessage): string {
  const item = message.item;
  if (item.type === 'commandExecution') return str(item.command);
  if (item.type === 'fileChange') return arr(item.changes).map(value => str(obj(value).path)).join(', ');
  return str(item.tool) || str(item.query) || str(item.type);
}
function RequestCard({ sessionId, request }: { sessionId: string; request: CodexRequest }) {
  const t = useT(), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = arr(request.params.questions).map(obj);
  const submit = async (response: Json, reject = false) => {
    if (pending) return; setPending(true); setError('');
    try { await respondCodex(sessionId, request.id, response, reject); } catch (error) { setError(String(error)); setPending(false); }
  };
  const permissions = request.method === 'item/permissions/requestApproval';
  const input = request.method === 'item/tool/requestUserInput';
  const incomplete = questions.some(q => !answers[str(q.id)]?.trim());
  const submitAnswers = () => {
    if (pending || incomplete) return;
    void submit({ answers: Object.fromEntries(questions.map(q => [str(q.id), { answers: [answers[str(q.id)]] }])) });
  };
  const supported = input || permissions || ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method);
  return <section className="claude-approval codex-request" aria-label={t(input ? 'codex.question' : 'codex.approval')}>
    <strong>{t(input ? 'codex.question' : 'codex.approval')}</strong>
    {!!request.params.reason && <p>{str(request.params.reason)}</p>}
    {input ? questions.map(question => <fieldset key={str(question.id)} disabled={pending}>
      <legend>{str(question.question)}</legend>
      {arr(question.options).map(value => { const option = obj(value); return <label key={str(option.label)}><input type="radio" name={`${JSON.stringify(request.id)}-${str(question.id)}`} checked={answers[str(question.id)] === option.label} onChange={() => setAnswers(a => ({ ...a, [str(question.id)]: str(option.label) }))} /><span>{str(option.label)}<small>{str(option.description)}</small></span></label>; })}
      {(!arr(question.options).length || question.isOther === true) && <input className="claude-custom-answer" type={question.isSecret ? 'password' : 'text'} aria-label={str(question.header) || str(question.question)} value={answers[str(question.id)] ?? ''} onChange={e => setAnswers(a => ({ ...a, [str(question.id)]: e.target.value }))} onPaste={question.isSecret ? undefined : e => pasteImageIntoAnswer(e, value => setAnswers(a => ({ ...a, [str(question.id)]: value })))} onKeyDown={e => {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        e.preventDefault();
        if (!e.repeat) submitAnswers();
      }} />}
    </fieldset>) : <pre className="codex-request-details">{str(request.params.command) || pretty(request.params.permissions ?? request.params)}</pre>}
    {error && <p role="alert">{error}</p>}
    <div className="claude-approval-actions">
      {!supported ? <><span role="alert">{t('codex.unsupported_request')}</span><button type="button" disabled={pending} onClick={() => { void submit({}, true); }}>{t('codex.decline')}</button></> : input ? <button type="button" disabled={pending || incomplete} onClick={submitAnswers}>{t('codex.submit')}</button> : <>
        <button type="button" disabled={pending} onClick={() => { void submit(permissions ? { permissions: {} } : { decision: 'decline' }); }}>{t('codex.decline')}</button>
        {!permissions && <button type="button" disabled={pending} onClick={() => { void submit({ decision: 'acceptForSession' }); }}>{t('codex.allow_session')}</button>}
        <button type="button" disabled={pending} onClick={() => { void submit(permissions ? { permissions: request.params.permissions, scope: 'turn' } : { decision: 'accept' }); }}>{t('codex.allow')}</button>
      </>}
    </div>
  </section>;
}
type CodexActivityKind = 'working' | 'command' | 'read' | 'search' | 'webSearch' | 'list' | 'edit' | 'waiting' | 'stopping';

function CodexActivityMark({ kind = 'working', paused = false }: {
  kind?: CodexActivityKind;
  paused?: boolean;
}) {
  return <svg className="codex-activity-mark" data-kind={kind} data-paused={paused || undefined}
    viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'command' && <g fill="currentColor" stroke="none"><path d="M11 8.97461C11.2897 8.97488 11.5254 9.21022 11.5254 9.5C11.5252 9.78962 11.2896 10.0251 11 10.0254H8.667C8.37717 10.0254 8.1418 9.78979 8.14161 9.5C8.14161 9.21006 8.37705 8.97461 8.667 8.97461H11Z" /><path d="M4.79493 6.12891C4.99995 5.92389 5.33209 5.92389 5.53711 6.12891L6.91895 7.51075C7.18896 7.78087 7.18903 8.21918 6.91895 8.48926L5.53711 9.8711C5.3321 10.0758 4.99986 10.0759 4.79493 9.8711C4.59 9.66617 4.59021 9.33396 4.79493 9.12891L5.92383 8L4.79493 6.8711C4.59 6.66617 4.59021 6.33396 4.79493 6.12891Z" /><path d="M11.1065 1.80762C11.4827 1.80762 11.7323 1.80647 11.9492 1.84082C13.0865 2.02112 13.9781 2.91343 14.1582 4.05079C14.1925 4.26758 14.1914 4.51664 14.1914 4.89258V11.1065C14.1914 11.4827 14.1926 11.7323 14.1582 11.9492C13.9779 13.0864 13.0864 13.9779 11.9492 14.1582C11.7323 14.1926 11.4827 14.1914 11.1065 14.1914H4.89258C4.51664 14.1914 4.26758 14.1925 4.05079 14.1582C2.91343 13.9781 2.02112 13.0865 1.84082 11.9492C1.80647 11.7323 1.80762 11.4827 1.80762 11.1065V4.89258C1.80762 4.51667 1.80653 4.26757 1.84082 4.05079C2.02099 2.91331 2.91331 2.02099 4.05079 1.84082C4.26756 1.80653 4.51667 1.80762 4.89258 1.80762H11.1065ZM4.89258 2.8584C4.47657 2.8584 4.32953 2.85978 4.21485 2.87793C3.52666 2.98693 2.98693 3.52666 2.87793 4.21485C2.85978 4.32953 2.8584 4.47657 2.8584 4.89258V11.1065C2.8584 11.5223 2.85982 11.6695 2.87793 11.7842C2.98693 12.4724 3.52666 13.0121 4.21485 13.1211C4.32954 13.1393 4.47651 13.1416 4.89258 13.1416H11.1065C11.5224 13.1416 11.6695 13.1392 11.7842 13.1211C12.4724 13.0121 13.0121 12.4724 13.1211 11.7842C13.1392 11.6695 13.1416 11.5224 13.1416 11.1065V4.89258C13.1416 4.47651 13.1393 4.32954 13.1211 4.21485C13.0121 3.52666 12.4724 2.98693 11.7842 2.87793C11.6695 2.85982 11.5223 2.8584 11.1065 2.8584H4.89258Z" /></g>}
    {(kind === 'search' || kind === 'webSearch') && <g fill="currentColor" stroke="none"><path d="M6.99658 2.4707C9.49567 2.4707 11.522 4.49701 11.522 6.99609C11.522 8.06173 11.1521 9.04022 10.5356 9.81348L13.02 12.2979C13.225 12.5029 13.225 12.835 13.02 13.04C12.815 13.2451 12.4829 13.2451 12.2778 13.04L9.7915 10.5537C9.02184 11.1592 8.05175 11.5215 6.99658 11.5215C4.49749 11.5215 2.47119 9.49518 2.47119 6.99609C2.47119 4.49701 4.49749 2.4707 6.99658 2.4707ZM6.99658 3.52148C5.07739 3.52148 3.52197 5.0769 3.52197 6.99609C3.52197 8.91528 5.07739 10.4707 6.99658 10.4707C8.91577 10.4707 10.4712 8.91528 10.4712 6.99609C10.4712 5.0769 8.91577 3.52148 6.99658 3.52148Z" fillRule="evenodd" clipRule="evenodd"/></g>}
    {kind === 'read' && <g fill="currentColor" stroke="none"><path d="M16.3965 5.01128C16.3963 4.93399 16.3489 4.87691 16.293 4.85406L16.2354 4.84332C13.9306 4.91764 12.5622 5.32101 10.665 6.34722V16.3716C11.3851 15.9994 12.0688 15.7115 12.7861 15.5015C13.8286 15.1965 14.9113 15.0633 16.2402 15.0435L16.2979 15.0308C16.353 15.0063 16.3965 14.9483 16.3965 14.8755V5.01128ZM3.54492 14.8765C3.54492 14.9725 3.62159 15.0422 3.70117 15.0435L4.19629 15.0562C5.94062 15.1247 7.26036 15.4201 8.65918 16.0484C8.05544 15.1706 7.14706 14.436 6.17871 14.1109V14.1099C5.56757 13.9045 5.16816 13.3314 5.16797 12.6988V4.98882C4.86679 4.93786 4.60268 4.8999 4.28223 4.87457L3.72754 4.84429C3.62093 4.84079 3.54505 4.92417 3.54492 5.01226V14.8765ZM17.7266 14.8755C17.7266 15.6314 17.1607 16.2751 16.4121 16.3628L16.2598 16.3736C15.0122 16.3922 14.0555 16.5159 13.1602 16.7779C12.2629 17.0404 11.3966 17.4508 10.3369 18.0738C10.129 18.1959 9.87099 18.1958 9.66309 18.0738C7.71455 16.9283 6.31974 16.4689 4.12988 16.3853L3.68164 16.3736C2.85966 16.3614 2.21484 15.6838 2.21484 14.8765V5.01226C2.21497 4.15391 2.93263 3.4871 3.77246 3.51519L4.39844 3.54937C4.67996 3.57191 4.92258 3.60421 5.16797 3.64214V2.51031C5.16797 1.44939 6.29018 0.645615 7.31055 1.15679L7.31152 1.15582C8.78675 1.89511 10.0656 3.33006 10.5352 4.91461C12.3595 3.98907 13.8688 3.58817 16.1924 3.51324L16.3506 3.51714C17.1285 3.5741 17.7264 4.23496 17.7266 5.01128V14.8755ZM6.49805 12.6988C6.49824 12.7723 6.5442 12.8296 6.60254 12.8492L6.96289 12.9859C7.85245 13.3586 8.68125 13.9846 9.33496 14.7496V5.5816C9.08794 4.37762 8.13648 3.1566 6.95801 2.47613L6.71582 2.34527C6.67779 2.32617 6.6337 2.32502 6.58301 2.35796C6.52946 2.39279 6.49805 2.44863 6.49805 2.51031V12.6988Z" transform="scale(.8)" /></g>}
    {kind === 'list' && <g fill="currentColor" stroke="none"><path fillRule="evenodd" clipRule="evenodd" d="M5.59668 2.19995C5.95191 2.20003 6.29915 2.30563 6.59473 2.50269L7.92285 3.38745C8.06511 3.48229 8.23235 3.53288 8.40332 3.53296H12.2002C13.452 3.53306 14.4668 4.54876 14.4668 5.80054V11.4666C14.4668 12.7551 13.4222 13.8003 12.1338 13.8005H3.86621C2.57776 13.8003 1.5332 12.7551 1.5332 11.4666V4.53296C1.53345 3.24466 2.57791 2.2002 3.86621 2.19995H5.59668ZM13.5332 7.80054H2.4668V11.4666C2.4668 12.2396 3.09322 12.8667 3.86621 12.8669H12.1338C12.9068 12.8667 13.5332 12.2396 13.5332 11.4666V7.80054ZM2.4668 6.86694H13.5332V5.80054C13.5332 5.06422 12.9365 4.46666 12.2002 4.46655H8.40332C8.04816 4.46648 7.70081 4.36177 7.40527 4.16479L6.07715 3.27905C5.93489 3.18421 5.76765 3.13362 5.59668 3.13354H3.86621C3.09338 3.13379 2.46704 3.76012 2.4668 4.53296V6.86694Z"/></g>}
    {kind === 'edit' && <g fill="currentColor" stroke="none"><path d="M9.41506 2.54535C10.5566 1.516 12.2884 1.57105 13.3399 2.64105C14.4597 3.72222 14.4959 5.5405 13.3467 6.68988L7.75588 12.2797C7.18583 12.8809 6.45561 13.2881 5.6924 13.4653H5.69045L2.59767 14.1762L2.5967 14.1743C2.4644 14.2058 2.19674 14.2328 1.98342 14.02C1.76937 13.8062 1.79632 13.5371 1.82814 13.4047L2.5381 10.3188C2.71723 9.5224 3.12639 8.8269 3.68752 8.26703L9.30568 2.64887L9.41506 2.54535ZM4.4297 9.01019C3.99658 9.44234 3.69398 9.96492 3.56252 10.5512L3.56154 10.5541L2.99513 13.0063L5.45607 12.4418C6.02206 12.3102 6.56957 12.0068 6.99513 11.558L7.00392 11.5483L11.5254 7.02582L8.96877 4.46918L4.4297 9.01019ZM12.5986 3.38422C11.9258 2.69135 10.7787 2.66298 10.0479 3.39203L10.0469 3.39105L9.71193 3.72602L12.2686 6.28266L12.6045 5.94769C13.3406 5.21146 13.3067 4.06829 12.6113 3.39691L12.5986 3.38422Z" fillRule="evenodd" clipRule="evenodd"/></g>}
    {kind === 'waiting' && <path d="M4 3h8M4 13h8M5 3v2l6 6v2M11 3v2l-6 6v2" />}
    {kind === 'stopping' && <rect x="4" y="4" width="8" height="8" rx="1.5" />}
    {kind === 'working' && <g fill="currentColor" stroke="none"><circle cx="3" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="13" cy="8" r="1" /></g>}
  </svg>;
}

type LiveActivity = { key: string; toolId?: string; kind: CodexActivityKind; label: string; detail: string; animateIcon: boolean; midTurnThinking: boolean };
const liveSprites: Partial<Record<CodexActivityKind, string>> = {
  command: commandSpriteUrl, read: readSpriteUrl, search: searchSpriteUrl, list: searchSpriteUrl,
};

function CodexLiveActivity({ activity, messages, busy, interrupted, paused, visible }: {
  activity: LiveActivity; messages: readonly CodexMessage[]; busy: boolean; interrupted: boolean; paused: boolean; visible: boolean;
}) {
  const status = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(activity);
  const [outgoing, setOutgoing] = useState<LiveActivity>();
  const [fadeLabel, setFadeLabel] = useState(false);
  const [decodedSprite, setDecodedSprite] = useState<string>();
  const [wasBusy, setWasBusy] = useState(busy);
  const [finishing, setFinishing] = useState(false);
  const [inView, setInView] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const motionVisible = visible && inView && pageVisible;
  const hasStatus = busy || finishing;
  const spriteUrl = liveSprites[current.kind];
  const animateIcon = current.animateIcon && (!busy || current.key === activity.key ||
    messages.some(message => message.id === current.toolId && message.partial));
  const cadenceStart = useRef<number | null>(null);
  const displayedSince = useRef(0);
  const immediate = paused || current.kind === 'waiting' || current.kind === 'stopping';
  if (busy !== wasBusy) {
    setWasBusy(busy);
    setFinishing(!busy && !interrupted && motionVisible && !document.hidden &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    setOutgoing(undefined);
    setFadeLabel(false);
    if (busy) setCurrent(activity);
  } else if (busy && immediate && current.key !== activity.key) {
    setOutgoing(current);
    setFadeLabel(current.midTurnThinking || activity.midTurnThinking);
    setCurrent(activity);
  } else if (busy && current.key === activity.key && (current.label !== activity.label ||
    current.detail !== activity.detail || current.animateIcon !== activity.animateIcon ||
    current.midTurnThinking !== activity.midTurnThinking)) {
    setCurrent(activity);
  }
  useEffect(() => {
    if (!spriteUrl || decodedSprite === spriteUrl || !animateIcon) return;
    const image = new Image();
    image.src = spriteUrl;
    let cancelled = false;
    void image.decode().then(() => { if (!cancelled) setDecodedSprite(spriteUrl); }, () => {});
    return () => { cancelled = true; };
  }, [spriteUrl, decodedSprite, animateIcon]);
  useEffect(() => {
    const updatePageVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', updatePageVisibility);
    return () => document.removeEventListener('visibilitychange', updatePageVisibility);
  }, []);
  useEffect(() => {
    const row = status.current;
    if (!row) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    observer.observe(row);
    return () => observer.disconnect();
  }, [hasStatus]);
  useEffect(() => {
    if (!busy) {
      cadenceStart.current = null;
      return;
    }
    displayedSince.current = Date.now();
    cadenceStart.current ??= displayedSince.current;
  }, [busy, current.key]);
  const pendingActivity = busy && current.key !== activity.key && !immediate;
  const sampleActivity = useEffectEvent(() => {
    if (!pendingActivity) return;
    setOutgoing(current);
    setFadeLabel(current.midTurnThinking || activity.midTurnThinking);
    setCurrent(activity);
  });
  useEffect(() => {
    if (!pendingActivity) return;
    let timer: number;
    const schedule = () => {
      window.clearTimeout(timer);
      if (document.hidden) return;
      const now = Date.now();
      const delay = current.midTurnThinking
        ? Math.max(0, 1000 - (now - displayedSince.current))
        : 3500 - (now - (cadenceStart.current ?? now)) % 3500;
      timer = window.setTimeout(sampleActivity, delay);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [current.key, current.midTurnThinking, pendingActivity]);
  useEffect(() => {
    if (!finishing) return;
    const finish = () => setFinishing(false);
    const timer = window.setTimeout(finish, 150);
    document.addEventListener('visibilitychange', finish);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', finish);
    };
  }, [finishing]);
  if (!hasStatus) return null;
  return <div ref={status} className="codex-working codex-live-status" role={busy ? 'status' : undefined}
    aria-hidden={!busy || undefined} data-finishing={finishing || undefined} data-motion-hidden={!motionVisible || undefined}>
    <span className="codex-live-stack">
      {outgoing && <span key={outgoing.key} className="codex-live-outgoing" aria-hidden="true"
        onAnimationEnd={event => { if (event.target === event.currentTarget) setOutgoing(undefined); }}>
        {outgoing.kind !== 'working' && <span className="codex-live-icon">
          {outgoing.kind !== current.kind && <CodexActivityMark kind={outgoing.kind} paused />}
        </span>}
        <span className="codex-live-text">{outgoing.label}{outgoing.detail && ` ${outgoing.detail}`}</span>
      </span>}
      <span className="codex-live-activity" data-paused={paused || !motionVisible || undefined} data-fade-label={fadeLabel || undefined}>
        {current.kind === 'working' && outgoing && outgoing.kind !== 'working' &&
          <span className="codex-live-icon-exit" aria-hidden="true" />}
        {current.kind !== 'working' && <span key={current.kind} className="codex-live-icon"
          data-animating={(animateIcon && !!spriteUrl && decodedSprite === spriteUrl) || undefined}>
          <CodexActivityMark kind={current.kind} paused={paused || !motionVisible} />
          {spriteUrl &&
            <span className="codex-live-sprite" data-kind={current.kind} aria-hidden="true" />}
        </span>}
        <span key={current.key} className="codex-live-text-slot" title={current.detail || undefined}>
          <span className="codex-live-text">
            <span className="codex-live-label">{current.label}</span>
            {current.detail && <> <span className="codex-live-detail">{current.detail}</span></>}
            {!paused && motionVisible && <span className="codex-live-sweep"
              data-delay={current.midTurnThinking || fadeLabel || undefined} aria-hidden="true">
              <span>{current.label}{current.detail && ` ${current.detail}`}</span>
            </span>}
          </span>
        </span>
      </span>
    </span>
  </div>;
}

type Row = CodexMessage & { members?: CodexMessage[] };
export function CodexConversation({ sessionId, cwd, resumeToken, isActive, isVisible = isActive, hasBg, bgUrl, bgType }: { sessionId: string; cwd: string | null; resumeToken?: string; isActive: boolean; isVisible?: boolean; hasBg?: boolean; bgUrl?: string; bgType?: string }) {
  const s = useCodexSession(sessionId), t = useT(), { state, dispatch } = useAppState();
  const creatingWorktree = useWorktreePending(sessionId, s.ready || !!s.error);
  const directoryIssue = !s.ready ? directoryFailure(s.error) : undefined;
  const directoryError = directoryFailureMessage(s.error, t);
  const scroll = useRef<HTMLDivElement>(null), pinned = useRef(true), pointerHeld = useRef(false), lastTop = useRef(0);
  const conversationMenu = useConversationMenu(scroll, sessionId, isActive);
  const viewport = useRef({ width: 0, height: 0 });
  const anchor = useRef<{ firstId: string; messageId: string; offset: number; top: number; height: number; applied: boolean } | null>(null);
  const [scrolled, setScrolled] = useState(false), [expanded, setExpanded] = useState<Record<string, boolean>>({}), [copied, setCopied] = useState('');
  const initialToken = useRef(resumeToken);
  // Captured at mount like initialToken; state, not a ref, because the welcome screen renders from it.
  const [resumed] = useState(() => !!resumeToken);
  useEffect(() => retainCodexSession(sessionId, cwd, initialToken.current), [sessionId, cwd]);
  useEffect(() => { if (s.nativeId) dispatch({ type: 'SET_SESSION_TOKEN', id: sessionId, token: s.nativeId }); }, [s.nativeId, sessionId, dispatch]);
  // The conversation's own title names the tab, as a terminal tab takes the tool's OSC title.
  useEffect(() => { if (s.title) dispatch({ type: 'SET_TAB_TITLE', id: sessionId, title: s.title }); }, [s.title, sessionId, dispatch]);
  useEffect(() => { dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: s.requests.length ? 'wait_input' : s.busy ? 'working' : 'idle' }); }, [s.requests.length, s.busy, sessionId, dispatch]);
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    for (const message of s.messages) {
      const activity = (message.role === 'tool' || message.role === 'reasoning') && message.item.type !== 'turnStatus';
      const previous = result.at(-1);
      if (activity && previous?.members && previous.turnId === message.turnId) {
        previous.members.push(message); previous.partial ||= message.partial; previous.content += `\n${title(message)}`;
      } else result.push(activity ? { ...message, id: `group:${message.id}`, content: title(message), members: [message] } : message);
    }
    return result;
  }, [s.messages]);
  const paused = s.interrupting || s.requests.length > 0;
  const activeTool = s.busy && !paused ? s.messages.findLast(message =>
    message.turnId === s.turnId && message.role === 'tool' && message.partial,
  ) : undefined;
  const lastItem = s.messages.at(-1);
  const completedCommand = s.busy && !paused && !activeTool && lastItem?.turnId === s.turnId &&
    lastItem.item.type === 'commandExecution' && !lastItem.partial ? lastItem : undefined;
  const activityItem = activeTool ?? completedCommand;
  const item = activityItem?.item;
  const action = obj(arr(item?.commandActions).at(-1));
  const activityKind = s.interrupting ? 'stopping' : paused ? 'waiting'
    : action.type === 'read' ? 'read'
    : item?.type === 'webSearch' ? 'webSearch'
    : action.type === 'search' ? 'search'
    : action.type === 'listFiles' ? 'list'
    : item?.type === 'commandExecution' ? 'command'
    : item?.type === 'fileChange' ? 'edit'
    : 'working';
  const searchPath = activityKind === 'search' ? str(action.path) : '';
  const searchFolder = searchPath.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || searchPath;
  const activityDetail = (searchFolder || str(action.name) || str(action.query) || str(action.path) ||
    str(item?.command) || str(item?.query) || str(item?.tool) ||
    (item?.type === 'fileChange' && activeTool ? title(activeTool) : '')).replace(/\s+/g, ' ').trim();
  const activityLabel = t(({
    stopping: 'codex.stopping', waiting: 'codex.waiting', working: 'claude.status.thinking',
    command: completedCommand ? 'codex.activity.ran' : 'codex.activity.running',
    read: 'codex.activity.reading', search: searchFolder ? 'codex.activity.searching_folder' : 'codex.activity.searching',
    list: 'codex.activity.listing', edit: 'codex.activity.editing', webSearch: 'codex.activity.searching_web',
  } as const)[activityKind]);
  const virtual = useConversationVirtualizer(rows, scroll);
  const navigationItems = useMemo<ConversationNavigationItem[]>(() => rows.flatMap((row, messageIndex) => row.role === 'user' ? [{
    id: row.id, sourceMessageId: row.id, content: row.content, messageIndex, top: (virtual.offsets[messageIndex] ?? 0) + 32, cursor: null,
  }] : []), [rows, virtual.offsets]);
  const sync = useCallback(() => {
    const node = scroll.current; if (!node || !isVisible || !node.clientHeight) return;
    const resized = viewport.current.width !== node.clientWidth || viewport.current.height !== node.clientHeight;
    if (pointerHeld.current && !resized && node.scrollTop < lastTop.current && node.scrollHeight - node.scrollTop - node.clientHeight > 2) pinned.current = false;
    viewport.current = { width: node.clientWidth, height: node.clientHeight };
    const saved = anchor.current;
    if (saved?.applied) {
      const target = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(el => el.dataset.messageId === saved.messageId);
      if (target) node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
    } else if (pinned.current) node.scrollTop = node.scrollHeight;
    lastTop.current = node.scrollTop; setScrolled(!pinned.current);
  }, [isVisible]);
  useEffect(() => {
    const node = scroll.current; if (!node) return;
    const unbind = bindAutoHideScrollbar(node, { wide: true, onDragStart: () => { anchor.current = null; pinned.current = false; setScrolled(true); } });
    const release = () => { pointerHeld.current = false; };
    document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release);
    return () => { unbind(); document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', release); };
  }, []);
  useLayoutEffect(() => {
    const node = scroll.current, saved = anchor.current;
    if (!node || !isVisible || !node.clientHeight) return;
    if (saved && !saved.applied && s.messages[0]?.id !== saved.firstId) { node.scrollTop = saved.top + node.scrollHeight - saved.height; saved.applied = true; }
    sync();
  }, [s.messages, s.requests, virtual.total, virtual.start, virtual.end, isVisible, sync]);
  useEffect(() => { const node = scroll.current; if (!node) return; const observer = new ResizeObserver(sync); observer.observe(node); if (node.firstElementChild) observer.observe(node.firstElementChild); return () => observer.disconnect(); }, [sync]);
  useEffect(() => {
    if (!isActive) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented && s.busy && !(e.target as HTMLElement)?.closest('[role="dialog"]')) { e.preventDefault(); void interruptCodex(sessionId); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [isActive, s.busy, sessionId]);
  // Moving away from the latest message; a thread too short to scroll has nowhere to go (a swipe on a phone is not a read-back).
  const pause = () => {
    const node = scroll.current;
    if (node && node.scrollHeight - node.clientHeight <= 2) return;
    anchor.current = null; pinned.current = false; setScrolled(true);
  };
  const jumpToTurn = (item: ConversationNavigationItem) => {
    pause();
    virtual.scrollToIndex(item.messageIndex, 'instant');
    const node = scroll.current;
    if (node) {
      // Keep the selected turn aligned while virtual rows finish measuring.
      anchor.current = { firstId: s.messages[0].id, messageId: item.id, offset: 24, top: node.scrollTop, height: node.scrollHeight, applied: true };
      sync();
    }
  };
  const loadEarlier = () => {
    const node = scroll.current;
    pause();
    if (node && s.messages.length) {
      const top = node.getBoundingClientRect().top;
      const target = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(el => el.getBoundingClientRect().bottom > top);
      if (target) anchor.current = { firstId: s.messages[0].id, messageId: target.dataset.messageId!, offset: target.getBoundingClientRect().top - top, top: node.scrollTop, height: node.scrollHeight, applied: false };
    }
    void loadCodexHistory(sessionId);
  };
  const toggle = (id: string) => setExpanded(old => ({ ...old, [id]: !old[id] }));
  const copy = (id: string, content: string) => { void clipboardWrite(content).then(() => { setCopied(id); setTimeout(() => setCopied(''), 1500); }); };
  const tool = (message: CodexMessage) => {
    const label = orchestrationToolLabel(str(message.item.tool), t, str(message.item.server));
    return <div className={`codex-tool is-${message.interrupted ? 'interrupted' : message.toolStatus ?? 'reasoning'}`} key={message.id}>
    <div className="codex-tool-heading"><button type="button" className="claude-tool-heading" aria-expanded={!!expanded[message.id]} onClick={() => toggle(message.id)}><span className="codex-chevron" aria-hidden="true"><Chevron open={expanded[message.id]} /></span><strong>{label ?? (message.role === 'reasoning' ? t('conversation.reasoning') : message.item.type === 'fileChange' ? t('codex.files') : message.item.type === 'commandExecution' ? t('codex.command') : str(message.item.type))}</strong><span>{label ? str(obj(message.item.arguments).title) : title(message)}</span></button><MessageCopyButton copied={copied === message.id} onCopy={() => copy(message.id, [title(message), message.content].join('\n'))} /></div>
    {expanded[message.id] && (message.role === 'reasoning' ? <MarkdownContent content={message.content} /> : <pre className="codex-tool-body">{message.content || pretty(message.item)}</pre>)}
  </div>;
  };
  return <ConversationDirectory.Provider value={cwd}><div className={`claude-conversation codex-conversation${hasBg && bgUrl ? ' has-background' : ''}${navigationItems.length > 1 ? ' has-navigation' : ''}`}>
    {hasBg && bgUrl && <div className="conversation-background">{bgType === 'video' ? <video src={bgUrl} autoPlay loop muted /> : <img src={bgUrl} alt="" />}</div>}
    <div className="claude-scroll" ref={scroll} onPointerDownCapture={e => { if (e.button === 0) pointerHeld.current = true; }} onContextMenu={conversationMenu.onContextMenu} onCopy={conversationMenu.onCopy} onWheelCapture={e => { if (e.deltaY < 0 && !e.ctrlKey) pause(); }} onTouchMoveCapture={pause} onKeyDownCapture={e => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key) && !(e.target as HTMLElement).closest('input,textarea,select')) pause(); }} onScroll={() => {
      const node = scroll.current; if (!node?.clientHeight) return;
      if (node.scrollTop !== lastTop.current) anchor.current = null;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      const resized = viewport.current.width !== node.clientWidth || viewport.current.height !== node.clientHeight;
      if (!resized && node.scrollTop < lastTop.current && distance > 2) {
        // Only a held pointer (text selection) moves away here; wheel, touch, keys and the
        // scrollbar pause first. Otherwise the engine restored an older position (macOS WebKit).
        if (pointerHeld.current) pinned.current = false;
        else if (pinned.current) node.scrollTop = node.scrollHeight;
      } else if (node.scrollTop > lastTop.current && distance < 2) pinned.current = true;
      lastTop.current = node.scrollTop; setScrolled(!pinned.current);
    }}>
      <div className={`claude-thread${!rows.length ? ' is-empty' : ''}`}>
        {s.historyCursor && <button className="claude-expand" disabled={s.loadingHistory} onClick={loadEarlier}>{t(s.loadingHistory ? 'diff.loading' : 'claude.history_earlier')}</button>}
        <div style={{ height: virtual.topSpacer }} aria-hidden="true" />
        {rows.slice(virtual.start, virtual.end).map((row, i) => <Measured key={row.id} id={virtual.measurementKeys[virtual.start + i]} measure={virtual.measureRow}>
          <article className={`claude-row claude-row--${row.item.type === 'turnStatus' ? str(row.item.status) : row.partial && row.role !== 'user' ? 'running' : row.role} codex-row`} data-message-id={row.id}>
            {row.members ? <>
              <button type="button" className="codex-group-heading" aria-expanded={!!expanded[row.id]} onClick={() => toggle(row.id)}><span aria-hidden="true"><Chevron open={expanded[row.id]} /></span><span>{t('codex.activity', { count: row.members.length })}</span>{row.partial && <CodexActivityMark paused={paused} />}<small>{title(row.members.at(-1)!)}</small></button>
              {expanded[row.id] && <div className="codex-activity-list">{row.members.map(tool)}</div>}
            </> : row.item.type === 'turnStatus' ? (row.turnStats
              ? <TurnSummary stats={row.turnStats} sessionKey={s.nativeId} messageId={row.id} prefix={t(row.item.status === 'interrupted' ? 'claude.interrupted' : row.item.status === 'failed' ? 'codex.failed' : 'codex.completed')} />
              : <div className="claude-turn-summary" role="status">{t(row.item.status === 'interrupted' ? 'claude.interrupted' : row.item.status === 'failed' ? 'codex.failed' : 'codex.completed')}{num(row.item.durationMs) > 0 && ` · ${Math.round(num(row.item.durationMs) / 1000)}s`}</div>) : <>
              {row.role === 'user'
                ? <CollapsibleUserMessage sentAt={row.timestamp} expanded={!!expanded[row.id]} onToggle={() => setExpanded(old => ({ ...old, [row.id]: !old[row.id] }))}><MarkdownContent content={row.content} /></CollapsibleUserMessage>
                : <div><MarkdownContent content={row.content} /></div>}
              <MessageCopyButton copied={copied === row.id} onCopy={() => copy(row.id, row.content)} />
            </>}
          </article>
        </Measured>)}
        <div style={{ height: virtual.bottomSpacer }} aria-hidden="true" />
        {s.requests.map(request => <RequestCard key={JSON.stringify(request.id)} sessionId={sessionId} request={request} />)}
        {s.planMode && s.planReady && !s.busy && <section className="claude-approval" aria-label={t('codex.plan.ready')}>
          <strong>{t('codex.plan.ready')}</strong>
          <p>{t('codex.plan.detail')}</p>
          <div className="claude-approval-actions"><button type="button" disabled={!s.ready || !!s.requests.length || !!s.coldReturn} onClick={() => { void approveCodexPlan(sessionId, t('codex.plan.prompt')); }}>{t('codex.plan.approve')}</button></div>
        </section>}
        {s.coldReturn && <ColdReturnCard idleMinutes={s.coldReturn.idleMinutes} tokens={s.coldReturn.tokens} detailKey="codex.cold_return.detail"
          onNew={s.busy || s.requests.length || codexSubTasks(s).length || state.terminals.some(tab => tab.parentId && (tab.id === sessionId || tab.parentId === sessionId)) ? undefined : () => { const newId = crypto.randomUUID(); if (continueCodexInNewThread(sessionId, newId)) dispatch({ type: 'RESTART_TERMINAL', id: sessionId, newId, fresh: true }); }}
          onFull={() => { void settleCodexColdReturn(sessionId, 'full'); }} onNever={() => { void settleCodexColdReturn(sessionId, 'never'); }}
          onCancel={() => { void settleCodexColdReturn(sessionId, 'cancel').then(draft => dispatch({ type: 'SET_GAMBIT_DRAFT', id: sessionId, draft })); }} />}
        {s.ready && <CodexLiveActivity messages={s.messages} busy={s.busy} interrupted={lastItem?.item.status === 'interrupted'}
          paused={paused} visible={isVisible} activity={{
          key: `${activityItem?.id ?? ''}:${activityKind}`, kind: activityKind, label: activityLabel, detail: activityDetail,
          toolId: activityItem?.id, animateIcon: !!activeTool,
          midTurnThinking: activityKind === 'working' && !!s.messages.findLast(message =>
            message.turnId === s.turnId && message.role === 'tool'),
        }} />}
        {s.error && !directoryIssue && <div className="claude-session-error" role="alert">{startErrorText(s.error, 'Codex CLI', t)}</div>}
        {directoryIssue && <div className="claude-session-error" role="alert">{directoryError}</div>}
        {!directoryIssue && !rows.length && <div className="claude-empty"><CodexWelcomeIcon isActive={isVisible} /><WelcomeGreeting />{(creatingWorktree || resumed && !s.ready && !s.error) && <WelcomeRestoring label={creatingWorktree ? t('gambit.worktree_creating') : undefined} className="codex-working" mark={<CodexActivityMark />} />}<WelcomeSessionMeta cwd={cwd} model={s.model} /></div>}
      </div>
    </div>
    {navigationItems.length > 1 && isActive && <ConversationNavigation items={navigationItems} scrollRef={scroll} onJump={jumpToTurn} />}
    {scrolled && <button type="button" className="claude-scroll-bottom" aria-label={t('claude.scroll_latest')} onClick={() => { anchor.current = null; pinned.current = true; lastTop.current = scroll.current?.scrollTop ?? 0; sync(); }}>
      <ScrollLatestIcon working={s.ready && s.busy && !paused ? <CodexActivityMark /> : undefined} />
    </button>}
    {s.error && !s.ready && (!directoryIssue || directoryIssue.status === 'unavailable') && <button type="button" className="claude-expand claude-reconnect" title={directoryError || s.error} onClick={() => dispatch({ type: 'RESTART_TERMINAL', id: sessionId, newId: crypto.randomUUID() })}>{t('codex.reconnect')}</button>}
    {conversationMenu.menu}
  </div></ConversationDirectory.Provider>;
}
