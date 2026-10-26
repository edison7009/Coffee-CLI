import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';
import { InlineSvgIcon } from '../InlineSvgIcon';
import claudeSvg from '../../icons-inline/claude.svg?raw';
import codexSvg from '../../icons-inline/codex.svg?raw';
import openCodeIcon from '../../icons-inline/opencode.png';
import './ToolControlDemo.css';

const Check = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m3 8 3 3 7-7" /></svg>;

function OrchestrationWorkspace() {
  const t = useT();
  const workers = [{ name: 'Codex', icon: <InlineSvgIcon markup={codexSvg} />, task: t('orchestration.demo.build') }, { name: 'OpenCode', icon: <img src={openCodeIcon} alt="" />, task: t('orchestration.demo.test') }];
  return <div className="control-demo-window team-demo-window">
    <div className="control-demo-bar team-demo-tabs">
      <span className="team-demo-parent"><InlineSvgIcon markup={claudeSvg} />Claude</span>
      {workers.map((worker, index) => <span className={`team-demo-tab team-demo-worker-${index} demo-motion`} key={worker.name}>{worker.icon}{worker.name}<i /></span>)}
    </div>
    <div className="team-demo-workers">
      {workers.map((worker, index) => <div className={`team-demo-worker team-demo-worker-${index} demo-motion`} key={worker.name}>
        <div className="team-demo-worker-heading"><span className="team-demo-icon">{worker.icon}</span><strong>{worker.name}</strong>
          <span className="team-demo-state"><span className="team-demo-running demo-motion"><i />{t('orchestration.working')}</span><span className="team-demo-finished demo-motion"><Check />{t('orchestration.completed')}</span></span>
        </div>
        <span className="team-demo-task">{worker.task}</span>
        <span className="team-demo-progress"><i className="demo-motion" /></span>
      </div>)}
      <div className="team-demo-summary demo-motion"><Check />{t('orchestration.demo.result')}</div>
    </div>
  </div>;
}

export function ToolControlDemo({ kind }: { kind: 'computer' | 'browser' | 'orchestration' }) {
  const t = useT();
  const root = useRef<HTMLElement>(null);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let inView = true;
    const update = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; update(); });
    if (root.current) observer.observe(root.current);
    document.addEventListener('visibilitychange', update);
    update();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);
  const team = kind === 'orchestration';
  const prompt = t(team ? 'orchestration.demo.prompt' : kind === 'computer' ? 'control.demo.computer_prompt' : 'control.demo.browser_prompt');
  const observe = t(team ? 'orchestration.demo.plan' : 'control.demo.observe'), act = t(team ? 'orchestration.demo.collect' : 'control.demo.act'), done = t(team ? 'orchestration.demo.summary' : 'codex.completed');
  const items = [t('control.demo.documents'), t('control.demo.charger'), t('control.demo.umbrella')];
  return <section ref={root} className="control-demo" data-kind={kind} data-paused={paused || !visible} aria-label={t('control.demo.title')}>
    <div className="control-demo-heading">
      <span>{t('control.demo.title')}</span>
      <button type="button" aria-label={t(paused ? 'control.demo.play' : 'control.demo.pause')} aria-pressed={paused} onClick={() => setPaused(value => !value)}>
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">{paused ? <path d="m5 3 8 5-8 5z" /> : <path d="M4 3h3v10H4zm5 0h3v10H9z" />}</svg>
      </button>
    </div>
    <div className="control-demo-stage" role="img" aria-label={`${prompt} · ${observe} · ${act} · ${done}`}>
      <div className="control-demo-chat" aria-hidden="true">
        <div className="control-demo-bar"><span className="control-demo-dots"><i /><i /><i /></span><span>{team ? 'Claude Code' : 'Coffee CLI'}</span></div>
        <div className="control-demo-conversation">
          <div className="control-demo-bubble demo-motion">{prompt}</div>
          <div className="control-demo-steps">
            <span className="control-demo-observe demo-motion"><Check />{observe}</span>
            <span className="control-demo-act demo-motion"><Check />{act}</span>
            <span className="control-demo-done demo-motion"><Check />{done}</span>
          </div>
        </div>
        <div className="control-demo-input"><span className="control-demo-typing demo-motion">{prompt}</span><span className="control-demo-send demo-motion"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 13V3m-4 4 4-4 4 4" /></svg></span></div>
      </div>
      <div className="control-demo-desktop" aria-hidden="true">
        {team ? <OrchestrationWorkspace /> : <>
        <div className="control-demo-window">
          <div className="control-demo-bar"><span className="control-demo-dots"><i /><i /><i /></span><span>{kind === 'computer' ? t('control.demo.note') : 'Chrome'}</span><span className="control-demo-window-tools">− &nbsp; □ &nbsp; ×</span></div>
          {kind === 'browser' && <div className="control-demo-address"><span>‹ &nbsp; › &nbsp; ↻</span><span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="4" y="7" width="8" height="6" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>demo.local</span></div>}
          <div className="control-demo-document">
            {kind === 'computer' ? <div className="control-demo-original demo-motion"><span className="control-demo-document-icon">≡</span><strong>{t('control.demo.note')}</strong><p>{items.join(' · ')}</p><i /><i /></div> : <div className="control-demo-browser">
              <div className="control-demo-query"><span className="control-demo-query-text demo-motion">{t('control.demo.list')}</span><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg></div>
              <div className="control-demo-search-result demo-motion"><small>demo.local / checklist</small><strong>{t('control.demo.list')}</strong><i /><i /></div>
            </div>}
            <div className="control-demo-result demo-motion"><span className="control-demo-document-icon"><Check /></span><strong>{t('control.demo.list')}</strong>{items.map((item, index) => <span className={`control-demo-list-item control-demo-list-item-${index} demo-motion`} key={item}><span><Check /></span>{item}</span>)}</div>
          </div>
        </div>
        <span className="control-demo-cursor demo-motion"><svg viewBox="0 0 24 28"><path d="M3 2v20l5-5 4 8 4-2-4-8h8z" fill="var(--text-1)" stroke="var(--bg-app)" strokeWidth="1.5" strokeLinejoin="round" /></svg><i className="demo-motion" /></span>
        </>}
      </div>
    </div>
    <div className="control-demo-timeline" aria-hidden="true"><i className="demo-motion" /></div>
  </section>;
}
