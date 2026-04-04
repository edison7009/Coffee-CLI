// Compiler.tsx — Right panel: terminal remote control + context guide

import { useState, useEffect, useCallback } from 'react';
import { useAppState } from '../../store/app-state';
import { commands } from '../../tauri';
import './Compiler.css';

// ─── Guide Tips ──────────────────────────────────────────────────────────────
// Data sourced from tool-specific dictionary (supports i18n)
// TODO: load dynamically via Tauri command for user-editable dictionaries

import claudeCodeDict from '../../../../src/dictionaries/claude-code/zh-CN.json';

const GUIDE_TIPS: { title: string; body: string }[] = claudeCodeDict.tips ?? [];
const COMMAND_GUIDES: Record<string, string> = claudeCodeDict.guides ?? {};

// Rotate tips every 10 seconds
function useTipRotation() {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * GUIDE_TIPS.length));
  const [animClass, setAnimClass] = useState('guide-anim-idle');

  const advance = useCallback((direction: 'next' | 'prev' = 'next') => {
    // Slide out
    setAnimClass(direction === 'next' ? 'guide-anim-out-left' : 'guide-anim-out-right');

    // After out animation finishes, swap content and slide in
    setTimeout(() => {
      setIdx(current => {
        if (direction === 'next') return (current + 1) % GUIDE_TIPS.length;
        return (current - 1 + GUIDE_TIPS.length) % GUIDE_TIPS.length;
      });
      setAnimClass(direction === 'next' ? 'guide-anim-in-right' : 'guide-anim-in-left');

      // Reset back to idle
      setTimeout(() => {
        setAnimClass('guide-anim-idle');
      }, 300);
    }, 200);
  }, []);

  useEffect(() => {
    const t = setInterval(() => advance('next'), 10000);
    return () => clearInterval(t);
  }, [advance]);

  return { tip: GUIDE_TIPS[idx], animClass, advance };
}

// ─── Guide Panel (shown when idle & no menu) ─────────────────────────────────

