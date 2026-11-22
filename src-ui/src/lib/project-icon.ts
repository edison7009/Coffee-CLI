// A project's own icon (its favicon or app icon), found the way most projects keep one, so a
// conversation can wear its project's face. Null when the project has none.
import { useEffect, useState } from 'react';
import { isTauri } from '../tauri';

/** Where projects usually keep their icon, most specific first (same order other desktop agents use). */
export const PROJECT_ICON_CANDIDATES = [
  'favicon.svg', 'favicon.ico', 'favicon.png',
  'public/favicon.svg', 'public/favicon.ico', 'public/favicon.png',
  'app/favicon.ico', 'app/favicon.png', 'app/icon.svg', 'app/icon.png',
  'src/favicon.ico', 'src/favicon.svg', 'src/app/favicon.ico', 'src/app/icon.svg', 'src/app/icon.png',
  'assets/icon.svg', 'assets/icon.png', 'assets/logo.svg', 'assets/logo.png',
  'src-ui/public/favicon.svg', '.idea/icon.svg',
] as const;

/** `folder` joined with a relative candidate, keeping the folder's own separator. */
export function projectIconPath(folder: string, candidate: string): string {
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${separator}${candidate.split('/').join(separator)}`;
}

const found = new Map<string, Promise<string | null>>();

function loads(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth > 0);
    image.onerror = () => resolve(false);
    image.src = url;
  });
}

/** The first candidate that loads as an image, once per folder for the whole run. */
export function findProjectIcon(folder: string): Promise<string | null> {
  let result = found.get(folder);
  if (!result) {
    result = (async () => {
      if (!isTauri) return null;
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      for (const candidate of PROJECT_ICON_CANDIDATES) {
        const url = convertFileSrc(projectIconPath(folder, candidate));
        if (await loads(url)) return url;
      }
      return null;
    })().catch(() => null);
    found.set(folder, result);
  }
  return result;
}

export function useProjectIcon(folder: string | null | undefined): string | null {
  const [icon, setIcon] = useState<{ folder: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!folder) return;
    let current = true;
    void findProjectIcon(folder).then(url => { if (current) setIcon({ folder, url }); });
    return () => { current = false; };
  }, [folder]);
  return folder && icon?.folder === folder ? icon.url : null;
}
