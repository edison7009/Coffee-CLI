// RightPanel.tsx — Right panel: TaskBoard only

import { TaskBoard } from './TaskBoard';
import './Compiler.css';

export function RightPanel() {
  return (
    <div className="compiler-top">
      <TaskBoard />
    </div>
  );
}
