/**
 * Apple-Intelligence-style interior voice glow for the deck column being
 * recorded into. A fixed-spectrum conic gradient is masked to a ring at the
 * rounded edge and slowly rotated, then a PARENT blurs it into a soft bloom
 * (blur must come after the mask, or the mask re-sharpens the ring's edges).
 * A soft inner bloom bleeds light inward. Everything rides the live mic level
 * (`--voice-level`), bound via requestAnimationFrame off the React render path.
 */
import { makeStyles, shorthands } from '@fluentui/react-components';
import { useEffect, useRef } from 'react';

import { voiceLevel } from '@/renderer/services/voice-recording';

// Fixed Apple-ish spectrum (loops seamlessly so the rotation has no seam).
const SPECTRUM = '#0a84ff, #32ade6, #5e5ce6, #bf5af2, #ff375f, #ff9f0a, #0a84ff';

// Registering the angle as <angle> lets the conic gradient rotate smoothly —
// custom properties don't interpolate in animations without @property.
let angleRegistered = false;
function ensureAngleProperty(): void {
  if (angleRegistered) return;
  angleRegistered = true;
  try {
    (CSS as unknown as { registerProperty?: (d: object) => void }).registerProperty?.({
      name: '--voice-angle',
      syntax: '<angle>',
      inherits: false,
      initialValue: '0deg',
    });
  } catch {
    /* already registered */
  }
}

const fill = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 'inherit' } as const;

const useStyles = makeStyles({
  root: {
    ...fill,
    pointerEvents: 'none',
    zIndex: 5,
  },
  // Soft luminous light bleeding inward (naturally feathered; renders behind).
  bloom: {
    ...fill,
    opacity: 'calc(0.32 + var(--voice-level, 0) * 0.4)',
    // Bigger spread (held band) + tighter blur so it holds near the edge before
    // feathering, instead of fading the instant it leaves the edge.
    boxShadow: `inset 0 0 calc(7px + var(--voice-level, 0) * 15px) calc(2px + var(--voice-level, 0) * 5px) color-mix(in srgb, #5ac8fa 55%, transparent)`,
  },
  // Parent: blurs the (crisp) masked ring into a soft bloom. Blur lives HERE,
  // not on the ring, so it is applied after the mask. A tight blur keeps the
  // band thin and the hues saturated rather than washed-out.
  ringBlur: {
    ...fill,
    // saturate()/brightness() keep the spectrum vivid — blurring + the soft
    // bloom behind otherwise mute it toward pastel.
    filter: 'blur(calc(1.5px + var(--voice-level, 0) * 5px)) saturate(2.6) brightness(1.1)',
    opacity: 'calc(0.98 + var(--voice-level, 0) * 0.02)',
  },
  // Child: the rotating spectrum, masked to a ring at the edge (crisp here —
  // the parent's blur softens it).
  ring: {
    ...fill,
    ...shorthands.padding('3px'), // ring thickness (pre-blur) — a held colour band
    backgroundImage: `conic-gradient(from var(--voice-angle), ${SPECTRUM})`,
    WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
    WebkitMaskComposite: 'xor',
    mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
    maskComposite: 'exclude',
    animationName: {
      '0%': { '--voice-angle': '0deg' },
      '100%': { '--voice-angle': '360deg' },
    },
    animationDuration: '6s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
});

export function VoiceGlow() {
  const styles = useStyles();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureAngleProperty();
    let shown = 0.4;
    let raf = 0;
    const tick = () => {
      // Substantial floor + fast attack / slow release so it stays alive
      // through the gaps between words.
      const target = 0.4 + voiceLevel.current * 0.6;
      const k = target > shown ? 0.35 : 0.05;
      shown += (target - shown) * k;
      ref.current?.style.setProperty('--voice-level', shown.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={ref} className={styles.root} aria-hidden="true">
      <div className={styles.bloom} />
      <div className={styles.ringBlur}>
        <div className={styles.ring} />
      </div>
    </div>
  );
}
