import { useEffect, useState } from 'react';
import './PiWelcomeLogo.css';

const MARK = ['000.', '2.0.', '22.1', '2..1'];
const MARK_COLORS = ['coral', 'gold', 'blue'];

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
