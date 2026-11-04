import { useEffect, useState } from 'react';
import './PiWelcomeLogo.css';

// Pi's installer animation (pi.dev/install.sh): three pieces drop onto a turquoise row, the row
// flashes and clears, the logo settles, and it blinks white once. Grid rows 0–8, columns 1–8.
type Color = 'coral' | 'blue' | 'gold' | 'turquoise' | 'white' | 'flash';
type Piece = 'left' | 'top' | 'right' | 'none';
interface Frame { phase: number; active: Piece; ax: number; ay: number; flash: boolean; white: boolean; ms: number }

const cells = (list: string) => new Set(list.split(' '));
const PIECES: Record<Exclude<Piece, 'none'>, { color: Color; cells: Array<[number, number]> }> = {
  left: { color: 'blue', cells: [[0, 0], [1, 0], [1, 1], [2, 0]] },
  top: { color: 'coral', cells: [[0, 0], [0, 1], [0, 2], [1, 2]] },
  right: { color: 'gold', cells: [[0, 0], [1, 0], [2, 0], [2, 1]] },
};
const WHITE = cells('3,2 3,3 3,4 4,2 4,4 5,2 5,3 5,5 6,2 6,5');
const SHIFTED = { coral: cells('2,2 2,3 2,4 3,4'), blue: cells('3,2 4,2 4,3 5,2'), gold: cells('4,5 5,5') };
const SETTLED = { coral: cells('3,2 3,3 3,4 4,4'), blue: cells('4,2 5,2 5,3 6,2'), gold: cells('5,5 6,5') };
const LANDED = { floor: cells('6,1 6,2 6,3 6,4'), coral: cells('2,2 2,3 2,4 3,4'), blue: cells('3,2 4,2 4,3 5,2'), gold: cells('4,5 5,5 6,5 6,6') };

/** The installer's `set_logo_cell_color`, cell by cell. */
function color(f: Frame, y: number, x: number): Color | null {
  const at = `${y},${x}`;
  if (f.white) return WHITE.has(at) ? 'white' : null;
  if (f.flash && y === 6 && x >= 1 && x <= 6) return 'flash';
  if (f.active !== 'none') {
    const piece = PIECES[f.active];
    if (piece.cells.some(([dy, dx]) => y === f.ay + dy && x === f.ax + dx)) return piece.color;
  }
  if (f.phase === 4) return SHIFTED.coral.has(at) ? 'coral' : SHIFTED.blue.has(at) ? 'blue' : SHIFTED.gold.has(at) ? 'gold' : null;
  if (f.phase >= 5) return SETTLED.coral.has(at) ? 'coral' : SETTLED.blue.has(at) ? 'blue' : SETTLED.gold.has(at) ? 'gold' : null;
  if (f.phase <= 3 && LANDED.floor.has(at)) return 'turquoise';
  if (f.phase >= 2 && LANDED.coral.has(at)) return 'coral';
  if (f.phase >= 1 && LANDED.blue.has(at)) return 'blue';
  if (f.phase >= 3 && LANDED.gold.has(at)) return 'gold';
  return null;
}

const frame = (phase: number, active: Piece, ax: number, ay: number, flash: boolean, white: boolean, ms: number): Frame => ({ phase, active, ax, ay, flash, white, ms });
const FRAMES: Frame[] = [
  ...[0, 1, 2, 3].map(y => frame(0, 'left', 2, y, false, false, 75)),
  ...[0, 1, 2].map(y => frame(1, 'top', 2, y, false, false, 75)),
  ...[0, 1, 2, 3, 4].map(y => frame(2, 'right', 5, y, false, false, 75)),
  frame(3, 'none', 0, 0, false, false, 250),
  frame(3, 'none', 0, 0, true, false, 80),
  frame(3, 'none', 0, 0, false, false, 80),
  frame(3, 'none', 0, 0, true, false, 80),
  frame(4, 'none', 0, 0, false, false, 100),
  frame(5, 'none', 0, 0, false, false, 450),
  frame(5, 'none', 0, 0, false, true, 120),
  frame(5, 'none', 0, 0, false, false, 120),
  frame(5, 'none', 0, 0, false, true, 450),
];
// The installer ends on the white blink; the welcome screen keeps the colored logo.
const REST = frame(5, 'none', 0, 0, false, false, 0);
const ROWS = [0, 1, 2, 3, 4, 5, 6];
const COLUMNS = [1, 2, 3, 4, 5, 6];

/** Plays once per mount while the tab is visible; reduced motion shows the finished logo. */
export function PiWelcomeLogo({ isActive }: { isActive: boolean }) {
  const [index, setIndex] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? FRAMES.length : 0);
  const [played, setPlayed] = useState(false);
  useEffect(() => {
    if (!isActive || index >= FRAMES.length) return;
    const timer = setTimeout(() => { setIndex(i => i + 1); if (index === FRAMES.length - 1) setPlayed(true); }, FRAMES[index].ms);
    return () => clearTimeout(timer);
  }, [isActive, index]);
  const current = index < FRAMES.length ? FRAMES[index] : REST;
  // Clicking the finished logo plays it again, as clicking Pi's header logo does.
  return <button type="button" className="pi-welcome-logo" aria-hidden="true" tabIndex={-1} onClick={() => { if (played || index >= FRAMES.length) { setPlayed(false); setIndex(0); } }}>
    {ROWS.map(y => COLUMNS.map(x => { const c = color(current, y, x); return <span key={`${y}-${x}`} className={c ? `is-${c}` : undefined} />; }))}
  </button>;
}


// The logo's three pieces, clockwise from the top: coral bar, gold stem, blue hook.
const MARK = ['000.', '2.0.', '22.1', '2..1'];
const MARK_COLORS = ['coral', 'gold', 'blue'];

/** The Pi logo whose three colors move clockwise from piece to piece while Pi works. */
export function PiMark({ spinning = true }: { spinning?: boolean }) {
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (!spinning || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => setTurn(t => t + 1), 260);
    return () => clearInterval(timer);
  }, [spinning]);
  return <span className="pi-mark" aria-hidden="true">
    {MARK.join('').split('').map((piece, i) => <span key={i} className={piece === '.' ? undefined : `is-${MARK_COLORS[(Number(piece) - turn % 3 + 3) % 3]}`} />)}
  </span>;
}
