import type { IconTheme } from '../store/app-state';

/** Shared Explorer/review file-type artwork, including the user's icon theme. */
export function getFileIconSrc(ext: string, theme: IconTheme): string {
  const icons: Record<string, string> = {
    rs: 'rs.svg', js: 'js.svg', jsx: 'jsx.svg', ts: 'ts.svg', tsx: 'tsx.svg',
    py: 'py.svg', go: 'go.svg', java: 'java.svg', c: 'c.svg', cpp: 'cpp.svg',
    h: 'cpp.svg', html: 'html.svg', css: 'css.svg', json: 'json.svg',
    md: 'md.svg', toml: 'toml.svg', sh: 'sh.svg', pyw: 'py.svg',
  };
  return `/icons/themes/${theme}/${icons[ext.toLowerCase()] || 'file.svg'}`;
}
