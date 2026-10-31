import { useEffect, useState } from 'react';
import DSH_RUNNING_WHALE from '../../icons-inline/dsh-running-whale.png';
import DSH_IDLE from '../../icons-inline/dsh-welcome-idle.gif';
import DSH_HAPPY from '../../icons-inline/dsh-welcome-happy.gif';
import DSH_CHEER from '../../icons-inline/dsh-welcome-cheer.gif';
import DSH_THINKING from '../../icons-inline/dsh-welcome-thinking.gif';
import DSH_TALKING from '../../icons-inline/dsh-welcome-talking.gif';

const WELCOME_ANIMATIONS = [
  { id: 'idle', src: DSH_IDLE },
  { id: 'happy', src: DSH_HAPPY },
  { id: 'cheer', src: DSH_CHEER },
  { id: 'thinking', src: DSH_THINKING },
  { id: 'talking', src: DSH_TALKING },
];

export function DshWelcomeIcon({ isActive }: { isActive: boolean }) {
  const [icon] = useState(() => WELCOME_ANIMATIONS[Math.floor(Math.random() * WELCOME_ANIMATIONS.length)]);
  const [motionAllowed, setMotionAllowed] = useState(() => !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setMotionAllowed(!document.hidden && !motion.matches);
    motion.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => { motion.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  // A GIF cannot pause, so a hidden tab drops the image instead of decoding it.
  return <span className="dsh-welcome-icon" aria-hidden="true" data-welcome-icon={icon.id}>
    {isActive && motionAllowed
      ? <img src={icon.src} alt="" />
      : <span className="dsh-welcome-still" style={{ maskImage: `url(${DSH_RUNNING_WHALE})`, WebkitMaskImage: `url(${DSH_RUNNING_WHALE})` }} />}
  </span>;
}
