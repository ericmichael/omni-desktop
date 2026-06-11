import { memo, useId } from 'react';

/**
 * The Omni mark — a rendered ringed planet in the brand azure→indigo. It's
 * the orb/aura visual language (VoiceGlow, ColumnAura) distilled into a
 * static glyph; replaces the ASCII block-art wordmark in app chrome (UI/UX
 * gameplan Phase 10 — the ASCII art lives on as a boot console easter egg).
 *
 * Legibility comes from tone, not gaps: the front ring arc is brighter than
 * the sphere, the back arc darker, and the ring casts a soft shadow clipped
 * to the sphere — so the crossing stays readable at 28px on any background.
 * The same artwork is the source for the app icons (scripts/render-icons).
 */
const RING_TILT = 'rotate(-18 14 14)';
const RING_BACK = 'M 1.6 14 A 12.4 4.6 0 0 1 26.4 14';
const RING_FRONT = 'M 1.6 14 A 12.4 4.6 0 0 0 26.4 14';
const RING_SHADOW = 'M 1.6 14.6 A 12.4 4.6 0 0 0 26.4 14.6';

export const OmniMark = memo(({ size = 28, className }: { size?: number; className?: string }) => {
  const id = useId();
  const sphereId = `${id}-sphere`;
  const ringId = `${id}-ring`;
  const clipId = `${id}-sphere-clip`;
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" role="img" aria-label="Omni" className={className}>
      <defs>
        <radialGradient id={sphereId} cx="36%" cy="30%" r="85%">
          <stop offset="0%" stopColor="#a8e4ff" />
          <stop offset="38%" stopColor="#5ac8fa" />
          <stop offset="100%" stopColor="#4b48c8" />
        </radialGradient>
        <linearGradient id={ringId} x1="2" y1="20" x2="26" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#8fe0ff" />
          <stop offset="100%" stopColor="#6f6cf0" />
        </linearGradient>
        <clipPath id={clipId}>
          <circle cx="14" cy="14" r="7.2" />
        </clipPath>
      </defs>
      <path d={RING_BACK} transform={RING_TILT} fill="none" stroke="#3e3da8" strokeWidth="2.1" />
      <circle cx="14" cy="14" r="7.2" fill={`url(#${sphereId})`} />
      <g clipPath={`url(#${clipId})`}>
        <path
          d={RING_SHADOW}
          transform={RING_TILT}
          fill="none"
          stroke="#15143f"
          strokeWidth="4.4"
          opacity="0.5"
        />
      </g>
      <path
        d={RING_FRONT}
        transform={RING_TILT}
        fill="none"
        stroke={`url(#${ringId})`}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
});
OmniMark.displayName = 'OmniMark';
