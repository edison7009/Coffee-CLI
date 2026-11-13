// The desktop's wallpaper, fetched in pieces over the encrypted connection (the browser cannot
// read the desktop's disk). One file at a time; a newer wallpaper replaces an older download.
import { remoteRequest } from './bridge';

let current: { path: string; url: Promise<string> } | null = null;

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64), bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** A URL for the desktop wallpaper at `path`; rejects when it is too large or unreadable. */
export function remoteWallpaperUrl(path: string): Promise<string> {
  if (current?.path === path) return current.url;
  const previous = current;
  const url = (async () => {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0, size = 0, mime = '';
    do {
      const chunk = await remoteRequest<{ size: number; mime: string; data: string; path: string }>('ui.wallpaper', { offset });
      // The desktop switched wallpapers meanwhile; the caller asks again with the new path.
      if (chunk.path !== path) throw new Error('wallpaper changed');
      const bytes = decode(chunk.data);
      if (!bytes.length) break;
      parts.push(bytes); offset += bytes.length; size = chunk.size; mime = chunk.mime;
    } while (offset < size);
    return URL.createObjectURL(new Blob(parts, { type: mime }));
  })();
  current = { path, url };
  void previous?.url.then(old => URL.revokeObjectURL(old), () => {});
  url.catch(() => { if (current?.url === url) current = null; });
  return url;
}
