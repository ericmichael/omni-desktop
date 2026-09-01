/**
 * Renderer controller for hosted realtime voice sessions.
 *
 * Owns the side-effect half of the voice-session machine
 * (`@/shared/machines/voice-session.machine`): the RealtimeRPCClient on
 * /ws/realtime, continuous mic capture (AudioWorklet → 24 kHz PCM16 →
 * base64 chunks), scheduled playback through a device-selectable sink, the
 * half-duplex hold, and the audio-level meter. UI intents come in as
 * method calls; everything that happened goes to the machine as events.
 *
 * The level meter writes to a mutable holder (`realtimeVoiceLevel`) read
 * by the orb's RAF loop — 60fps updates never touch React state (same
 * pattern as `voice-recording.ts`'s `voiceLevel`).
 */
import { type Actor, createActor } from 'xstate';

import { RealtimeRPCClient } from '@/renderer/omniagents-ui/rpc/realtime';
import { voiceSessionMachine } from '@/shared/machines/voice-session.machine';
import type { AudioSettings } from '@/shared/types';

/** Live mic/output level (0..1) for the orb; a plain holder, not a store. */
export const realtimeVoiceLevel = { current: 0 };

const CAPTURE_SAMPLE_RATE = 24000;
const CAPTURE_CHUNK_SAMPLES = 2400;
/** Delay before re-opening the mic after playback drains (echo tail). */
const DUPLEX_RELEASE_MS = 150;
/**
 * Meter ballistics, per 60Hz frame. Speech is peaky at syllable rate, so a
 * symmetric filter makes anything driven by the level pump in and out
 * several times a word. Rise fast enough that an onset registers, fall
 * slowly so the gaps between syllables don't collapse it — the same
 * asymmetry a VU meter uses.
 */
const LEVEL_ATTACK = 0.35;
const LEVEL_RELEASE = 0.06;
/**
 * Level shaping, applied before the ballistics. Calibration knobs, in order:
 * a floor so room tone and fan noise never move anything, a gain so normal
 * speech uses the range rather than the bottom of it, and a sub-1 power
 * curve that lifts quiet speech while compressing shouts — without it the
 * meter spends its life near zero and then slams to the top.
 */
const LEVEL_NOISE_FLOOR = 0.03;
const LEVEL_GAIN = 1.8;
const LEVEL_EXPONENT = 0.8;

/** Raw 0..1 measure → shaped 0..1. Pure; unit-tested. */
export function shapeAudioLevel(raw: number): number {
  if (!Number.isFinite(raw) || raw <= LEVEL_NOISE_FLOOR) {
    return 0;
  }
  const gated = Math.min((raw - LEVEL_NOISE_FLOOR) * LEVEL_GAIN, 1);
  return Math.pow(gated, LEVEL_EXPONENT);
}
/**
 * Scheduling cushion ahead of `currentTime`. Streaming steadily, the next
 * chunk's slot is already past this and the lead costs nothing; after an
 * underrun it re-establishes the buffer instead of butt-joining a late chunk
 * and immediately starving again.
 */
const PLAYBACK_LEAD_S = 0.1;

export type RealtimeVoiceConfig = {
  url: string;
  token?: string;
  debug?: boolean;
  audioSettings: AudioSettings;
};

