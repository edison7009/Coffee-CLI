import { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { commands } from '../../tauri';
import type { SavedSession } from '../../tauri';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { registerTabActions } from '../../lib/tab-actions';
import { MarkdownContent } from './MarkdownContent';
import './ChatReader.css';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking: string | null;
  turn_count?: number;
}

export function ChatReader({ sessionId }: { sessionId: string }) {
  const t = useT();
  const { state, dispatch } = useAppState();

  const terminal = state.terminals.find(t => t.id === sessionId);
  let currentSession: SavedSession | null = null;
  if (terminal?.toolData) {
    try {
      currentSession = JSON.parse(terminal.toolData) as SavedSession;
    } catch(e) {}
  }
  
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const toolDataStr = terminal?.toolData;

  useEffect(() => {
    let session: SavedSession | null = null;
    if (toolDataStr) {
      try { session = JSON.parse(toolDataStr); } catch(e) {}
    }
    
    if (!session) {
      setLoading(false);
      return;
    }

    // OpenCode stores chat history in SQLite (current) or a per-message
    // JSON dir (legacy) — neither maps to a single readable jsonl file,
    // so it has no `file_path`. Route those sessions through the
    // dedicated reader, which normalizes both layouts to the same
    // jsonl shape the parser below already handles. All other tools
    // (Claude / Codex / Gemini / Hermes) keep their direct file path.
    const isOpencode = session.tool === 'opencode' && !!session.session_token;
    if (!isOpencode && !session.file_path) {
      setLoading(false);
      return;
    }

    let isMounted = true;
    setLoading(true);

    const readPromise = isOpencode
      ? commands.readOpencodeSession(session.session_token!)
      : commands.readNativeSession(session.file_path!);

    readPromise
      .then((raw) => {
        if (!isMounted) return;
        
        const lines = raw.split('\n').filter(l => l.trim() !== '');
        const thread: ChatMessage[] = [];

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            let msgObj = parsed.message;
            if (!msgObj && parsed.payload && parsed.payload.type === 'message') {
              msgObj = parsed.payload;
            }

            // Gemini / Qwen format adapter — both use `type: '...'` at the
            // row root instead of `message.role`, but with two different
            // sub-shapes:
            //   • Gemini  : { type: 'user'|'gemini',     content: [{text}] }
            //   • Qwen    : { type: 'user'|'assistant',  message: { role, parts: [{text}] } }
            // Detect Qwen first (has `message.parts`), fall back to Gemini.
            // Either path gets normalized to the Claude shape so the parser
            // below ({type:'text', text} blocks) handles all three CLIs in
            // one code path.
            if (
              !msgObj &&
              (parsed.type === 'user' ||
                parsed.type === 'assistant' ||
                parsed.type === 'gemini')
            ) {
              let role: string | null = null;
              let rawBlocks: any[] | null = null;
              if (parsed.message && Array.isArray(parsed.message.parts)) {
                // Qwen
                role = parsed.message.role || (parsed.type === 'assistant' ? 'assistant' : 'user');
                rawBlocks = parsed.message.parts;
              } else if (Array.isArray(parsed.content)) {
                // Gemini
                role = parsed.type === 'gemini' ? 'assistant' : 'user';
                rawBlocks = parsed.content;
              }
              if (role && rawBlocks) {
                msgObj = {
                  role,
                  content: rawBlocks.map((b: any) => (b && !b.type ? { ...b, type: 'text' } : b)),
                };
              }
            }

            // Only care about entries that possess a "role"
            if (msgObj && msgObj.role) {
              const role = msgObj.role;
              let content = '';
              let thinking = null;

              if (role === 'user') {
                if (typeof msgObj.content === 'string') {
                  // Skip agent internal system prompts
                  if (msgObj.content.includes('Run your Session Startup sequence')) continue;
                  content = msgObj.content;
                } else if (Array.isArray(msgObj.content)) {
                  for (const block of msgObj.content) {
                    if (block.type === 'text' || block.type === 'input_text') {
                      // Skip automated environment_context and agent session startup prompts
                      if (block.text && typeof block.text === 'string') {
                        if (block.text.trim().startsWith('<environment_context>')) continue;
                        if (block.text.includes('Run your Session Startup sequence')) continue;
                      }
                      content += block.text || '';
                    }
                  }
                }
              } else if (role === 'assistant') {
                const blocks = Array.isArray(msgObj.content) 
                  ? msgObj.content 
                  : [{ type: 'text', text: msgObj.content || '' }];
                
                for (const block of blocks) {
                  if (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') content += block.text || '';
                  if (block.type === 'thinking') thinking = block.thinking;
                }
              }

              if (content.trim() !== '' || thinking) {
                thread.push({
                  id: parsed.uuid || crypto.randomUUID(),
                  role,
                  content,
                  thinking,
                  turn_count: parsed.turn_count
                });
              }
            }
          } catch (e) {
            // Ignore malformed json lines
          }
        }
        
        setMessages(thread);
        // useLayoutEffect below pins scroll to bottom synchronously after
        // React commits the messages, then clears `loading`. The "Loading…"
        // line and the messages share a single render: when messages
        // arrive, `loading && messages.length === 0` flips false in the
        // same commit so the two never overlap visually.
      })
      .catch(err => {
        console.error("Failed to read history jsonl", err);
        setLoading(false);
      });

    return () => { isMounted = false; };
  }, [toolDataStr]);

  // After messages commit to the DOM (synchronous, before browser paint),
  // pin scroll to the very bottom; user lands on the latest message.
  // Re-pin at 200ms catches async layout shifts from image / font loads
  // that grow content height after our initial measurement.
  useLayoutEffect(() => {
    if (messages.length === 0) return;
    const pin = () => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    };
    pin();
    setLoading(false);
    const t = setTimeout(pin, 200);
    return () => clearTimeout(t);
  }, [messages]);

  // Register tab-actions so Gambit anchors near the bottom of the chat
  // body (matching its terminal-tab behavior) instead of falling back to
  // the top-left default. Send / drop are no-ops here — a history session
  // has no live PTY to receive text; the user must click ⤴ Continue to
  // resume into a real terminal first.
  useEffect(() => {
    return registerTabActions(sessionId, {
      paste: () => false,
      insertText: () => false,
      cursorScreenPos: () => {
        const el = scrollRef.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.bottom };
      },
    });
  }, [sessionId]);

  if (!currentSession) return null;

  const handleResume = () => {
    if (!currentSession?.session_token) return;

    let targetId = state.activeTerminalId;
    const currentTerminal = state.terminals.find(t => t.id === targetId);

    if (currentTerminal?.tool !== null) {
      targetId = crypto.randomUUID();
      dispatch({
        type: 'ADD_TERMINAL',
        session: { id: targetId, tool: currentSession.tool as any, folderPath: currentSession.cwd }
      });
    } else if (targetId) {
      dispatch({ type: 'SET_TERMINAL_TOOL', id: targetId, tool: currentSession.tool as any });
      dispatch({ type: 'SET_FOLDER', path: currentSession.cwd });
    }

    if (!targetId) return;

    commands.tierTerminalResume(
      currentSession.id, targetId, currentSession.tool, currentSession.session_token, 80, 24, currentSession.cwd
    ).catch(console.error);
  };

  return (
    <div className="chat-reader-container">
      <button className="chat-reader-resume" onClick={handleResume}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="5 12 12 5 19 12"></polyline>
          <line x1="12" y1="19" x2="12" y2="5"></line>
        </svg>
        {t('action.resume_terminal' as any) || 'Continue this session'}
      </button>

      <div className="chat-reader-body" ref={scrollRef}>
        {/* Minimal "Loading…" text, shown only while data hasn't arrived
         * yet. The moment setMessages fires, messages.length > 0, this
         * disappears in the same render commit as messages appear, so
         * the two never visually overlap. VS Code chat history pattern. */}
        {loading && messages.length === 0 && (
          <div className="chat-reader-loading">{t('diff.loading' as any) || 'Loading…'}</div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`chat-message-row ${msg.role}`}>
            <div className="chat-bubble">
              {msg.thinking && (
                <div className="chat-thinking">
                  <div className="chat-thinking-header">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"></circle>
                      <polyline points="12 6 12 12 16 14"></polyline>
                    </svg>
                    Thinking Process
                  </div>
                  {msg.thinking}
                </div>
              )}
              {msg.content && (
                <div className="chat-text">
                  <MarkdownContent content={msg.content} />
                </div>
              )}
            </div>
          </div>
        ))}

        {!loading && messages.length === 0 && (
          <div className="chat-empty-state">
            {t('chat.no_records')}
          </div>
        )}
      </div>
    </div>
  );
}
