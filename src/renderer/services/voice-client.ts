/**
 * Renderer-side client for local voice (Option A). Talks to the main-process
 * VoiceService over IPC in Electron (streaming), or to the Node server over
 * HTTP in browser/server mode (non-streaming). Owns an AudioContext for TTS
 * playback so the `speak` client tool is a one-liner.
 *
 * STT/TTS run on the user's machine (Electron) or the self-hosted server host —
 * never in the agent runtime — so this works in every Electron mode and in
 * self-hosted browser/server. See isLocalVoiceCapable().
 */

import { IpcEmitter, IpcListener } from '@electron-toolkit/typed-ipc/renderer';

import type { IpcEvents, IpcRendererEvents, VoiceStatus } from '@/shared/types';

const isElectron = typeof window !== 'undefined' && !!(window as { electron?: unknown }).electron;

/** PCM16LE base64 → Float32 [-1,1]. */
function pcm16ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = (i16[i] ?? 0) / 32768;
  return out;
}

class VoiceClient {
  private emitter = isElectron ? new IpcEmitter<IpcEvents>() : null;
  private listener = isElectron ? new IpcListener<IpcRendererEvents>() : null;
  private audioCtx: AudioContext | null = null;
  private nextStartAt = 0;
  private seq = 0;

  /** Available only where the local sidecar can run on this host. */
  get supported(): boolean {
    return isElectron || !isVoiceCloudLinked();
  }

  private ctx(): AudioContext {
    if (!this.audioCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new Ctor();
    }
    return this.audioCtx;
  }

  async getStatus(): Promise<VoiceStatus> {
    if (this.emitter) return this.emitter.invoke('voice:get-status');
    return (await fetch('/api/voice/status').then((r) => r.json())) as VoiceStatus;
  }

  async start(): Promise<VoiceStatus> {
    if (this.emitter) return this.emitter.invoke('voice:start');
    return (await fetch('/api/voice/start', { method: 'POST' }).then((r) => r.json())) as VoiceStatus;
  }

  /** PCM16LE mono base64 at `sampleRate` → recognized text. */
  async transcribe(pcmBase64: string, sampleRate: number): Promise<string> {
    if (this.emitter) return this.emitter.invoke('voice:transcribe', pcmBase64, sampleRate);
    const res = await fetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pcm: pcmBase64, sampleRate }),
    }).then((r) => r.json());
    return (res as { text?: string }).text ?? '';
  }

  /** Synthesize and play `text`. Resolves when playback has been scheduled. */
  async speak(text: string, voice?: string): Promise<void> {
    const ctx = this.ctx();
    if (ctx.state === 'suspended') await ctx.resume();
    this.nextStartAt = Math.max(this.nextStartAt, ctx.currentTime);

    const play = (pcmBase64: string, sampleRate: number): void => {
      const f32 = pcm16ToFloat32(pcmBase64);
      if (!f32.length) return;
      const buf = ctx.createBuffer(1, f32.length, sampleRate);
      buf.getChannelData(0).set(f32);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const at = Math.max(this.nextStartAt, ctx.currentTime);
      src.start(at);
      this.nextStartAt = at + buf.duration;
    };

    if (this.emitter && this.listener) {
      const streamId = `s${++this.seq}`;
      await new Promise<void>((resolve, reject) => {
        const offAudio = this.listener!.on('voice:audio', (_e, p) => {
          if (p.streamId === streamId) play(p.pcm, p.sampleRate);
        });
        const offEnd = this.listener!.on('voice:audio-end', (_e, p) => {
          if (p.streamId !== streamId) return;
          offAudio();
          offEnd();
          resolve();
        });
        this.emitter!.invoke('voice:speak', streamId, text, voice).catch((e) => {
          offAudio();
          offEnd();
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      });
      return;
    }

    // Browser/server: one-shot synthesis, play the whole utterance.
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    }).then((r) => r.json());
    const { pcm, sampleRate } = res as { pcm: string; sampleRate: number };
    if (pcm) play(pcm, sampleRate);
  }
}

/**
 * Whether the agent compute is cloud-linked. Voice still runs locally, so this
 * only matters for browser/server: a managed/Azure server host must NOT run
 * per-user local inference. In Electron the sidecar is always local → allowed.
 * Detected from the boot bootstrap (set by the preload / server template).
 */
function isVoiceCloudLinked(): boolean {
  const b = (window as unknown as { __omniBootstrap?: { cloudMode?: unknown } }).__omniBootstrap;
  return Boolean(b?.cloudMode);
}

let _client: VoiceClient | null = null;
export const getVoiceClient = (): VoiceClient => {
  if (!_client) _client = new VoiceClient();
  return _client;
};

/**
 * True when local voice *can* run in the current deployment (Electron any mode,
 * or self-hosted browser/server). Whether it's actually used is a separate
 * user choice — the `localVoiceEnabled` setting (Settings → Models → Voice).
 */
export const isLocalVoiceCapable = (): boolean => getVoiceClient().supported;
