import { useId, useMemo, type CSSProperties } from 'react';

export function InlineSvgIcon({ markup, size = '1em', style }: { markup: string; size?: string; style?: CSSProperties }) {
  const id = useId().replace(/:/g, '');
  const scoped = useMemo(() => {
    const ids = new Map<string, string>();
    for (const match of markup.matchAll(/\bid="([^"]+)"/g)) ids.set(match[1], `${id}-${match[1]}`);
    return markup.replace(/\bid="([^"]+)"/g, (_, value: string) => `id="${ids.get(value)}"`)
      .replace(/url\(#([^)]+)\)/g, (original, value: string) => ids.has(value) ? `url(#${ids.get(value)})` : original)
      .replace(/\bhref="#([^"]+)"/g, (original, value: string) => ids.has(value) ? `href="#${ids.get(value)}"` : original);
  }, [markup, id]);
  return <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flexShrink: 0, ...style }} dangerouslySetInnerHTML={{ __html: scoped }} />;
}
