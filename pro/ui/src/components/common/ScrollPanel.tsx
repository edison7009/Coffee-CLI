// ScrollPanel — The shared scrollable container component
// Solves the long-standing flex + overflow CSS issue by encapsulating
// the correct flex constraints in one reusable component.

import './ScrollPanel.css';

interface ScrollPanelProps {
  children: React.ReactNode;
  className?: string;
  id?: string;
}

export function ScrollPanel({ children, className = '', id }: ScrollPanelProps) {
  return (
    <div className={`scroll-panel ${className}`} id={id}>
      {children}
    </div>
  );
}
