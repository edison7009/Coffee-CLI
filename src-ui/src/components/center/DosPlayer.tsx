// DosPlayer.tsx — DOS Game Arcade (Coffee Play)
// Uses the low-level `emulators` API (pure WASM DOSBox, no Preact/Redux).
// Renders DOSBox output to a <canvas> and captures keyboard/mouse input.

import { useState, useEffect, useCallback, useRef } from 'react';
import { isTauri, commands } from '../../tauri';
import { useAppState } from '../../store/app-state';
import './DosPlayer.css';

// ─── IndexedDB File-Level Save Storage ───
const SAVE_FILE_PATTERNS = [
  /^\d+\.RPG$/i,     // Paladin (Sword and Fairy)
  /^SETUP\.DAT$/i,   // Paladin Config
  /\.SAV$/i,         // Red Alert, Richman 3, common DOS saves
  /\.DSG$/i,         // DOOM saves
  /\.SC2$/i          // SimCity 2000 saves
];

const initDB = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open('CoffeePlaySaves', 2);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('files')) {
      db.createObjectStore('files');
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

interface SavedFile { path: string; contents: Uint8Array }

const saveGameFiles = async (gameId: string, files: SavedFile[]) => {
  if (files.length === 0) return;
  try {
    const db = await initDB();
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    for (const f of files) {
      store.put(f.contents, `${gameId}::${f.path}`);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('[DosPlayer] Failed to save game files:', e);
  }
};

const loadGameFiles = async (gameId: string): Promise<SavedFile[]> => {
  try {
    const db = await initDB();
    const tx = db.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    const allKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const prefix = `${gameId}::`;
    const matchingKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(prefix)) as string[];
    const files: SavedFile[] = [];
    for (const key of matchingKeys) {
      const data = await new Promise<Uint8Array | null>((resolve, reject) => {
        const tx2 = db.transaction('files', 'readonly');
        const req = tx2.objectStore('files').get(key);
        req.onsuccess = () => resolve(req.result as Uint8Array || null);
        req.onerror = () => reject(req.error);
      });
      if (data) {
        files.push({ path: key.slice(prefix.length), contents: data });
      }
    }
    return files;
  } catch (e) {
    console.error('[DosPlayer] Failed to load game files:', e);
    return [];
  }
};

const extractSaveFiles = async (ci: any): Promise<SavedFile[]> => {
  const files: SavedFile[] = [];
  try {
    const tree = await ci.fsTree();
    const walk = (node: any, parentPath: string) => {
      if (!node) return;
      const name = node.name || '';
      const fullPath = parentPath ? `${parentPath}/${name}` : name;
      if (node.nodes) {
        for (const child of node.nodes) walk(child, fullPath);
      } else {
        if (SAVE_FILE_PATTERNS.some(p => p.test(name))) {
          files.push({ path: name, contents: new Uint8Array(0) });
        }
      }
    };
    walk(tree, '');
    for (let i = 0; i < files.length; i++) {
      try {
        files[i].contents = await ci.fsReadFile(files[i].path);
      } catch { /* file may not exist yet */ }
    }
    return files.filter(f => f.contents.length > 0);
  } catch (e) {
    console.error('[DosPlayer] Failed to extract save files:', e);
    return [];
  }
};

interface GameBundle { name: string; path: string; size: number }

// emulators is loaded globally from index.html
declare const emulators: any;

export function DosPlayer({ sessionId }: { sessionId: string }) {
  const { state, dispatch } = useAppState();
  const [games, setGames] = useState<GameBundle[]>([]);
  const [activeGame, setActiveGame] = useState<{name: string, url: string} | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const userMutedRef = useRef(false);
  const ciRef = useRef<any>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const activeGameRef = useRef<{name: string, url: string} | null>(null);
  activeGameRef.current = activeGame;

  // ── Startup splash ──
  const [showSplash, setShowSplash] = useState(true);
  const [splashFading, setSplashFading] = useState(false);
  const firstFrameRef = useRef(false);
  const splashStartRef = useRef(Date.now());
  const frameCountRef = useRef(0);

  // Emergency save
  useEffect(() => {
    const emergencySave = () => {
      const ci = ciRef.current;
      const game = activeGameRef.current;
      if (ci && game) {
        extractSaveFiles(ci).then(files => saveGameFiles(game.name, files)).catch(() => {});
      }
    };
    const onBeforeUnload = () => emergencySave();
    const onVisChange = () => { if (document.hidden) emergencySave(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, []);

  // Load available games
  useEffect(() => {
    if (!isTauri) { setLoading(false); return; }
    commands.listJsdosBundles()
      .then((bundles: GameBundle[]) => { 
        if (!bundles.some(b => b.name.toLowerCase().includes('pal'))) {
          bundles.push({
            name: 'pal.jsdos',
            path: 'https://6.binary.dos.lol/48a58be784ad5b08135a4b0f9fc18a32b42c827f0901ddf7787422556cff64da.zip',
            size: 0
          });
        }
        setGames(bundles); 
        setLoading(false); 
      })
      .catch(() => setLoading(false));
  }, []);

  // Report game state
  useEffect(() => {
    dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: activeGame ? 'working' : 'idle' });
  }, [activeGame, dispatch, sessionId]);

  // ── Launch emulator ──
  useEffect(() => {
    if (!activeGame) return;

    let cancelled = false;

    (async () => {
      try {
        if (typeof emulators === 'undefined') {
          setError('DOSBox engine not loaded');
          return;
        }

        emulators.pathPrefix = '/js-dos/emulators/';

        const response = await fetch(activeGame.url);
        if (!response.ok) throw new Error(`Failed to fetch ${activeGame.url}: ${response.status}`);
        const bundleData = new Uint8Array(await response.arrayBuffer());

        const savedFiles = await loadGameFiles(activeGame.name);
        if (cancelled) return;

        const initFs: any[] = [bundleData];
        for (const f of savedFiles) {
          initFs.push({ path: f.path, contents: f.contents });
        }

        const ci = await emulators.dosboxWorker(initFs);
        if (cancelled) { ci.exit(); return; }

        ciRef.current = ci;
        console.log('[DosPlayer] Emulator started, CI:', Object.keys(ci));

        // ── Render frames to canvas ──
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let imgData: ImageData | null = null;

        ci.events().onFrameSize((w: number, h: number) => {
          canvas.width = w;
          canvas.height = h;
          imgData = ctx.createImageData(w, h);
        });

        ci.events().onFrame((rgb: Uint8Array) => {
          if (!imgData) return;
          const pixels = imgData.data;
          let si = 0, di = 0;
          const len = rgb.length / 3;
          for (let i = 0; i < len; i++) {
            pixels[di++] = rgb[si++];
            pixels[di++] = rgb[si++];
            pixels[di++] = rgb[si++];
            pixels[di++] = 255;
          }
          ctx.putImageData(imgData, 0, 0);

          frameCountRef.current++;
          if (!firstFrameRef.current) {
            const elapsed = Date.now() - splashStartRef.current;
            if (elapsed > 4000 && frameCountRef.current > 30) {
              firstFrameRef.current = true;
              setSplashFading(true);
              setTimeout(() => setShowSplash(false), 600);
            }
          }
        });

        // ── Audio ──
        const audioCtx = new AudioContext({ sampleRate: ci.soundFrequency() || 44100 });
        audioCtxRef.current = audioCtx;
        const bufferSize = 2048;
        let audioQueue: Float32Array[] = [];

        ci.events().onSoundPush((samples: Float32Array) => {
          audioQueue.push(new Float32Array(samples));
        });

        const scriptNode = audioCtx.createScriptProcessor(bufferSize, 0, 1);
        scriptNode.onaudioprocess = (e: AudioProcessingEvent) => {
          const output = e.outputBuffer.getChannelData(0);
          let offset = 0;
          while (offset < output.length && audioQueue.length > 0) {
            const chunk = audioQueue[0];
            const needed = output.length - offset;
            if (chunk.length <= needed) {
              output.set(chunk, offset);
              offset += chunk.length;
              audioQueue.shift();
            } else {
              output.set(chunk.subarray(0, needed), offset);
              audioQueue[0] = chunk.subarray(needed);
              offset = output.length;
            }
          }
          for (let i = offset; i < output.length; i++) output[i] = 0;
        };
        scriptNode.connect(audioCtx.destination);

        const resumeAudio = () => { if (!userMutedRef.current && state.activeTerminalId === sessionId) audioCtx.resume(); };
        document.addEventListener('click', resumeAudio, { once: true });
        document.addEventListener('keydown', resumeAudio, { once: true });

        // ── Keyboard input ──
        // DOSBox KBD enum values match DOM keyCode directly for letters & numbers.
        // Only special keys need mapping (arrows, function keys, etc.)
        const specialKeyMap: Record<number, number> = {
          8: 259,   // Backspace → KBD_backspace
          9: 258,   // Tab → KBD_tab
          13: 257,  // Enter → KBD_enter
          16: 340,  // Shift → KBD_leftshift (Pa=340)
          17: 341,  // Ctrl → KBD_leftctrl (Sa=341)
          18: 342,  // Alt → KBD_leftalt (Ca=342)
          19: 284,  // Pause → KBD_pause
          27: 256,  // Escape → KBD_esc
          33: 266,  // PageUp → KBD_pageup
          34: 267,  // PageDown → KBD_pagedown
          35: 269,  // End → KBD_end
          36: 268,  // Home → KBD_home
          37: 263,  // ArrowLeft → KBD_left
          38: 265,  // ArrowUp → KBD_up
          39: 262,  // ArrowRight → KBD_right
          40: 264,  // ArrowDown → KBD_down
          45: 260,  // Insert → KBD_insert (was 277❌)
          46: 261,  // Delete → KBD_delete
          112: 290, // F1 → KBD_f1 (was 282❌)
          113: 291, // F2 → KBD_f2
          114: 292, // F3 → KBD_f3
          115: 293, // F4 → KBD_f4
          116: 294, // F5 → KBD_f5
          117: 295, // F6 → KBD_f6
          118: 296, // F7 → KBD_f7
          119: 297, // F8 → KBD_f8
          120: 298, // F9 → KBD_f9
          121: 299, // F10 → KBD_f10
          122: 300, // F11 → KBD_f11
          123: 301, // F12 → KBD_f12
          144: 282, // NumLock → KBD_numlock
          145: 281, // ScrollLock → KBD_scrolllock
        };
        const codeToDom: Record<string, number> = {
          ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
          Enter: 13, Space: 32, Escape: 27, Backspace: 8, Tab: 9,
          ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17,
          AltLeft: 18, AltRight: 18,
          KeyA: 65, KeyB: 66, KeyC: 67, KeyD: 68, KeyE: 69, KeyF: 70,
          KeyG: 71, KeyH: 72, KeyI: 73, KeyJ: 74, KeyK: 75, KeyL: 76,
          KeyM: 77, KeyN: 78, KeyO: 79, KeyP: 80, KeyQ: 81, KeyR: 82,
          KeyS: 83, KeyT: 84, KeyU: 85, KeyV: 86, KeyW: 87, KeyX: 88,
          KeyY: 89, KeyZ: 90,
          Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52,
          Digit5: 53, Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57,
          F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
          F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
        };

        const gameKeyHandler = (e: KeyboardEvent, pressed: boolean) => {
          // F9/F10/F12 reserved for Coffee CLI / DevTools
          if (e.code === 'F10' || e.code === 'F9' || e.code === 'F12') return;
          let domKc = e.keyCode;
          if (domKc === 229 || domKc === 0) {
            domKc = codeToDom[e.code] ?? -1;
          }
          if (domKc < 0) return;
          // Use special mapping for control/nav keys, pass DOM keyCode directly for letters/numbers
          const dosKc = specialKeyMap[domKc] ?? domKc;
          e.preventDefault();
          e.stopPropagation();
          ci.sendKeyEvent(dosKc, pressed);
        };
        const onKeyDown = (e: KeyboardEvent) => gameKeyHandler(e, true);
        const onKeyUp = (e: KeyboardEvent) => gameKeyHandler(e, false);

        // Register on window with capture — earliest possible interception
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);

        canvas.setAttribute('inputmode', 'none');
        canvas.setAttribute('autocomplete', 'off');

        // ── Mouse input ──
        // Only FPS/RTS games need Pointer Lock (cursor confinement)
        const needsPointerLock = activeGame?.name.includes('doom') || activeGame?.name.includes('redalert');
        let virtualX = 0.5, virtualY = 0.5;

        canvas.addEventListener('pointermove', (e: PointerEvent) => {
          if (needsPointerLock && document.pointerLockElement === canvas) {
            const rect = canvas.getBoundingClientRect();
            virtualX += e.movementX / rect.width;
            virtualY += e.movementY / rect.height;
          } else {
            const rect = canvas.getBoundingClientRect();
            virtualX = (e.clientX - rect.left) / rect.width;
            virtualY = (e.clientY - rect.top) / rect.height;
          }
          virtualX = Math.max(0, Math.min(1, virtualX));
          virtualY = Math.max(0, Math.min(1, virtualY));
          ci.sendMouseMotion(virtualX, virtualY);
        });
        canvas.addEventListener('pointerdown', (e: PointerEvent) => {
          e.preventDefault();
          canvas.focus();
          if (needsPointerLock && document.pointerLockElement !== canvas) {
            canvas.requestPointerLock();
          }
          ci.sendMouseButton(e.button === 0 ? 0 : 1, true);
        });
        canvas.addEventListener('pointerup', (e: PointerEvent) => {
          e.preventDefault();
          ci.sendMouseButton(e.button === 0 ? 0 : 1, false);
        });
        canvas.addEventListener('contextmenu', (e: Event) => e.preventDefault());
        canvas.focus();

        // Auto save timer
        const autoSaveTimer = setInterval(async () => {
          if (ciRef.current) {
            try {
              const files = await extractSaveFiles(ciRef.current);
              if (files.length > 0) await saveGameFiles(activeGame.name, files);
            } catch (e) { console.error('[DosPlayer] Auto-save failed:', e); }
          }
        }, 10000);

        cleanupRef.current = () => {
          clearInterval(autoSaveTimer);
          if (ciRef.current) {
            extractSaveFiles(ciRef.current)
              .then(files => saveGameFiles(activeGame.name, files))
              .catch(() => {});
          }
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('keyup', onKeyUp, true);
          scriptNode.disconnect();
          audioCtx.close().catch(() => {});
        };

      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Failed to start DOSBox');
          console.error('[DosPlayer]', err);
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (ciRef.current) {
        const finalCi = ciRef.current;
        const currentActive = activeGame;
        extractSaveFiles(finalCi)
          .then(files => currentActive ? saveGameFiles(currentActive.name, files) : null)
          .then(() => finalCi.exit())
          .catch(() => { finalCi.exit(); });
        ciRef.current = null;
      }
    };
  }, [activeGame]);

  // ── F9 Mute / F10 Boss Key ──
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!activeGame) return;

    if (e.key === 'F9') {
      e.preventDefault();
      userMutedRef.current = !userMutedRef.current;
      if (userMutedRef.current) {
        audioCtxRef.current?.suspend().catch(() => {});
      } else {
        if (state.activeTerminalId === sessionId) {
          audioCtxRef.current?.resume().catch(() => {});
        }
      }
    }

    if (e.key === 'F10') {
      e.preventDefault();
      const isActiveTab = state.activeTerminalId === sessionId;
      
      if (isActiveTab) {
        if (ciRef.current) {
          try { ciRef.current.pause(); } catch(e) {}
          audioCtxRef.current?.suspend().catch(() => {});
          extractSaveFiles(ciRef.current)
            .then(files => saveGameFiles(activeGame.name, files))
            .catch(() => {});
        }
        dispatch({ type: 'SET_TERMINAL_HIDDEN', id: sessionId, isHidden: true });
        
        const otherTabs = state.terminals.filter(t => t.id !== sessionId);
        if (otherTabs.length > 0) {
          dispatch({ type: 'SET_ACTIVE_TERMINAL', id: otherTabs[0].id });
        } else {
          dispatch({ 
            type: 'ADD_TERMINAL', 
            session: { id: crypto.randomUUID(), tool: null, folderPath: null, scanData: null, agentStatus: 'idle', menu: null, hasInputText: false } 
          });
        }
      } else {
        dispatch({ type: 'SET_TERMINAL_HIDDEN', id: sessionId, isHidden: false });
        dispatch({ type: 'SET_ACTIVE_TERMINAL', id: sessionId });
        if (ciRef.current) {
          try { ciRef.current.resume(); } catch(e) {}
          if (!userMutedRef.current) {
            audioCtxRef.current?.resume().catch(() => {});
          }
        }
        setTimeout(() => canvasRef.current?.focus(), 100);
      }
    }
  }, [activeGame, state.activeTerminalId, state.terminals, dispatch, sessionId]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);


  const handleLaunch = (game: GameBundle) => {
    setActiveGame({
      name: game.name,
      url: game.path.startsWith('http') ? game.path : `/play/${game.name}`
    });
    setError(null);
    firstFrameRef.current = false;
    splashStartRef.current = Date.now();
    frameCountRef.current = 0;
    setShowSplash(true);
    setSplashFading(false);
  };

  // Game info lookup — icon + localized title for each game
  const getGameInfo = (name: string): { icon: string; title: string } => {
    const n = name.toLowerCase();
    const zh = state.currentLang.startsWith('zh');
    if (n.includes('redalert'))    return { icon: '/icons/redalert.png',    title: zh ? '\u7ea2\u8272\u8b66\u6212' : 'Red Alert' };
    if (n.includes('doom'))        return { icon: '/icons/doom.png',        title: zh ? '\u6bc1\u706d\u516c\u7235' : 'DOOM' };
    if (n.includes('pal'))         return { icon: '/icons/pal.jpg',         title: zh ? '\u4ed9\u5251\u5947\u4fa0\u4f20' : 'Sword and Fairy' };
    if (n.includes('richman'))     return { icon: '/icons/richman3.png',    title: zh ? '\u5927\u5bcc\u7fc13' : 'Richman 3' };
    if (n.includes('simcity'))     return { icon: '/icons/simcity2000.png', title: zh ? '\u6a21\u62df\u57ce\u5e022000' : 'SimCity 2000' };
    return { icon: '', title: name.replace(/\.jsdos$/i, '').replace(/[_-]/g, ' ') };
  };

  // ── Error ──
  if (error) {
    return (
      <div className="dos-player-container">
        <div className="dos-loading" style={{ color: '#C4956A' }}>{error}</div>
      </div>
    );
  }

  // ── Game Picker ──
  const currentSession = state.terminals.find(t => t.id === sessionId);
  const requestedGame = currentSession?.toolData;

  if (!activeGame) {
    if (!loading && requestedGame && games.length > 0) {
      const match = games.find(g => g.name.toLowerCase() === requestedGame.toLowerCase());
      if (match) { handleLaunch(match); return null; }
    }
    if (!loading && games.length === 1) { handleLaunch(games[0]); return null; }
    if (!loading && games.length === 0) {
      dispatch({ type: 'SET_TERMINAL_TOOL', id: sessionId, tool: null });
      return null;
    }
    if (loading) {
      return (<div className="launchpad-container"><div className="dos-loading">Loading...</div></div>);
    }

    return (
      <div className="launchpad-container">
        <div className="launchpad-inner">
          {games.length > 0 ? (
            <div className="launchpad-grid">
              {games.map(game => {
                const n = game.name.toLowerCase();
                const zh = state.currentLang.startsWith('zh');
                const info = 
                  n.includes('redalert') ? { icon: '/icons/redalert.png', title: zh ? '\u7ea2\u8272\u8b66\u6212' : 'Red Alert' } :
                  n.includes('doom')     ? { icon: '/icons/doom.png',     title: zh ? '\u6bc1\u706d\u516c\u7235' : 'DOOM' } :
                  n.includes('pal')      ? { icon: '/icons/pal.jpg',      title: zh ? '\u4ed9\u5251\u5947\u4fa0\u4f20' : 'Sword and Fairy' } :
                  n.includes('richman')  ? { icon: '/icons/richman3.png', title: zh ? '\u5927\u5bcc\u7fc13' : 'Richman 3' } :
                  n.includes('simcity')  ? { icon: '/icons/simcity2000.png', title: zh ? '\u6a21\u62df\u57ce\u5e022000' : 'SimCity 2000' } :
                  { icon: '', title: game.name.replace(/\.jsdos$/i, '') };
                return (
                  <div key={game.name} className="launchpad-card" onClick={() => handleLaunch(game)}>
                    <div className="launchpad-icon">
                      {info.icon 
                        ? <img src={info.icon} alt={info.title} style={{ width: '1.4em', height: '1.4em', borderRadius: 4, objectFit: 'cover' }} />
                        : '\ud83c\udfae'}
                    </div>
                    <span>{info.title}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="dos-empty-hint">
              No games found.<br />
              Place <code>.jsdos</code> bundles in the <code>play/</code> folder<br />
              next to the Coffee CLI executable.
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Game Running ──
  return (
    <div className="dos-player-container" style={{ position: 'relative' }}>
      <canvas
        ref={canvasRef}
        className="dos-canvas"
        tabIndex={0}
      />

      {showSplash && (
        <div
          className={`tier-loading-splash ${splashFading ? 'fade-out' : ''}`}
          style={{ background: 'var(--bg-app)' }}
        >
          <div className="splash-group">
            <div className="splash-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <mask id={`splashMask-dos-${sessionId}`}>
                    <path fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                      d="M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4">
                      <animate attributeName="d" dur="3s" repeatCount="indefinite"
                        values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"/>
                    </path>
                    <path d="M4 7h16v0h-16v12h16v-32h-16Z">
                      <animate fill="freeze" attributeName="d" begin="1s" dur="0.6s" to="M4 2h16v5h-16v12h16v-24h-16Z"/>
                    </path>
                  </mask>
                </defs>
                <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
                  <path fill="currentColor" fillOpacity="0" strokeDasharray="48"
                    d="M17 9v9c0 1.66 -1.34 3 -3 3h-6c-1.66 0 -3 -1.34 -3 -3v-9Z">
                    <animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="48;0"/>
                    <animate fill="freeze" attributeName="fill-opacity" begin="1.6s" dur="0.4s" to="1"/>
                  </path>
                  <path fill="none" strokeDasharray="16" strokeDashoffset="16"
                    d="M17 9h3c0.55 0 1 0.45 1 1v3c0 0.55 -0.45 1 -1 1h-3">
                    <animate fill="freeze" attributeName="stroke-dashoffset" begin="0.6s" dur="0.3s" to="0"/>
                  </path>
                </g>
                <path fill="currentColor" d="M0 0h24v24H0z" mask={`url(#splashMask-dos-${sessionId})`}/>
              </svg>
            </div>
            <span
              className="splash-label"
              style={state.currentLang.startsWith('zh') ? { fontStyle: 'normal', fontWeight: 600, letterSpacing: '0.08em' } : undefined}
            >{(() => {
              if (activeGame) {
                return getGameInfo(activeGame.name).title;
              }
              return 'Loading...';
            })()}</span>
            <div className="splash-dots">
              <span className="splash-dot" />
              <span className="splash-dot" />
              <span className="splash-dot" />
            </div>
          </div>
        </div>
      )}

      {/* ── Minimalist Hotkey HUD ── */}
      {!showSplash && (
        <div className="dos-hud-hint">
          <span>[F9] {state.currentLang.startsWith('zh') ? '静音' : 'Mute'}</span>
          <span className="separator">·</span>
          <span>[F10] {state.currentLang.startsWith('zh') ? '老板键' : 'Boss Key'}</span>
        </div>
      )}
    </div>
  );
}
