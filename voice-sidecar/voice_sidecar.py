#!/usr/bin/env python3
"""Local voice sidecar for the Omni Code launcher (Option A).

Runs entirely on ONNX Runtime — NO PyTorch:
  - STT: NVIDIA Parakeet CTC via ``onnx_asr``
  - TTS: Kyutai Pocket TTS via ``pocket_tts_onnx`` (KevinAHM/pocket-tts-onnx)

Both model stacks self-provision from Hugging Face on first use (cached). The
launcher provisions the Python env with the bundled ``uv`` and spawns this
process; the renderer captures the mic and plays back the audio.

Transport: newline-delimited JSON on stdin/stdout (one object per line).
  stdout: protocol messages only (responses + events). stderr: human logs.

Requests (stdin):
  {"id": "1", "op": "ping"}
  {"id": "2", "op": "stt", "audio": "<base64 pcm16le mono>", "sample_rate": 24000}
  {"id": "3", "op": "tts", "text": "Hello.", "voice": "alba"}

Responses / events (stdout):
  {"event": "ready", "stt": true, "tts": true, "sample_rate": 24000}
  {"id": "1", "ok": true, "event": "pong"}
  {"id": "2", "ok": true, "text": "hello world"}
  {"id": "3", "event": "audio", "pcm": "<base64 pcm16le>", "sample_rate": 24000}
  {"id": "3", "ok": true, "event": "done"}
  {"id": "?", "ok": false, "error": "..."}            # per-request failure
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import threading
import traceback
from typing import Any, Optional

import numpy as np

STT_SAMPLE_RATE = 16000          # Parakeet expects 16 kHz mono
# The exported Parakeet encoder bakes in a fixed relative-positional-encoding
# buffer (~946 frames ≈ 75 s at 8x/16 kHz subsampling). Audio past that ceiling
# fails the attention broadcast, so long inputs are split into sub-limit windows
# cut on silence. These stay well under the ceiling with margin to spare.
STT_WINDOW_S = 20.0              # preferred window length
STT_HARD_MAX_S = 40.0           # absolute cap per window (<< encoder ceiling)
TTS_REPO = "KevinAHM/pocket-tts-onnx"
TTS_OUTPUT_SR = 24000           # Pocket TTS (mimi) output rate; advertised at boot

_stdout_lock = threading.Lock()


def log(*a: Any) -> None:
    print("[voice-sidecar]", *a, file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    """Write one protocol message as a single JSON line to stdout."""
    line = json.dumps(obj, separators=(",", ":"))
    with _stdout_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def pcm16_b64_to_float32(b64: str) -> np.ndarray:
    raw = base64.b64decode(b64)
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def float32_to_pcm16_b64(x: np.ndarray) -> str:
    x = np.clip(np.asarray(x, dtype=np.float32), -1.0, 1.0)
    pcm = (x * 32767.0).astype("<i2").tobytes()
    return base64.b64encode(pcm).decode("ascii")


def _quietest_boundary(audio: np.ndarray, lo: int, hi: int, hop: int) -> int:
    """Return the start index of the lowest-energy ``hop``-sized frame in [lo, hi)."""
    best, best_e = lo, None
    for i in range(lo, hi, hop):
        seg = audio[i:i + hop]
        e = float(np.dot(seg, seg))
        if best_e is None or e < best_e:
            best, best_e = i, e
    return best


def chunk_audio(audio: np.ndarray, sr: int,
                window_s: float = STT_WINDOW_S,
                hard_max_s: float = STT_HARD_MAX_S):
    """Yield slices of ``audio``, each <= ``hard_max_s`` long, preferring to cut
    on the quietest point near ``window_s`` so words aren't split mid-utterance."""
    n = audio.size
    hard = int(hard_max_s * sr)
    if n <= hard:
        yield audio
        return
    win, hop = int(window_s * sr), int(0.02 * sr)  # 20 ms search granularity
    start = 0
    while start < n:
        if n - start <= hard:
            yield audio[start:]
            return
        target = start + win
        lo = max(start + win // 2, target - win // 2)
        hi = min(target + win // 2, start + hard, n)
        cut = _quietest_boundary(audio, lo, hi, hop)
        if cut <= start:
            cut = min(start + hard, n)
        yield audio[start:cut]
        start = cut


def resample(x: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr or x.size == 0:
        return x.astype(np.float32, copy=False)
    from math import gcd
    g = gcd(int(src_sr), int(dst_sr))
    up, down = int(dst_sr // g), int(src_sr // g)
    try:
        from scipy.signal import resample_poly
        return resample_poly(x, up, down).astype(np.float32)
    except Exception:
        # Linear-interp fallback if scipy is unavailable.
        n = int(round(x.size * dst_sr / src_sr))
        idx = np.linspace(0, x.size - 1, num=n, dtype=np.float32)
        return np.interp(idx, np.arange(x.size, dtype=np.float32), x).astype(np.float32)


# ---------------------------------------------------------------------------
# Engines
# ---------------------------------------------------------------------------

class SttEngine:
    def __init__(self, model_name: str):
        import onnx_asr
        log(f"loading STT model {model_name} ...")
        self._model = onnx_asr.load_model(model_name)
        log("STT ready")

    def transcribe(self, audio: np.ndarray, sample_rate: int) -> str:
        a = resample(audio, sample_rate, STT_SAMPLE_RATE)
        if a.size <= int(STT_HARD_MAX_S * STT_SAMPLE_RATE):
            text = self._model.recognize(a, sample_rate=STT_SAMPLE_RATE)
            return (text or "").strip()
        # Long input: transcribe silence-aligned windows and stitch the results,
        # otherwise the encoder's positional-encoding ceiling is exceeded.
        parts = []
        for chunk in chunk_audio(a, STT_SAMPLE_RATE):
            t = (self._model.recognize(chunk, sample_rate=STT_SAMPLE_RATE) or "").strip()
            if t:
                parts.append(t)
        log(f"transcribed {a.size / STT_SAMPLE_RATE:.1f}s of audio in {len(parts)} chunk(s)")
        return " ".join(parts).strip()


class TtsEngine:
    def __init__(self, language: str, precision: str, default_voice: str,
                 runtime_dir: Optional[str], bundle_dir: Optional[str]):
        runtime_dir, models_dir = _resolve_tts_assets(runtime_dir, bundle_dir, language)
        if runtime_dir not in sys.path:
            sys.path.insert(0, runtime_dir)
        from pocket_tts_onnx import PocketTTSOnnx
        log(f"loading TTS bundle {language} ({precision}) ...")
        self._tts = PocketTTSOnnx(
            models_dir=models_dir, language=language, precision=precision,
        )
        self.sample_rate = int(self._tts.sample_rate)
        self.default_voice = default_voice
        log(f"TTS ready (sample_rate={self.sample_rate})")

    def synth_stream(self, text: str, voice):
        """Yield float32 audio chunks at self.sample_rate.

        ``voice`` may be a predefined name, an audio path, an ``.npy`` embedding
        path, or a precomputed embedding ndarray. See ``_resolve_voice``.
        """
        v = self._resolve_voice(voice if voice is not None else self.default_voice)
        stream = getattr(self._tts, "stream", None)
        if callable(stream):
            try:
                for chunk in stream(text, voice=v):
                    yield np.asarray(chunk, dtype=np.float32)
                return
            except Exception as exc:  # fall back to one-shot
                log(f"stream() failed ({exc!r}); falling back to generate()")
        yield np.asarray(self._tts.generate(text, voice=v), dtype=np.float32)

    def _resolve_voice(self, voice):
        """Resolve a voice arg to what Pocket TTS wants, avoiding re-encodes.

        - ``np.ndarray`` / predefined name → passed straight through.
        - ``*.npy`` path → loaded as a precomputed embedding (no encoder run).
        - audio path (wav/flac/…) → uses a sibling ``<name>.emb.npy`` cache when
          fresh, else encodes once via the mimi encoder and writes the cache.
        """
        if not isinstance(voice, str):
            return voice
        if voice.lower().endswith(".npy"):
            if os.path.exists(voice):
                return np.load(voice)
            log(f"embedding {voice!r} missing; using default voice")
            return self.default_voice
        if voice.lower().endswith((".wav", ".flac", ".mp3", ".ogg", ".m4a")) and os.path.exists(voice):
            cache = os.path.splitext(voice)[0] + ".emb.npy"
            if os.path.exists(cache) and os.path.getmtime(cache) >= os.path.getmtime(voice):
                return np.load(cache)
            emb = self.encode_to(voice, cache)
            return emb
        return voice  # predefined name

    def encode_to(self, src: str, out: str) -> np.ndarray:
        """Encode an audio file to a mimi embedding and persist it as ``out`` (.npy)."""
        emb = self._tts.encode_voice(src)
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        np.save(out, emb)
        log(f"encoded voice embedding {src} -> {out}")
        return emb


def _resolve_tts_assets(runtime_dir: Optional[str], bundle_dir: Optional[str],
                        language: str) -> tuple[str, str]:
    """Return (runtime_dir, models_dir), downloading from HF if not provided."""
    if runtime_dir and bundle_dir:
        return runtime_dir, bundle_dir
    from huggingface_hub import snapshot_download
    log(f"fetching TTS runtime + bundle from {TTS_REPO} (cached) ...")
    snap = snapshot_download(
        TTS_REPO,
        allow_patterns=["pocket_tts_onnx.py", f"onnx/{language}/*"],
    )
    return snap, os.path.join(snap, "onnx")


# ---------------------------------------------------------------------------
# Request handling
# ---------------------------------------------------------------------------

class Lazy:
    """Defers engine construction until first use, so an STT-only session never
    pays TTS's memory + load cost (and vice-versa). Halving the peak resident
    footprint is what keeps the sidecar inside a constrained host's RAM. The
    protocol loop is single-threaded, so no locking is needed; a failed build
    leaves ``_obj`` unset so the next request retries."""

    def __init__(self, build):
        self._build = build
        self._obj: Any = None

    def get(self) -> Any:
        if self._obj is None:
            self._obj = self._build()
        return self._obj


def handle(req: dict, stt: Optional[Lazy], tts: Optional[Lazy]) -> None:
    rid = req.get("id")
    op = req.get("op")

    if op == "ping":
        emit({"id": rid, "ok": True, "event": "pong"})
        return

    if op == "stt":
        if stt is None:
            emit({"id": rid, "ok": False, "error": "STT disabled"})
            return
        engine = stt.get()
        audio = pcm16_b64_to_float32(req["audio"])
        text = engine.transcribe(audio, int(req.get("sample_rate", STT_SAMPLE_RATE)))
        emit({"id": rid, "ok": True, "text": text})
        return

    if op == "encode_voice":
        if tts is None:
            emit({"id": rid, "ok": False, "error": "TTS disabled"})
            return
        src = req.get("file")
        if not src or not os.path.exists(src):
            emit({"id": rid, "ok": False, "error": f"audio file not found: {src!r}"})
            return
        out = req.get("cache") or (os.path.splitext(src)[0] + ".emb.npy")
        tts.get().encode_to(src, out)
        emit({"id": rid, "ok": True, "embedding_file": out})
        return

    if op == "tts":
        if tts is None:
            emit({"id": rid, "ok": False, "error": "TTS disabled"})
            return
        text = (req.get("text") or "").strip()
        if not text:
            emit({"id": rid, "ok": True, "event": "done"})
            return
        engine = tts.get()
        for chunk in engine.synth_stream(text, req.get("voice")):
            if chunk.size:
                emit({"id": rid, "event": "audio",
                      "pcm": float32_to_pcm16_b64(chunk),
                      "sample_rate": engine.sample_rate})
        emit({"id": rid, "ok": True, "event": "done", "sample_rate": engine.sample_rate})
        return

    emit({"id": rid, "ok": False, "error": f"unknown op {op!r}"})


def main() -> None:
    p = argparse.ArgumentParser(description="Omni Code local voice sidecar (ONNX, torch-free)")
    p.add_argument("--language", default="english_2026-04")
    p.add_argument("--precision", default="int8", choices=["int8", "fp32"])
    p.add_argument("--voice", default="alba", help="Default TTS voice (predefined name or wav path)")
    p.add_argument("--stt-model", default="nemo-parakeet-ctc-0.6b")
    p.add_argument("--runtime-dir", default=os.environ.get("POCKET_TTS_RUNTIME_DIR"))
    p.add_argument("--bundle-dir", default=os.environ.get("POCKET_TTS_BUNDLE_DIR"))
    p.add_argument("--no-stt", action="store_true")
    p.add_argument("--no-tts", action="store_true")
    p.add_argument("--selftest", action="store_true", help="Run an in-process TTS→STT round-trip and exit")
    p.add_argument("--encode", metavar="AUDIO",
                   help="Authoring: encode AUDIO to a mimi embedding (.npy) and exit. Pair with --out.")
    p.add_argument("--out", help="Output .npy path for --encode (default: <audio>.emb.npy)")
    args = p.parse_args()

    # Authoring mode: produce a precomputed embedding (e.g. voices/jarvis.emb.npy)
    # from a master sample, so built-in personas can ship embedding-only. STT not needed.
    if args.encode:
        tts = TtsEngine(args.language, args.precision, args.voice, args.runtime_dir, args.bundle_dir)
        out = args.out or (os.path.splitext(args.encode)[0] + ".emb.npy")
        tts.encode_to(args.encode, out)
        log(f"wrote {out}")
        sys.exit(0)

    # Engines load lazily on first use (see Lazy) so a transcription-only session
    # never constructs the TTS stack — that halved peak RAM is what keeps the
    # sidecar from being OOM-killed on a constrained host.
    stt = None if args.no_stt else Lazy(lambda: SttEngine(args.stt_model))
    tts = None if args.no_tts else Lazy(lambda: TtsEngine(
        args.language, args.precision, args.voice, args.runtime_dir, args.bundle_dir))

    if args.selftest:
        ok = _selftest(stt.get() if stt else None, tts.get() if tts else None)
        sys.exit(0 if ok else 1)

    # Ready is emitted before any model loads — the process is up and can accept
    # requests; the first stt/tts op pays its engine's load latency. sample_rate
    # is the known Pocket output rate (each audio chunk also carries its own).
    emit({"event": "ready",
          "stt": stt is not None,
          "tts": tts is not None,
          "sample_rate": TTS_OUTPUT_SR if tts is not None else None})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            emit({"ok": False, "error": f"bad json: {exc}"})
            continue
        try:
            handle(req, stt, tts)
        except Exception as exc:
            log("request error:\n" + traceback.format_exc())
            emit({"id": req.get("id"), "ok": False, "error": str(exc)})


def _selftest(stt: Optional[SttEngine], tts: Optional[TtsEngine]) -> bool:
    text = "Hello, this is a test of local voice synthesis."
    if tts is None or stt is None:
        log("selftest needs both engines"); return False
    chunks = list(tts.synth_stream(text, None))
    audio = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)
    log(f"TTS produced {audio.size / tts.sample_rate:.2f}s @ {tts.sample_rate} Hz in {len(chunks)} chunk(s)")
    heard = stt.transcribe(audio, tts.sample_rate)
    log(f"STT heard: {heard!r}")
    ok = "local voice" in heard.lower()
    log("SELFTEST", "OK" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    main()
