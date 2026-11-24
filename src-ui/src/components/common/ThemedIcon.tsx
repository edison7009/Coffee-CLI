import { useAppState } from '../../store/app-state';
import { isMaskTintTheme } from '../../lib/personalization';

/** Renders a theme icon. For mask-tint themes, uses a <span> with mask-image
 *  so `background-color: var(--accent)` paints the silhouette. For color
 *  themes, falls back to a plain <img>. */
export function ThemedIcon({ src, alt, onFallback }: {
  src: string;
  alt: string;
  onFallback?: string;
}) {
  const { state: { iconTheme } } = useAppState();
  if (isMaskTintTheme(iconTheme)) {
    return (
      <span
        className="icon-svg icon-svg-mask"
        role="img"
        aria-label={alt}
        style={{ WebkitMaskImage: `url("${src}")`, maskImage: `url("${src}")` }}
      />
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="icon-svg"
      onError={onFallback ? (e) => (e.currentTarget.src = onFallback) : undefined}
    />
  );
}
