import { describe, expect, it } from 'vitest';

import { MAX_ORB_SCALE, NEUTRAL_ORB_SCALE, orbHueFor, orbParamsFor } from './Orb';

const STATES = ['idle', 'listening', 'thinking', 'speaking'] as const;

describe('orbParamsFor', () => {
  describe('listening', () => {
    // The mic level moves every frame. Anything it drives that feeds the
    // animation phase reads as jitter — and, before the phase was
    // integrated, teleported the noise field outright.
    it('draws IN as the level rises — the orb leaning in to hear', () => {
      const quiet = orbParamsFor('listening', false, 1000, 0).scale;
      const loud = orbParamsFor('listening', false, 1000, 1).scale;
      expect(quiet).toBe(NEUTRAL_ORB_SCALE);
      expect(loud).toBeLessThan(quiet);
    });

    it('holds tempo and turbulence steady across the whole level range', () => {
      const quiet = orbParamsFor('listening', false, 1000, 0);
      const loud = orbParamsFor('listening', false, 1000, 1);
      expect(loud.animationSpeed).toBe(quiet.animationSpeed);
      expect(loud.noiseAmplitude).toBe(quiet.noiseAmplitude);
      expect(loud.hoverIntensity).toBe(quiet.hoverIntensity);
    });

    it('bottoms out rather than inverting on an over-range level', () => {
      expect(orbParamsFor('listening', false, 1000, 5).scale).toBe(orbParamsFor('listening', false, 1000, 1).scale);
    });

    it('is time-invariant — every animated term lives in the phase, not here', () => {
      expect(orbParamsFor('listening', false, 0, 0.4)).toEqual(orbParamsFor('listening', false, 900_000, 0.4));
    });
  });

  // Scale 1.0 is exactly inscribed in the canvas (see MAX_ORB_SCALE): the
  // shader draws the blob out to uv radius 1 and the canvas edge sits at
  // 1/scale, so anything above 1 is cut off flat at the edge midpoints.
  describe('never exceeds the inscribed radius', () => {
    it('holds across every state, level and pulse phase', () => {
      for (const state of STATES) {
        for (const toolActive of [false, true]) {
          for (let t = 0; t < 3000; t += 25) {
            for (const level of [0, 0.25, 0.5, 0.75, 1, 2]) {
              const { scale } = orbParamsFor(state, toolActive, t, level);
              expect(scale).toBeLessThanOrEqual(MAX_ORB_SCALE);
              expect(scale).toBeGreaterThan(0);
            }
          }
        }
      }
    });

    it('still reaches the edge when the agent is at full voice', () => {
      expect(orbParamsFor('speaking', false, 1000, 1).scale).toBe(MAX_ORB_SCALE);
    });

    it('leaves the tool pulse room to swing instead of saturating', () => {
      const peaks = new Set<number>();
      for (let t = 0; t < 900; t += 10) {
        peaks.add(orbParamsFor('speaking', true, t, 1).scale);
      }
      // A saturated pulse would collapse to a single value at the ceiling.
      expect(peaks.size).toBeGreaterThan(10);
      expect(Math.max(...peaks)).toBeLessThanOrEqual(MAX_ORB_SCALE);
    });
  });

  it('keeps every size change gentle at this canvas', () => {
    // A scale step is ~256px of diameter at full canvas, so the spread
    // between any two states — and the travel the level can drive inside
    // one — has to stay small or the orb pops.
    const span = (state: (typeof STATES)[number]) => {
      const quiet = orbParamsFor(state, false, 1000, 0).scale;
      const loud = orbParamsFor(state, false, 1000, 1).scale;
      return loud - quiet;
    };
    expect(span('listening')).toBeLessThanOrEqual(0.2);
    expect(span('speaking')).toBeLessThanOrEqual(0.2);

    const sizes = STATES.map((state) => orbParamsFor(state, false, 1000, 0.5).scale);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(0.28);
  });

  // Size says who holds the turn, and nothing else. Everything that used to
  // be encoded in it — which state we're in, how hard the model is working —
  // now lives in tempo and turbulence.
  describe('size is turn ownership, not state', () => {
    it('renders every attending state at one neutral size when silent', () => {
      for (const state of ['listening', 'thinking', 'speaking'] as const) {
        expect(orbParamsFor(state, false, 1000, 0).scale).toBe(NEUTRAL_ORB_SCALE);
      }
    });

    it('opposes the two turns around that neutral', () => {
      expect(orbParamsFor('listening', false, 1000, 1).scale).toBeLessThan(NEUTRAL_ORB_SCALE);
      expect(orbParamsFor('speaking', false, 1000, 1).scale).toBeGreaterThan(NEUTRAL_ORB_SCALE);
    });

    it('gives thinking no size treatment of its own', () => {
      const at = (t: number) => orbParamsFor('thinking', false, t, 0.5).scale;
      expect(at(0)).toBe(at(1234));
      expect(at(0)).toBe(NEUTRAL_ORB_SCALE);
    });

    it('keeps idle the smallest thing on screen, even mid-shout', () => {
      const idle = orbParamsFor('idle', false, 0, 0).scale;
      expect(idle).toBeLessThan(orbParamsFor('listening', false, 1000, 1).scale);
    });
  });

  it('keeps speaking the largest state at full level', () => {
    const at = (state: (typeof STATES)[number]) => orbParamsFor(state, false, 1000, 1).scale;
    expect(at('speaking')).toBeGreaterThan(at('listening'));
    expect(at('listening')).toBeGreaterThan(at('idle'));
  });

  it('gives each state its own tempo', () => {
    const speed = (s: Parameters<typeof orbParamsFor>[0]) => orbParamsFor(s, false, 1000, 0).animationSpeed;
    expect(speed('idle')).toBeLessThan(speed('listening'));
    expect(speed('listening')).toBeLessThan(speed('speaking'));
    expect(speed('speaking')).toBeLessThan(speed('thinking'));
  });

  it('layers the tool overlay on top of the state it interrupts', () => {
    const plain = orbParamsFor('listening', false, 1000, 0);
    const withTool = orbParamsFor('listening', true, 1000, 0);
    expect(withTool.animationSpeed).toBeGreaterThan(plain.animationSpeed);
    expect(withTool.noiseAmplitude).toBeGreaterThan(plain.noiseAmplitude);
  });

  it('idle breathes rather than sitting still', () => {
    const a = orbParamsFor('idle', false, 0, 0).scale;
    const b = orbParamsFor('idle', false, 1500 * Math.PI * 0.5, 0).scale;
    expect(a).not.toBe(b);
  });
});

describe('orbHueFor', () => {
  it('cycles only while a tool runs', () => {
    expect(orbHueFor(false, 12_345)).toBe(0);
    expect(orbHueFor(true, 0)).toBe(0);
    expect(orbHueFor(true, 1440)).toBeGreaterThan(0);
    expect(orbHueFor(true, 999_999)).toBeLessThan(360);
  });
});
