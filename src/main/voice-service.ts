/**
 * Local voice service (Option A) — launcher-side STT + TTS, fully local,
 * torch-free. Supervises the Python voice sidecar (voice-sidecar/voice_sidecar.py)
 * which runs Parakeet STT (onnx_asr) and Pocket TTS (pocket_tts_onnx) on ONNX
 * Runtime. The renderer captures the mic and plays back the audio; the agent
 * speaks via the client `speak` tool, which routes here through IPC.
 *
 * This is intentionally independent of the omni-code agent runtime — none of
 * the agent's Python env, the voice pipeline, or omniagents is involved. It is
 * only wired in for LOCAL-compute, Electron/self-hosted modes.
 *
 * Provisioning reuses the bundled `uv` (same binary the omni runtime uses) to
 * create a dedicated venv and install the ONNX deps. Models self-download from
 * Hugging Face on first use (cached).
 */

import { type ChildProcess, spawn } from 'child_process';
import { execFile } from 'child_process';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { getOmniRuntimeDir, getUVExecutablePath, isDevelopment } from '@/main/util';
import type { VoiceStatus } from '@/shared/types';
import { BUILTIN_VOICE_FALLBACKS } from '@/shared/voice-personas';

const execFileAsync = promisify(execFile);

const PYTHON_VERSION = '3.11';
const VOICE_DEPS = [
  'onnx-asr',
  'onnxruntime',
  'soundfile',
  'numpy',
  'scipy',
  'sentencepiece',
  'safetensors',
  'huggingface_hub',
];
const VOICE_REQUEST_TIMEOUT_MS = 110_000;

/** Per-request resolver state keyed by the protocol message `id`. */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** TTS only: called for each streamed audio chunk. */
  onAudio?: (pcmBase64: string, sampleRate: number) => void;
}

