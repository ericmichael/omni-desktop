import { describe, expect, it } from 'vitest';

import {
  createSampleChunker,
  floatToPcm16,
  pcm16ToFloat,
  resampleTo24k,
  shapeAudioLevel,
  weightedAudioLevel,
} from './realtime-voice';

describe('realtime-voice audio helpers', () => {
  it('float↔pcm16 round-trips within quantization error', () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const bytes = floatToPcm16(input);
    expect(bytes.length).toBe(input.length * 2);
    const back = pcm16ToFloat(bytes);
    for (let i = 0; i < input.length; i++) {
      expect(Math.abs((back[i] ?? 0) - (input[i] ?? 0))).toBeLessThan(1 / 32000);
    }
  });

  it('floatToPcm16 clamps out-of-range samples', () => {
    const bytes = floatToPcm16(new Float32Array([2, -2]));
    const back = pcm16ToFloat(bytes);
    expect(back[0]).toBeCloseTo(1, 3);
    expect(back[1]).toBeCloseTo(-1, 3);
  });

  it('resampleTo24k halves a 48k buffer and passes 24k through', () => {
    const input = new Float32Array(480).fill(0.5);
    expect(resampleTo24k(input, 48000).length).toBe(240);
    expect(resampleTo24k(input, 24000)).toBe(input);
  });

  it('chunker emits fixed-size chunks across uneven pushes', () => {
    const emitted: Float32Array[] = [];
    const push = createSampleChunker(4, (c) => emitted.push(c.slice()));
    push(new Float32Array([1, 2, 3]));
    expect(emitted).toHaveLength(0);
    push(new Float32Array([4, 5]));
    expect(emitted).toHaveLength(1);
    expect(Array.from(emitted[0]!)).toEqual([1, 2, 3, 4]);
    push(new Float32Array([6, 7, 8, 9, 10]));
    expect(emitted).toHaveLength(2);
    expect(Array.from(emitted[1]!)).toEqual([5, 6, 7, 8]);
    // Remainder [9, 10] stays buffered until a later push completes a chunk.
    push(new Float32Array([11, 12]));
    expect(emitted).toHaveLength(3);
    expect(Array.from(emitted[2]!)).toEqual([9, 10, 11, 12]);
  });

  it('weightedAudioLevel is 0 for silence and bounded by 1', () => {
    expect(weightedAudioLevel(new Uint8Array(0))).toBe(0);
    expect(weightedAudioLevel(new Uint8Array(128).fill(0))).toBe(0);
    expect(weightedAudioLevel(new Uint8Array(128).fill(255))).toBeLessThanOrEqual(1);
    expect(weightedAudioLevel(new Uint8Array(128).fill(255))).toBeGreaterThan(0.9);
  });
});

describe('shapeAudioLevel', () => {
  it('gates room tone to silence so nothing moves on an empty room', () => {
    expect(shapeAudioLevel(0)).toBe(0);
    expect(shapeAudioLevel(0.02)).toBe(0);
    expect(shapeAudioLevel(Number.NaN)).toBe(0);
  });

  it('lifts quiet speech instead of leaving it near the floor', () => {
    // A sub-1 exponent means the shaped value outruns the linear one.
    const raw = 0.2;
    const linear = (raw - 0.03) * 1.8;
    expect(shapeAudioLevel(raw)).toBeGreaterThan(linear);
  });

  it('compresses the top into the range rather than overshooting it', () => {
    expect(shapeAudioLevel(1)).toBe(1);
    expect(shapeAudioLevel(5)).toBe(1);
  });

  it('stays monotonic across the range', () => {
    let previous = -1;
    for (let raw = 0; raw <= 1; raw += 0.05) {
      const shaped = shapeAudioLevel(raw);
      expect(shaped).toBeGreaterThanOrEqual(previous);
      previous = shaped;
    }
  });
});
