/**
 * Push-to-talk mic capture for local voice (Option A). Toggle on to record;
 * toggle off to transcribe via VoiceClient and receive the text. Captures mono,
 * resamples to 24 kHz PCM16 (the rate the sidecar/launcher pipeline uses).
 *
 * Audio path mirrors VoiceModal's capture (AudioWorklet → 24 kHz → Int16) but
 * is self-contained and routes to the local sidecar instead of the realtime WS.
 */
import { useCallback, useRef, useState } from 'react';

import { persistedStoreApi } from '@/renderer/services/store';
import { getVoiceClient } from '@/renderer/services/voice-client';
import { voiceLevel } from '@/renderer/services/voice-recording';

const TARGET_RATE = 24000;

function floatTo16LE(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

function resampleTo24k(input: Float32Array, inRate: number): Float32Array {
  if (inRate === TARGET_RATE || input.length === 0) {
    return input;
  }
  const ratio = TARGET_RATE / inRate;
  const outLen = Math.round(input.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(bin);
}

export interface VoiceCapture {
  recording: boolean;
  busy: boolean;
  /** Start mic capture. */
  start: () => Promise<void>;
  /** Stop capture, transcribe, and resolve with the recognized text. */
  stop: () => Promise<string>;
  /** Abort capture, discarding the audio — no transcription, nothing sent. */
  cancel: () => void;
}

export function useVoiceCapture(): VoiceCapture {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelRafRef = useRef<number>(0);

  const cleanup = useCallback(() => {
    cancelAnimationFrame(levelRafRef.current);
    voiceLevel.current = 0;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    chunksRef.current = [];
    const audioPrefs = persistedStoreApi.$atom.get().audioSettings;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: audioPrefs.inputDeviceId ? { exact: audioPrefs.inputDeviceId } : undefined,
        channelCount: 1,
        echoCancellation: audioPrefs.echoCancellation,
        noiseSuppression: audioPrefs.noiseSuppression,
        autoGainControl: audioPrefs.autoGainControl,
      },
    });
    streamRef.current = stream;
    const ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    ctxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);

    // ScriptProcessor is deprecated but universally available and adequate for
    // push-to-talk capture (no realtime constraint). Keeps this dependency-free.
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(node);
    node.connect(ctx.destination);
    nodeRef.current = node;

    // Live level metering for the reactive glow (separate from capture).
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    analyserRef.current = analyser;
    const data = new Uint8Array(analyser.fftSize);
    const measure = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = ((data[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      // Gain + soft clamp so normal speech swings across most of 0..1.
      voiceLevel.current = Math.min(1, rms * 3.5);
      levelRafRef.current = requestAnimationFrame(measure);
    };
    levelRafRef.current = requestAnimationFrame(measure);

    setRecording(true);
  }, []);

  const stop = useCallback(async (): Promise<string> => {
    setRecording(false);
    const inRate = ctxRef.current?.sampleRate ?? 48000;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    cleanup();

    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (!total) {
      return '';
    }
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    const pcm = toBase64(floatTo16LE(resampleTo24k(merged, inRate)));
    setBusy(true);
    try {
      return await getVoiceClient().transcribe(pcm, TARGET_RATE);
    } finally {
      setBusy(false);
    }
  }, [cleanup]);

  const cancel = useCallback(() => {
    setRecording(false);
    chunksRef.current = [];
    cleanup(); // stops stream + analyser + meter loop and resets the level
  }, [cleanup]);

  return { recording, busy, start, stop, cancel };
}