const voiceVenvDir = (): string => path.join(getOmniRuntimeDir(), '.voice-venv');
const voiceVenvPython = (): string =>
  path.join(voiceVenvDir(), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

/** Dir holding the sidecar — repo path in dev, extraResources when packaged. */
const voiceSidecarDir = (): string => {
  if (isDevelopment() || !app.isPackaged || !process.resourcesPath) {
    return path.resolve(path.join(__dirname, '..', '..', 'voice-sidecar'));
  }
  return path.resolve(path.join(process.resourcesPath, 'voice-sidecar'));
};

const sidecarScriptPath = (): string => path.join(voiceSidecarDir(), 'voice_sidecar.py');

/** Dir of bundled built-in persona embeddings (voice-sidecar/voices/<id>.emb.npy). */
const bundledVoicesDir = (): string => path.join(voiceSidecarDir(), 'voices');

/** Where user-imported voice samples + their embeddings live. */
const voiceSamplesDir = (): string => path.join(app.getPath('userData'), 'voice-samples');

export class VoiceService {
  private proc: ChildProcess | null = null;
  private stdoutBuf = '';
  private pending = new Map<string, Pending>();
  private seq = 0;
  private status: VoiceStatus = { state: 'idle', stt: false, tts: false, sampleRate: null };
  private readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private starting: Promise<void> | null = null;

  /** Default TTS voice (a predefined Pocket voice, or a wav path for cloning). */
  voice = process.env.OMNI_VOICE_NAME || 'alba';

  getStatus(): VoiceStatus {
    return { ...this.status };
  }

  /** Provision the venv (idempotent) then spawn the sidecar. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.status.state === 'ready') {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async _start(): Promise<void> {
    try {
      await this.ensureProvisioned();
      this.status = { ...this.status, state: 'starting' };
      const py = voiceVenvPython();
      const script = sidecarScriptPath();
      const child = spawn(py, [script, '--voice', this.voice], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      this.proc = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
      child.stderr.on('data', (d: Buffer) => console.error('[voice-sidecar]', d.toString().trimEnd()));
      child.on('exit', (code) => this.onExit(code));
      child.on('error', (err) => this.fail(err.message));

      await new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve: () => {
            clearTimeout(t);
            resolve();
          },
          reject: (err: Error) => {
            clearTimeout(t);
            this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
            reject(err);
          },
        };
        const t = setTimeout(() => waiter.reject(new Error('voice sidecar did not become ready in 120s')), 120_000);
        this.readyWaiters.push(waiter);
      });
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Create the venv + install ONNX deps with the bundled uv if missing. */
  async ensureProvisioned(): Promise<void> {
    if (fs.existsSync(voiceVenvPython())) {
      return;
    }
    this.status = { ...this.status, state: 'provisioning' };
    const uv = getUVExecutablePath();
    const venv = voiceVenvDir();
    fs.mkdirSync(path.dirname(venv), { recursive: true });
    console.log('[voice] provisioning voice venv at', venv);
    await execFileAsync(uv, ['venv', venv, '--python', PYTHON_VERSION], { env: process.env });
    await execFileAsync(uv, ['pip', 'install', '--python', voiceVenvPython(), ...VOICE_DEPS], {
      env: { ...process.env, VIRTUAL_ENV: venv },
      maxBuffer: 64 * 1024 * 1024,
    });
    console.log('[voice] voice venv ready');
  }

  /** Transcribe PCM16LE mono audio (base64) at the given sample rate → text. */
  async transcribe(pcmBase64: string, sampleRate: number): Promise<string> {
    await this.start();
    const res = (await this.request({ op: 'stt', audio: pcmBase64, sample_rate: sampleRate })) as {
      text?: string;
    };
    return res.text ?? '';
  }

  /**
   * Synthesize `text` and stream PCM16LE chunks to `onAudio`. Resolves when the
   * full utterance has been emitted.
   */
  async speak(text: string, onAudio: (pcmBase64: string, sampleRate: number) => void, voice?: string): Promise<void> {
    await this.start();
    await this.request({ op: 'tts', text, voice: this.resolveVoice(voice) }, onAudio);
  }

  /**
   * Resolve a renderer-supplied voice arg to what the sidecar consumes:
   * - `builtin:<id>` → the bundled `<id>.emb.npy` if present, else the persona's
   *   predefined fallback (so a missing-asset build still talks).
   * - anything else (predefined name, absolute `.npy`/wav path) → unchanged.
   */
  private resolveVoice(voice?: string): string {
    if (!voice) {
      return this.voice;
    }
    if (!voice.startsWith('builtin:')) {
      return voice;
    }
    const id = voice.slice('builtin:'.length);
    const npy = path.join(bundledVoicesDir(), `${id}.emb.npy`);
    if (fs.existsSync(npy)) {
      return npy;
    }
    const fallback = BUILTIN_VOICE_FALLBACKS[id];
    if (fallback) {
      console.warn(`[voice] bundled embedding for '${id}' missing; falling back to '${fallback}'`);
      return fallback;
    }
    return this.voice;
  }

  /**
   * Import a voice-clone sample: persist the audio under userData, precompute
   * its mimi embedding once (sidecar `encode_voice`), and return both paths. The
   * `.npy` is what later `speak()` calls reference, so no re-encoding ever runs.
   */
  async importSample(
    personaId: string,
    filename: string,
    dataBase64: string
  ): Promise<{ file: string; embeddingFile: string }> {
    await this.start();
    const dir = voiceSamplesDir();
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(filename || '').toLowerCase() || '.wav';
    const file = path.join(dir, `${personaId}${ext}`);
    fs.writeFileSync(file, Buffer.from(dataBase64, 'base64'));
    const cache = path.join(dir, `${personaId}.emb.npy`);
    const res = (await this.request({ op: 'encode_voice', file, cache })) as {
      embedding_file?: string;
    };
    return { file, embeddingFile: res.embedding_file ?? cache };
  }

  private request(payload: Record<string, unknown>, onAudio?: Pending['onAudio']): Promise<unknown> {
    if (!this.proc || !this.proc.stdin) {
      return Promise.reject(new Error('voice sidecar not running'));
    }
    const id = String(++this.seq);
    const line = `${JSON.stringify({ id, ...payload })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`voice request timed out after ${Math.round(VOICE_REQUEST_TIMEOUT_MS / 1000)}s`));
        this.restartAfterStalledRequest();
      }, VOICE_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, onAudio });
      this.proc!.stdin!.write(line, (err) => {
        if (err) {
          const pending = this.pending.get(id);
          this.pending.delete(id);
          if (pending) {
            clearTimeout(pending.timer);
          }
          reject(err);
        }
      });
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) {
        continue;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error('[voice] non-JSON line:', line);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (msg.event === 'ready') {
      this.status = {
        state: 'ready',
        stt: Boolean(msg.stt),
        tts: Boolean(msg.tts),
        sampleRate: typeof msg.sample_rate === 'number' ? msg.sample_rate : null,
      };
      this.readyWaiters.splice(0).forEach((w) => w.resolve());
      return;
    }
    const id = msg.id != null ? String(msg.id) : null;
    if (!id) {
      return;
    }
    const p = this.pending.get(id);
    if (!p) {
      return;
    }

    if (msg.event === 'audio' && typeof msg.pcm === 'string') {
      p.onAudio?.(msg.pcm, typeof msg.sample_rate === 'number' ? msg.sample_rate : 24000);
      return; // more chunks (or `done`) to come
    }
    // Terminal message for this request.
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.ok === false) {
      p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'voice request failed'));
    } else {
      p.resolve(msg);
    }
  }

  private onExit(code: number | null): void {
    const err = new Error(`voice sidecar exited (code ${code})`);
    this.pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(err);
    });
    this.pending.clear();
    // Reject (not resolve) any in-flight start() so the caller sees the crash
    // instead of a false "ready" — otherwise voice:start/api returns success
    // and the next transcribe fails with an opaque "sidecar not running".
    this.readyWaiters.splice(0).forEach((w) => w.reject(err));
    this.proc = null;
    if (this.status.state !== 'error') {
      this.status = { state: 'idle', stt: false, tts: false, sampleRate: null };
    }
  }

  private fail(message: string): void {
    this.status = { state: 'error', stt: false, tts: false, sampleRate: null, error: message };
    this.readyWaiters.splice(0).forEach((w) => w.reject(new Error(message)));
  }

  private restartAfterStalledRequest(): void {
    const child = this.proc;
    if (!child) {
      return;
    }
    console.warn('[voice] restarting sidecar after stalled request');
    child.kill();
  }

  dispose(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

let _instance: VoiceService | null = null;
export const getVoiceService = (): VoiceService => {
  if (!_instance) {
    _instance = new VoiceService();
  }
  return _instance;
};
