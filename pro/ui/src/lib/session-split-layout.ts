export type SplitEdge = 'left' | 'right' | 'top' | 'bottom';

export type SessionSplitLayout =
  | { type: 'leaf'; sessionId: string }
  | { type: 'branch'; direction: 'horizontal' | 'vertical'; ratio: number; first: SessionSplitLayout; second: SessionSplitLayout };

export interface SessionSplitRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SessionSplitDivider {
  path: string;
  direction: 'horizontal' | 'vertical';
  left: number;
  top: number;
  width: number;
  height: number;
  ratio: number;
}

export function splitSessionIds(layout: SessionSplitLayout | null): string[] {
  if (!layout) return [];
  return layout.type === 'leaf' ? [layout.sessionId] : [...splitSessionIds(layout.first), ...splitSessionIds(layout.second)];
}

export function insertSessionSplit(layout: SessionSplitLayout | null, targetId: string, sessionId: string, edge: SplitEdge): SessionSplitLayout | null {
  if (!sessionId || !['left', 'right', 'top', 'bottom'].includes(edge)) return layout;
  if (!layout) return { type: 'leaf', sessionId };
  const ids = splitSessionIds(layout);
  if (ids.includes(sessionId) || !ids.includes(targetId) || ids.length >= 4) return layout;
  const insert = (node: SessionSplitLayout): SessionSplitLayout => {
    if (node.type === 'leaf') {
      if (node.sessionId !== targetId) return node;
      const added: SessionSplitLayout = { type: 'leaf', sessionId };
      const before = edge === 'left' || edge === 'top';
      return { type: 'branch', direction: edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical', ratio: 0.5, first: before ? added : node, second: before ? node : added };
    }
    const first = insert(node.first), second = insert(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return insert(layout);
}

export function removeSessionSplit(layout: SessionSplitLayout | null, sessionId: string): SessionSplitLayout | null {
  if (!layout) return null;
  if (layout.type === 'leaf') return layout.sessionId === sessionId ? null : layout;
  const first = removeSessionSplit(layout.first, sessionId), second = removeSessionSplit(layout.second, sessionId);
  if (!first) return second;
  if (!second) return first;
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

export function replaceSplitSession(layout: SessionSplitLayout | null, oldId: string, newId: string): SessionSplitLayout | null {
  if (!layout || !newId || oldId === newId || splitSessionIds(layout).includes(newId)) return layout;
  const replace = (node: SessionSplitLayout): SessionSplitLayout => {
    if (node.type === 'leaf') return node.sessionId === oldId ? { ...node, sessionId: newId } : node;
    const first = replace(node.first), second = replace(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return replace(layout);
}

export function setSessionSplitRatio(layout: SessionSplitLayout | null, path: string, ratio: number): SessionSplitLayout | null {
  if (!layout || !/^[01]*$/.test(path) || !Number.isFinite(ratio)) return layout;
  const bounded = Math.min(0.8, Math.max(0.2, ratio));
  const update = (node: SessionSplitLayout, remaining: string): SessionSplitLayout => {
    if (node.type === 'leaf') return node;
    if (!remaining) return node.ratio === bounded ? node : { ...node, ratio: bounded };
    const key = remaining[0] === '0' ? 'first' : 'second';
    const child = update(node[key], remaining.slice(1));
    return child === node[key] ? node : { ...node, [key]: child };
  };
  return update(layout, path);
}

export function sessionSplitRects(layout: SessionSplitLayout | null): { leaves: SessionSplitRect[]; dividers: SessionSplitDivider[] } {
  const leaves: SessionSplitRect[] = [], dividers: SessionSplitDivider[] = [];
  const visit = (node: SessionSplitLayout, path: string, left: number, top: number, width: number, height: number) => {
    if (node.type === 'leaf') { leaves.push({ id: node.sessionId, left, top, width, height }); return; }
    const { direction, ratio } = node;
    if (direction === 'horizontal') {
      const firstWidth = width * ratio;
      dividers.push({ path, direction, ratio, left: left + firstWidth, top, width: 0, height });
      visit(node.first, path + '0', left, top, firstWidth, height);
      visit(node.second, path + '1', left + firstWidth, top, width - firstWidth, height);
    } else {
      const firstHeight = height * ratio;
      dividers.push({ path, direction, ratio, left, top: top + firstHeight, width, height: 0 });
      visit(node.first, path + '0', left, top, width, firstHeight);
      visit(node.second, path + '1', left, top + firstHeight, width, height - firstHeight);
    }
  };
  if (layout) visit(layout, '', 0, 0, 100, 100);
  return { leaves, dividers };
}
