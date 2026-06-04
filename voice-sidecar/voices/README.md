# Built-in persona voice embeddings

Built-in voice personas (e.g. **Jarvis**) ship as **precomputed mimi embeddings**
— `<persona-id>.emb.npy` — and **not** as source audio. The embedding is the only
artifact the TTS sidecar needs at runtime: `PocketTTSOnnx.prepare_voice_state`
accepts the embedding ndarray directly, so no per-utterance (or per-launch)
encode ever runs for a built-in.

These `.npy` files are shipped via electron-builder `extraResources` (see the
`voices/**` filter in `electron-builder.config.ts`) and resolved at runtime by
`VoiceService.resolveVoice` from a `builtin:<id>` token.

## Authoring an embedding

Keep the master sample **out of this repo** (privacy / likeness). On a machine
with the provisioned voice venv, encode it once:

```bash
python voice-sidecar/voice_sidecar.py \
  --encode /path/to/master-jarvis.wav \
  --out    voice-sidecar/voices/jarvis.emb.npy
```

Commit only the resulting `jarvis.emb.npy`.

## When to regenerate

The embedding is **coupled to the TTS model bundle** (mimi encoder + language,
currently `english_2026-04`). If the bundle pin in `voice_sidecar.py` changes,
re-run the `--encode` step from the master sample so the embedding matches the
new encoder. Until a real `jarvis.emb.npy` is present, Jarvis falls back to the
predefined `javert` voice (see `BUILTIN_VOICE_FALLBACKS`).
