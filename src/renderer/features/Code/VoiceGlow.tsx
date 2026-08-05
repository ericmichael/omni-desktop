/**
 * Apple-Intelligence-style interior voice glow for the deck column being
 * recorded into. A fixed-spectrum conic gradient is masked to a ring at the
 * rounded edge and slowly rotated, then a PARENT blurs it into a soft bloom
 * (blur must come after the mask, or the mask re-sharpens the ring's edges).
 * A soft inner bloom bleeds light inward. Everything rides the live mic level
 * (`--voice-level`), bound via requestAnimationFrame off the React render path.
 */
import './CodeVisualEffects.css';

import { useEffect, useRef } from 'react';

import { voiceLevel } from '@/renderer/services/voice-recording';

// Registering the angle as <angle> lets the conic gradient rotate smoothly —
// custom properties don't interpolate in animations without @property.
let angleRegistered = false;
function ensureAngleProperty(): void {
  if (angleRegistered) {
    return;
  }
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

export function VoiceGlow() {
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
    <div ref={ref} className="omni-voice-glow-layer omni-voice-glow-root" aria-hidden="true">
      <div className="omni-voice-glow-bloom omni-voice-glow-layer" />
      <div className="omni-voice-glow-layer omni-voice-glow-ring-blur">
        <div className="omni-voice-glow-layer omni-voice-glow-ring" />
      </div>
    </div>
  );
}