function GuidePanel() {
  const { tip, animClass, advance } = useTipRotation();

  return (
    <div className="guide-panel">
      {/* Spacer pushes card to bottom */}
      <div style={{ flex: 1 }} />

      <div className="guide-card">
        <div className="guide-card-header">
          <div className="guide-card-nav">
            <button className="guide-nav-btn" onClick={() => advance('prev')} aria-label="Previous tip">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            </button>
            <button className="guide-nav-btn" onClick={() => advance('next')} aria-label="Next tip">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
          </div>
        </div>
        <div className="guide-card-viewport">
          <div className={`guide-card-slider ${animClass}`}>
            <div className="guide-card-title">{tip.title}</div>
            <div className="guide-card-body">{tip.body}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export function Compiler() {
  const { state } = useAppState();

  const activeTerminal = state.terminals.find(t => t.id === state.activeTerminalId);
  const hasMenu = !!(activeTerminal?.menu?.options && activeTerminal.menu.options.length > 0);

  // Global keyboard proxy for terminal TUI navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!activeTerminal?.menu?.options || activeTerminal.menu.options.length === 0) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        if (target.classList.contains('xterm-helper-textarea')) return;
        if (['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) return;
      }
      let keys = '';
      if (e.key === 'ArrowUp') keys = '\x1b[A';
      else if (e.key === 'ArrowDown') keys = '\x1b[B';
      else if (e.key === 'Enter') keys = '\r';
      else if (e.key === 'Escape') keys = '\x1b';

      if (keys) {
        e.preventDefault();
        commands.tierTerminalInput(activeTerminal.id, keys).catch(() => {});
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [activeTerminal?.id, activeTerminal?.menu?.options]);

  return (
    <div className="compiler-top">

      {/* ── Action buttons: Menu / Help ── */}
      <div className="compiler-action-menu">
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="menu-master-btn"
            style={{ flex: 1 }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (activeTerminal?.id) {
                if (hasMenu) {
                  commands.tierTerminalInput(activeTerminal.id, '\x7f').catch(() => {});
                } else {
                  commands.tierTerminalInput(activeTerminal.id, '/').catch(() => {});
                }
              }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="6" x2="20" y2="6" />
              <line x1="4" y1="18" x2="20" y2="18" />
            </svg>
            <span>Menu</span>
            <kbd>{hasMenu ? '\u2190' : '/'}</kbd>
          </button>

          <button
            className="menu-master-btn"
            style={{ flex: 1 }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (activeTerminal?.id) {
                if (hasMenu) {
                  commands.tierTerminalInput(activeTerminal.id, '\x7f').catch(() => {});
                } else {
                  commands.tierTerminalInput(activeTerminal.id, '?').catch(() => {});
                }
              }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span>{'\u5FEB\u6377\u952E'}</span>
            <kbd>{hasMenu ? '\u2190' : '?'}</kbd>
          </button>
        </div>

        {/* Dynamic menu list */}
        {hasMenu && (
          <div className="dynamic-menu-list">
            {activeTerminal!.menu!.options.map((opt) => (
              <button
                key={opt.index}
                className={`dynamic-menu-btn ${activeTerminal!.menu?.activeIndex === opt.index ? 'active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (activeTerminal?.id) {
                    if (opt.actionText !== null) {
                      commands.tierTerminalInput(activeTerminal.id, '\x15' + opt.actionText).catch(() => {});
                    } else {
                      if (activeTerminal.menu?.activeIndex !== undefined) {
                        const delta = opt.index - activeTerminal.menu.activeIndex;
                        let keys = '';
                        if (delta > 0) keys = '\x1b[B'.repeat(delta);
                        else keys = '\x1b[A'.repeat(Math.abs(delta));
                        keys += '\r';
                        commands.tierTerminalInput(activeTerminal.id, keys).catch(() => {});
                      }
                    }
                  }
                }}
              >
                {(() => {
                  const key = opt.badge?.toLowerCase() || opt.actionText?.toLowerCase() || '';
                  const guide = COMMAND_GUIDES[key];
                  if (guide) {
                    return <span className="dynamic-menu-guide">{guide}</span>;
                  }
                  return (
                    <>
                      <span className="dynamic-menu-idx">{opt.badge}</span>
                      <span className="dynamic-menu-text">{opt.text}</span>
                    </>
                  );
                })()}
              </button>
            ))}
          </div>
        )}

        {/* D-Pad — shown only when menu is open */}
        {hasMenu && (
          <div className="menu-remote-dpad">
            <button className="dpad-btn" onMouseDown={(e) => e.preventDefault()}
              onClick={() => activeTerminal?.id && commands.tierTerminalInput(activeTerminal.id, '\x1b').catch(() => {})}>
              <span style={{ fontSize: '11px', fontWeight: 'bold' }}>ESC</span>
            </button>
            <button className="dpad-btn" onMouseDown={(e) => e.preventDefault()}
              onClick={() => activeTerminal?.id && commands.tierTerminalInput(activeTerminal.id, '\x1b[B').catch(() => {})}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <button className="dpad-btn" onMouseDown={(e) => e.preventDefault()}
              onClick={() => activeTerminal?.id && commands.tierTerminalInput(activeTerminal.id, '\x1b[A').catch(() => {})}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="18 15 12 9 6 15"/>
              </svg>
            </button>
            <button className="dpad-btn" onMouseDown={(e) => e.preventDefault()}
              onClick={() => activeTerminal?.id && commands.tierTerminalInput(activeTerminal.id, '\x7f').catch(() => {})}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
              </svg>
            </button>
            <button className="dpad-btn dpad-enter" onMouseDown={(e) => e.preventDefault()}
              onClick={() => activeTerminal?.id && commands.tierTerminalInput(activeTerminal.id, '\r').catch(() => {})}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>
              </svg>
              <span>{'\u56DE\u8F66\u786E\u8BA4'}</span>
            </button>
          </div>
        )}
      </div>

      {/* ── Guide Panel (always visible) ── */}
      <div className="context-panel-area">
        <GuidePanel />
      </div>

    </div>
  );
}
