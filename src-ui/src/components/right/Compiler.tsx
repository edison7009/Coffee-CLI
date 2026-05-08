// RightPanel.tsx — Right panel: TaskBoard only.
// .compiler-top wrapper styling lives in global.css (same selector,
// kept around because changing the wrapper class would touch every
// theme rule that scopes to it).

import { TaskBoard } from './TaskBoard';

export function RightPanel() {
  return (
    <div className="compiler-top">
      <TaskBoard />
    </div>
  );
}
