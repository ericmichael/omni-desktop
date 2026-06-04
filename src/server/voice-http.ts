/**
 * HTTP routes for local voice (Option A) in browser/server mode. The browser
 * renderer (which has no Electron IPC) reaches the host-side VoiceService here.
 *
 * Only registered for self-hosted (non-cloud) deployments — a managed/Azure
 * host must not run per-user local inference (see index.ts registration gate).
 * STT/TTS run on the server host, so this is appropriate only when that host is
 * the user's own machine.
 */

import type { FastifyInstance } from 'fastify';

import { getVoiceService } from '@/main/voice-service';

export const VOICE_HTTP_PREFIX = '/api/voice';

export function registerVoiceRoutes(fastify: FastifyInstance): void {
  const voice = getVoiceService();

  fastify.get(`${VOICE_HTTP_PREFIX}/status`, async () => voice.getStatus());

  fastify.post(`${VOICE_HTTP_PREFIX}/start`, async () => {
    await voice.start();
    return voice.getStatus();
  });

  fastify.post(`${VOICE_HTTP_PREFIX}/transcribe`, async (request) => {
    const { pcm, sampleRate } = (request.body ?? {}) as { pcm?: string; sampleRate?: number };
    if (!pcm) {
return { text: '' };
}
    const text = await voice.transcribe(pcm, sampleRate ?? 24000);
    return { text };
  });

  // Non-streaming for the browser: accumulate the utterance and return it whole.
  fastify.post(`${VOICE_HTTP_PREFIX}/speak`, async (request) => {
    const { text, voice: voiceName } = (request.body ?? {}) as { text?: string; voice?: string };
    if (!text) {
return { pcm: '', sampleRate: 24000 };
}
    const chunks: Buffer[] = [];
    let sampleRate = 24000;
    await voice.speak(
      text,
      (pcmBase64, sr) => {
        sampleRate = sr;
        chunks.push(Buffer.from(pcmBase64, 'base64'));
      },
      voiceName,
    );
    return { pcm: Buffer.concat(chunks).toString('base64'), sampleRate };
  });

  fastify.post(`${VOICE_HTTP_PREFIX}/import-sample`, async (request) => {
    const { personaId, filename, data } = (request.body ?? {}) as {
      personaId?: string;
      filename?: string;
      data?: string;
    };
    if (!personaId || !data) {
return { file: '', embeddingFile: '' };
}
    return await voice.importSample(personaId, filename ?? 'sample.wav', data);
  });
}
