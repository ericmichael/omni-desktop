import { memo, useId } from 'react';

/**
 * The Omni mark — a ring with a center dot, stroked azure→indigo. It's the
 * orb/aura visual language (VoiceGlow, ColumnAura) distilled into a static
 * glyph; replaces the ASCII block-art wordmark in app chrome (UI/UX gameplan
 * Phase 10 — the ASCII art lives on as a boot console easter egg).
 */
export const OmniMark = memo(({ size = 28, className }: { size?: number; className?: string }) => {
  const gradientId = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" role="img" aria-label="Omni" className={className}>
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#5ac8fa" />
          <stop offset="100%" stopColor="#5e5ce6" />
        </linearGradient>
      </defs>
      <circle cx="14" cy="14" r="10.5" fill="none" stroke={`url(#${gradientId})`} strokeWidth="2.5" />
      <circle cx="14" cy="14" r="3" fill={`url(#${gradientId})`} />
    </svg>
  );
});
OmniMark.displayName = 'OmniMark';