// ---------------------------------------------------------------------------
// Pure audio helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Linear-interpolation resample to 24 kHz. */
export function resampleTo24k(input: Float32Array, inRate: number): Float32Array {
  if (inRate === CAPTURE_SAMPLE_RATE) {
    return input;
  }
  const ratio = CAPTURE_SAMPLE_RATE / inRate;
  const outLen = Math.floor(input.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] || 0;
    const s1 = input[idx + 1] || 0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

/** Float32 [-1,1] → PCM16LE bytes. */
export function floatToPcm16(input: Float32Array): Uint8Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = input[i] ?? 0;
    if (s < -1) {
      s = -1;
    }
    if (s > 1) {
      s = 1;
    }
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

/** PCM16LE bytes → Float32 [-1,1]. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return samples;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/**
 * Fixed-size chunker: buffers pushed samples and emits exactly
 * `chunkSamples`-sized Float32Arrays.
 */
export function createSampleChunker(
  chunkSamples: number,
  emit: (chunk: Float32Array) => void
): (samples: Float32Array) => void {
  const queue: { chunks: Float32Array[]; length: number } = { chunks: [], length: 0 };
  return (samples: Float32Array) => {
    queue.chunks.push(samples);
    queue.length += samples.length;
    while (queue.length >= chunkSamples) {
      const out = new Float32Array(chunkSamples);
      let offset = 0;
      while (offset < chunkSamples && queue.chunks.length) {
        const head = queue.chunks[0]!;
        const take = Math.min(head.length, chunkSamples - offset);
        out.set(head.subarray(0, take), offset);
        offset += take;
        if (take === head.length) {
          queue.chunks.shift();
        } else {
          queue.chunks[0] = head.subarray(take);
        }
      }
      queue.length -= chunkSamples;
      emit(out);
    }
  };
}

/** Voice-frequency-weighted level from analyser byte data (0..1). */
export function weightedAudioLevel(data: Uint8Array): number {
  const len = data.length;
  if (!len) {
    return 0;
  }
  const bassThird = Math.floor(len / 3);
  const midThird = Math.floor((len * 2) / 3);
  let bassSum = 0;
  let midSum = 0;
  let highSum = 0;
  for (let i = 0; i < bassThird; i++) {
    bassSum += (data[i] ?? 0) * 2.0;
  }
  for (let i = bassThird; i < midThird; i++) {
    midSum += (data[i] ?? 0) * 1.5;
  }
  for (let i = midThird; i < len; i++) {
    highSum += (data[i] ?? 0) * 0.8;
  }
  const weighted = (bassSum + midSum + highSum) / (len * 1.5);
  return Math.min(weighted / 128, 1);
}

const WORKLET_CODE = `
class OmniVoiceCapture extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;
    this.port.postMessage(channel);
    if (outputs && outputs.length && outputs[0] && outputs[0][0]) {
      outputs[0][0].set(channel);
    }
    return true;
  }
}
registerProcessor('omni-voice-capture', OmniVoiceCapture);
`;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class RealtimeVoiceController {
  readonly actor: Actor<typeof voiceSessionMachine>;

  private client: RealtimeRPCClient | null = null;
  private offEvent: (() => void) | null = null;
  private generation = 0;

  // Capture
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private workletUrl: string | null = null;
  private analyser: AnalyserNode | null = null;
  private meterRaf: number | null = null;
  private smoothedLevel = 0;

  // Playback
  /** Every scheduled source lands here; the bus is what reaches the sink. */
  private playbackBus: GainNode | null = null;
  private playbackAnalyser: AnalyserNode | null = null;
  /** Legacy sink (see setupAudio): only when AudioContext.setSinkId is missing. */
  private playbackDest: MediaStreamAudioDestinationNode | null = null;
  private audioOutEl: HTMLAudioElement | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private scheduledEnd = 0;
  private playbackActive = false;

  // Half-duplex hold: mic gated off while the agent is producing/playing.
  private duplexHold = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.actor = createActor(voiceSessionMachine);
    this.actor.start();
  }

  private get snapshot() {
    return this.actor.getSnapshot();
  }

  private get sessionId(): string | undefined {
    return this.snapshot.context.sessionId;
  }

  // -- Public intents --------------------------------------------------

  /** Open a voice session. `sessionId` pairs it with the GUI session. */
  open(config: RealtimeVoiceConfig, sessionId?: string): void {
    if (!this.snapshot.matches('closed') && !this.snapshot.matches('error')) {
      return;
    }
    const generation = ++this.generation;
    this.actor.send({ type: 'OPEN', sessionId });

    const client = new RealtimeRPCClient(config.url, config.token, Boolean(config.debug));
    this.client = client;
    this.offEvent = client.on('realtime_event', (payload) => {
      if (generation === this.generation) {
        this.onServerEvent(payload ?? {});
      }
    });

    void client
      .connect()
      .then(async () => {
        if (generation !== this.generation) {
          return;
        }
        this.actor.send({ type: 'CONNECTED' });
        let res: Awaited<ReturnType<typeof client.startSession>>;
        try {
          res = await client.startSession(sessionId);
        } catch (e) {
          // A crashed/abandoned client can leave the session registered
          // server-side. Reclaim it: stop the stale registration and retry
          // once, instead of stranding this chat's voice until a server
          // restart.
          if (sessionId && e instanceof Error && /already exists/i.test(e.message)) {
            await client.stopSession(sessionId).catch(() => {});
            res = await client.startSession(sessionId);
          } else {
            throw e;
          }
        }
        if (generation !== this.generation) {
          return;
        }
        this.actor.send({
          type: 'SESSION_STARTED',
          sessionId: String(res.session_id),
          runId: String(res.run_id),
          at: Date.now(),
        });
        await this.startCapture(config);
      })
      .catch((e: unknown) => {
        if (generation !== this.generation) {
          return;
        }
        const message = e instanceof Error ? e.message : String(e ?? 'Voice connection failed');
        this.actor.send({ type: 'CONNECT_ERROR', message });
        this.teardownTransport();
      });
  }

  /** End the session: stop audio, stop the server session, drop the socket. */
  close(): void {
    if (this.snapshot.matches('closed')) {
      return;
    }
    const generation = ++this.generation;
    this.actor.send({ type: 'CLOSE' });
    this.stopCapture();
    this.stopPlayback();

    const client = this.client;
    const sid = this.sessionId;
    this.client = null;
    this.offEvent?.();
    this.offEvent = null;
    if (client) {
      // Let the stop RPC reach the server before dropping the socket — a
      // fire-and-forget stop that races disconnect leaves the session
      // registered server-side ("Session ... already exists" on reopen).
      const stop = sid ? client.stopSession(sid).catch(() => {}) : Promise.resolve();
      void stop.finally(() => {
        client.disconnect();
        if (generation === this.generation) {
          this.actor.send({ type: 'STOPPED' });
        }
      });
    } else {
      this.actor.send({ type: 'STOPPED' });
    }
  }

  toggleMute(): void {
    this.actor.send({ type: 'TOGGLE_MUTE' });
    this.applyTrackState();
    if (!this.snapshot.context.muted) {
      void this.audioCtx?.resume().catch(() => {});
    }
  }

  /** Barge-in: kill playback locally and tell the server to interrupt. */
  interrupt(): void {
    const sid = this.sessionId;
    this.stopPlayback();
    this.releaseDuplexHold(0);
    this.actor.send({ type: 'INTERRUPT' });
    if (this.client && sid) {
      void this.client.interrupt(sid).catch(() => {});
    }
  }

  /** Send a typed message into the live voice session. */
  sendText(text: string): boolean {
    const sid = this.sessionId;
    const trimmed = text.trim();
    if (!this.client || !sid || !trimmed) {
      return false;
    }
    this.actor.send({ type: 'SEND_TEXT', text: trimmed });
    void this.client.sendText(sid, trimmed).catch(() => {});
    return true;
  }

  /**
   * Release everything the session holds (mic, playback, socket, server
   * registration). Deliberately does NOT stop the actor: React StrictMode
   * runs the owning hook's effect cleanup between its double mount while
   * keeping the same controller instance, and a stopped XState actor is
   * permanently dead — every later OPEN would be silently dropped (the
   * "mic button does nothing" failure). The actor is just heap state; it
   * is garbage-collected with the controller.
   */
  dispose(): void {
    this.close();
  }

  // -- Server events ----------------------------------------------------

  private onServerEvent(p: Record<string, unknown>): void {
    const t = String(p.type || '');
    switch (t) {
      case 'realtime_turn_started':
        this.actor.send({ type: 'TURN_STARTED' });
        return;
      case 'realtime_response_start':
        this.holdDuplex();
        this.actor.send({ type: 'RESPONSE_START' });
        return;
      case 'realtime_turn_ended':
        this.actor.send({ type: 'TURN_ENDED' });
        // A no-audio turn never reaches PLAYBACK_IDLE — release the hold
        // here when nothing is playing.
        if (this.activeSources.size === 0) {
          this.releaseDuplexHold(DUPLEX_RELEASE_MS);
        }
        return;
      case 'realtime_history_updated': {
        // The model's own item order. It arrives when an existing item is
        // revised — notably when the user's async transcription completes,
        // which is precisely when arrival order has gone wrong.
        const raw = Array.isArray(p.history_items) ? p.history_items : [];
        const itemIds = raw
          .map((it) => (it && typeof it === 'object' ? String((it as { item_id?: unknown }).item_id ?? '') : ''))
          .filter(Boolean);
        if (itemIds.length) {
          this.actor.send({ type: 'HISTORY_ORDER', itemIds });
        }
        return;
      }
      case 'realtime_transcript_delta':
        this.actor.send({
          type: 'TRANSCRIPT_DELTA',
          itemId: String(p.item_id || ''),
          delta: String(p.delta || ''),
        });
        return;
      case 'realtime_transcript':
        this.actor.send({
          type: 'TRANSCRIPT_FINAL',
          itemId: String(p.item_id || ''),
          role: p.role === 'user' ? 'user' : 'assistant',
          text: String(p.transcript || ''),
        });
        return;
      case 'realtime_tool_start':
        this.actor.send({
          type: 'TOOL_START',
          callId: String(p.tool_call_id || ''),
          tool: String(p.tool_name || 'tool'),
          input: typeof p.arguments === 'string' ? p.arguments : undefined,
        });
        return;
      case 'realtime_tool_end':
        this.actor.send({
          type: 'TOOL_END',
          callId: String(p.tool_call_id || ''),
          tool: String(p.tool_name || 'tool'),
          output: typeof p.output === 'string' ? p.output : undefined,
        });
        return;
      case 'realtime_audio':
        this.holdDuplex();
        this.playChunk(String(p.audio_base64 || ''));
        return;
      case 'realtime_audio_end':
        // Generation finished; playback may still be draining. The hold
        // releases on PLAYBACK_IDLE (or turn end when nothing played).
        return;
      case 'realtime_audio_interrupted':
        this.stopPlayback();
        this.releaseDuplexHold(0);
        this.actor.send({ type: 'AUDIO_INTERRUPTED' });
        return;
      case 'realtime_error':
        this.actor.send({
          type: 'SERVER_ERROR',
          message: String(p.error_message || p.error || 'Voice mode error'),
        });
        return;
      case 'agent_event': {
        // Pipeline-backend bridge events: keep tool activity visible.
        const eventType = String(p.event_type || '');
        const data = (p.data ?? {}) as Record<string, unknown>;
        if (eventType === 'tool_called') {
          this.actor.send({
            type: 'TOOL_START',
            callId: String(data.call_id || ''),
            tool: String(data.tool || 'tool'),
            input: typeof data.input === 'string' ? data.input : JSON.stringify(data.input ?? ''),
          });
        } else if (eventType === 'tool_result') {
          this.actor.send({
            type: 'TOOL_END',
            callId: String(data.call_id || ''),
            tool: String(data.tool || 'tool'),
            output: typeof data.output === 'string' ? data.output : JSON.stringify(data.output ?? ''),
          });
        }
        return;
      }
      default:
        return;
    }
  }

  // -- Capture ----------------------------------------------------------

  private async startCapture(config: RealtimeVoiceConfig): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.actor.send({ type: 'SERVER_ERROR', message: 'Microphone not available in this browser' });
      return;
    }
    const prefs = config.audioSettings;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: prefs.inputDeviceId ? { exact: prefs.inputDeviceId } : undefined,
          echoCancellation: prefs.echoCancellation,
          noiseSuppression: prefs.noiseSuppression,
          autoGainControl: prefs.autoGainControl,
          channelCount: 1,
        },
      });
    } catch (e) {
      this.actor.send({
        type: 'SERVER_ERROR',
        message: e instanceof Error ? e.message : 'Microphone access denied',
      });
      return;
    }
    if (this.snapshot.matches('closed') || this.snapshot.matches('stopping')) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;

    const Ctor =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    this.audioCtx = ctx;

    // Playback bus. Scheduled sources connect here, never straight to a
    // sink, so the meter tap and the sink choice below are the only wiring
    // that varies.
    const bus = ctx.createGain();
    this.playbackBus = bus;
    const playbackAnalyser = ctx.createAnalyser();
    playbackAnalyser.fftSize = 256;
    bus.connect(playbackAnalyser);
    this.playbackAnalyser = playbackAnalyser;

    // Sink: stay on the AudioContext's own clock. Routing through a
    // MediaStream into an <audio> element (the only way to pick an output
    // device before AudioContext.setSinkId) hands playback to the media
    // pipeline, which treats a live stream as needing rate adaptation and
    // time-stretches to track it — audible as the voice drifting up and
    // down in pitch. Chromium 110+ can set the device on the context
    // instead; the element path stays only for engines without it, and
    // only when a device was actually chosen.
    const ctxSetSinkId = (ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
    if (!prefs.outputDeviceId) {
      bus.connect(ctx.destination);
    } else if (typeof ctxSetSinkId === 'function') {
      // A rejected device id leaves the context on the default output, which
      // is the same thing the element path degrades to.
      ctxSetSinkId.call(ctx, prefs.outputDeviceId).catch(() => {});
      bus.connect(ctx.destination);
    } else {
      try {
        const dest = ctx.createMediaStreamDestination();
        bus.connect(dest);
        this.playbackDest = dest;
        const el = new Audio();
        el.srcObject = dest.stream;
        el.play().catch(() => {});
        this.audioOutEl = el;
        const setSink = (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
        if (typeof setSink === 'function') {
          setSink.call(el, prefs.outputDeviceId).catch(() => {});
        }
      } catch {
        this.playbackDest = null;
        bus.connect(ctx.destination);
      }
    }

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    this.analyser = analyser;
    source.connect(analyser);

    const chunker = createSampleChunker(CAPTURE_CHUNK_SAMPLES, (chunk) => {
      this.sendAudioChunk(chunk);
    });
    const onFrames = (frames: Float32Array): void => {
      if (this.snapshot.context.muted || this.duplexHold) {
        return;
      }
      chunker(resampleTo24k(frames, ctx.sampleRate));
    };

    const silentSink = ctx.createGain();
    silentSink.gain.value = 0;
    silentSink.connect(ctx.destination);
    try {
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      this.workletUrl = url;
      const node = new AudioWorkletNode(ctx, 'omni-voice-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
      });
      node.port.onmessage = (ev: MessageEvent) => onFrames(ev.data as Float32Array);
      source.connect(node);
      node.connect(silentSink);
      this.captureNode = node;
    } catch {
      // ScriptProcessor fallback for environments without AudioWorklet.
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (ev: AudioProcessingEvent) => onFrames(ev.inputBuffer.getChannelData(0));
      source.connect(proc);
      proc.connect(silentSink);
      this.captureNode = proc;
    }

    this.applyTrackState();
    this.startMeter();
  }

  private sendAudioChunk(chunk: Float32Array): void {
    const sid = this.sessionId;
    if (!this.client || !sid) {
      return;
    }
    void this.client.sendAudio(sid, bytesToBase64(floatToPcm16(chunk)));
  }

  /**
   * One level for the orb, read from whichever side is actually talking:
   * the playback bus while the agent speaks (the mic is gated off then, so
   * metering it would report silence for the whole turn), the mic otherwise.
   */
  private startMeter(): void {
    const analyser = this.analyser;
    if (!analyser) {
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    let lastTime: number | null = null;
    const tick = (now: number): void => {
      const source = this.playbackActive ? this.playbackAnalyser : this.analyser;
      if (!this.analyser) {
        return;
      }
      // Frame-rate independent, so the ballistics are the same on a 120Hz
      // display as on 60Hz.
      const dt = lastTime === null ? 0 : Math.min((now - lastTime) * 0.001, 0.05);
      lastTime = now;
      source?.getByteFrequencyData(data);
      const level = source ? shapeAudioLevel(weightedAudioLevel(data)) : 0;
      const rate = level > this.smoothedLevel ? LEVEL_ATTACK : LEVEL_RELEASE;
      this.smoothedLevel += (level - this.smoothedLevel) * (1 - Math.pow(1 - rate, dt * 60));
      realtimeVoiceLevel.current = this.smoothedLevel;
      this.meterRaf = requestAnimationFrame(tick);
    };
    this.meterRaf = requestAnimationFrame(tick);
  }

  /** Track enabled state = !(muted || duplexHold). One writer, no flags. */
  private applyTrackState(): void {
    const enabled = !this.snapshot.context.muted && !this.duplexHold;
    this.stream?.getAudioTracks().forEach((t) => {
      t.enabled = enabled;
    });
  }

  private holdDuplex(): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (!this.duplexHold) {
      this.duplexHold = true;
      this.applyTrackState();
    }
  }

  private releaseDuplexHold(delayMs: number): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    const release = (): void => {
      this.releaseTimer = null;
      this.duplexHold = false;
      this.applyTrackState();
    };
    if (delayMs <= 0) {
      release();
    } else {
      this.releaseTimer = setTimeout(release, delayMs);
    }
  }

  private stopCapture(): void {
    if (this.meterRaf !== null) {
      cancelAnimationFrame(this.meterRaf);
      this.meterRaf = null;
    }
    realtimeVoiceLevel.current = 0;
    this.smoothedLevel = 0;
    this.analyser = null;
    if (this.captureNode) {
      try {
        this.captureNode.disconnect();
      } catch {}
      this.captureNode = null;
    }
    if (this.workletUrl) {
      try {
        URL.revokeObjectURL(this.workletUrl);
      } catch {}
      this.workletUrl = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.audioOutEl) {
      try {
        this.audioOutEl.pause();
      } catch {}
      this.audioOutEl.srcObject = null;
      this.audioOutEl = null;
    }
    this.playbackDest = null;
    if (this.playbackBus) {
      try {
        this.playbackBus.disconnect();
      } catch {}
      this.playbackBus = null;
    }
    this.playbackAnalyser = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.duplexHold = false;
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  // -- Playback ---------------------------------------------------------

  private playChunk(b64: string): void {
    const ctx = this.audioCtx;
    if (!ctx || !b64) {
      return;
    }
    let samples: Float32Array;
    try {
      samples = pcm16ToFloat(base64ToBytes(b64));
    } catch {
      return;
    }
    if (!samples.length) {
      return;
    }
    try {
      ctx.resume().catch(() => {});
    } catch {}
    const buffer = ctx.createBuffer(1, samples.length, CAPTURE_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.playbackBus ?? ctx.destination);

    const startAt = Math.max(ctx.currentTime + PLAYBACK_LEAD_S, this.scheduledEnd);
    this.activeSources.add(src);
    src.onended = () => {
      this.activeSources.delete(src);
      // Last scheduled source finished → playback is idle. Sources are
      // scheduled back-to-back, so the set only empties at the real end.
      if (this.activeSources.size === 0 && this.playbackActive) {
        this.playbackActive = false;
        this.scheduledEnd = 0;
        this.actor.send({ type: 'PLAYBACK_IDLE' });
        this.releaseDuplexHold(DUPLEX_RELEASE_MS);
      }
    };
    try {
      src.start(startAt);
    } catch {
      this.activeSources.delete(src);
      return;
    }
    this.scheduledEnd = startAt + buffer.duration;
    if (!this.playbackActive) {
      this.playbackActive = true;
      this.actor.send({ type: 'PLAYBACK_ACTIVE' });
    }
  }

  private stopPlayback(): void {
    this.activeSources.forEach((src) => {
      src.onended = null;
      try {
        src.stop();
      } catch {}
    });
    this.activeSources.clear();
    this.scheduledEnd = 0;
    this.playbackActive = false;
  }

  private teardownTransport(): void {
    this.offEvent?.();
    this.offEvent = null;
    this.client?.disconnect();
    this.client = null;
  }
}
