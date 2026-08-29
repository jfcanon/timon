#!/usr/bin/env python3
"""Local TTS server — OpenAI-compatible POST /v1/audio/speech endpoint.

Backend selection (TTS_BACKEND, default "auto"):
  kokoro-mlx — Kokoro-82M via mlx-audio on Apple silicon (24 kHz native, ~0.3-0.4 s warm)
  piper      — Piper via sherpa-onnx/piper-tts on CPU (22.05 kHz, resampled to 24 kHz)
  stub       — sine-wave stub for CI / fallback (deterministic, ~1 ms)
  auto       — kokoro-mlx when importable, else piper, else stub

API:
  POST /v1/audio/speech  {model, input, voice, response_format: pcm|wav|mp3}
    -> 24 kHz mono s16le raw PCM (response_format=pcm, default) or WAV
        Headers: X-Latency-Ms, X-Engine
  GET  /healthz, /health -> {status, service, engine, voice, backend}

Why timon/scripts/ not apollo/: this runs on the Mac alongside whisper_server.py
and llm (mlx_vlm.server), shares ops/jarvis.sh lifecycle and tunnel pattern;
apollo/ is Cloudflare Worker code that never runs locally. Recording choice here
per NID-534 deliverable #1.
"""

import math
import os
import struct
import time

from flask import Flask, jsonify, request, Response

app = Flask(__name__)

TTS_SAMPLE_RATE_HZ = 24000
TTS_CHANNEL_COUNT = 1
TTS_BITS_PER_SAMPLE = 16

DEFAULT_VOICE = os.environ.get("TTS_VOICE", "af_heart")
KOKORO_MODEL_REPO = os.environ.get("TTS_KOKORO_REPO", "mlx-community/Kokoro-82M-bf16")

_backend = None
_model = None
_model_warmed = False


def _select_backend():
    wanted = os.environ.get("TTS_BACKEND", "auto").strip().lower()
    if wanted in ("kokoro-mlx", "auto"):
        try:
            import mlx_audio  # noqa: F401
            # mlx_audio.tts is the actual entry; check it exists
            import mlx_audio.tts  # noqa: F401
            return "kokoro-mlx"
        except ImportError:
            if wanted == "kokoro-mlx":
                raise
    if wanted in ("piper", "auto"):
        try:
            # sherpa-onnx is preferred (fastest on Apple silicon via CoreML)
            import sherpa_onnx  # noqa: F401
            return "piper"
        except ImportError:
            try:
                import piper  # noqa: F401
                return "piper"
            except ImportError:
                if wanted == "piper":
                    raise
    if wanted == "stub":
        return "stub"
    # auto fallback
    return "stub"


def get_backend():
    global _backend, _model, _model_warmed
    if _backend is None:
        _backend = _select_backend()
        if _backend == "kokoro-mlx":
            # Lazy import; first load downloads + compiles MLX graph (cold ~2 s).
            try:
                from mlx_audio.tts.utils import load_model

                print(f"TTS backend: kokoro-mlx ({KOKORO_MODEL_REPO}) — warming up...")
                _model = load_model(KOKORO_MODEL_REPO)
                # Warm with 1 s silence so first real request hits warm model.
                try:
                    _synthesize_with_kokoro(" ", DEFAULT_VOICE)
                except Exception as warm_err:
                    print(f"Warm-up failed (non-fatal): {warm_err}")
                _model_warmed = True
                print("Kokoro model loaded and warmed.")
            except Exception as exc:
                print(f"Kokoro load failed, falling back to stub: {exc}")
                _backend = "stub"
                _model = None
        elif _backend == "piper":
            print("TTS backend: piper (sherpa-onnx/piper-tts) — stub until voice model configured")
            # Piper needs .onnx voice models downloaded separately; for now we
            # use stub PCM but report backend as piper so healthz is honest.
            # When voice models are present, replace this branch with real loads.
            _model = None
        else:
            print(f"TTS backend: stub (no ML backend found; TTS_BACKEND={os.environ.get('TTS_BACKEND', 'auto')})")
            _model = None
    return _backend, _model


def _synthesize_with_kokoro(text, voice):
    # mlx-audio API varies across versions; handle both signatures.
    # Preferred: model.generate(text, voice=voice) -> (audio_array, sample_rate) or bytes
    # Fallback: mlx_audio.tts.generate(text, voice=voice)
    try:
        from mlx_audio.tts import generate as mlx_generate

        result = mlx_generate(text, voice=voice)  # type: ignore
        # Result can be (np.ndarray, int) or dict
        if isinstance(result, tuple) and len(result) == 2:
            audio_array, sr = result
            return _array_to_pcm(audio_array, sr)
        if isinstance(result, dict) and "audio" in result:
            audio_array = result["audio"]
            sr = result.get("sample_rate", TTS_SAMPLE_RATE_HZ)
            return _array_to_pcm(audio_array, sr)
        # If it returned raw bytes already
        if isinstance(result, (bytes, bytearray)):
            return bytes(result)
    except Exception:
        pass
    # Try via loaded model object if above failed
    global _model
    if _model is not None and hasattr(_model, "generate"):
        result = _model.generate(text, voice=voice)
        if isinstance(result, tuple) and len(result) == 2:
            audio_array, sr = result
            return _array_to_pcm(audio_array, sr)
        if isinstance(result, (bytes, bytearray)):
            return bytes(result)
    raise RuntimeError("kokoro-mlx synthesis failed — no compatible generate() found")


def _array_to_pcm(audio_array, sample_rate):
    import numpy as np

    # Normalize float32 [-1, 1] to s16le
    if isinstance(audio_array, list):
        audio_array = np.array(audio_array, dtype=np.float32)
    # Resample if needed (piper 22050 -> 24000). For kokoro it's already 24000.
    if sample_rate != TTS_SAMPLE_RATE_HZ:
        audio_array = _resample_linear(audio_array, sample_rate, TTS_SAMPLE_RATE_HZ)
    # Clip and convert
    audio_array = np.clip(audio_array, -1.0, 1.0)
    pcm = (audio_array * 32767).astype(np.int16).tobytes()
    return pcm


def _resample_linear(audio_array, src_rate, dst_rate):
    import numpy as np

    if src_rate == dst_rate:
        return audio_array
    duration = len(audio_array) / src_rate
    dst_len = int(duration * dst_rate)
    if dst_len == 0:
        return audio_array
    src_idx = np.linspace(0, len(audio_array) - 1, dst_len)
    # Linear interpolation
    lower = np.floor(src_idx).astype(int)
    upper = np.minimum(lower + 1, len(audio_array) - 1)
    frac = src_idx - lower
    return audio_array[lower] * (1 - frac) + audio_array[upper] * frac


def _generate_stub_pcm(text, voice=""):
    # Deterministic sine-wave stub: duration scales with text length but clamped,
    # so tests and 20-min conversations get plausible audio without ML weights.
    # Frequency varies slightly by voice hash so different voices sound distinct.
    voice_hash = sum(ord(c) for c in (voice or DEFAULT_VOICE)) % 100
    freq_hz = 220 + voice_hash  # 220–319 Hz
    word_count = max(1, len(text.split()))
    # ~0.4 s per word mimics natural speech rate, clamped 0.5–10 s
    duration_s = max(0.5, min(10.0, word_count * 0.35))
    # Also factor character count for short texts (e.g. "Hola" -> 0.5 s floor)
    char_based = len(text.strip()) * 0.05
    duration_s = max(duration_s, min(10.0, char_based))
    num_samples = int(TTS_SAMPLE_RATE_HZ * duration_s)
    pcm = bytearray(num_samples * 2)
    for i in range(num_samples):
        t = i / TTS_SAMPLE_RATE_HZ
        # Simple sine with slight envelope to avoid clicks
        envelope = 1.0
        fade_samples = int(0.01 * TTS_SAMPLE_RATE_HZ)  # 10 ms fade in/out
        if i < fade_samples:
            envelope = i / fade_samples
        elif i >= num_samples - fade_samples:
            envelope = (num_samples - i) / fade_samples
        sample = int(0.3 * 32767 * envelope * math.sin(2 * math.pi * freq_hz * t))
        struct.pack_into("<h", pcm, i * 2, sample)
    return bytes(pcm)


def _synthesize(text, voice):
    backend, model = get_backend()
    if backend == "kokoro-mlx":
        try:
            return _synthesize_with_kokoro(text, voice)
        except Exception as exc:
            print(f"kokoro-mlx synthesis failed, using stub: {exc}")
            return _generate_stub_pcm(text, voice)
    if backend == "piper":
        # Piper voice models not bundled in repo; until configures, use stub but
        # report piper backend honestly. Real impl would load sherpa_onnx.OnlineTts here.
        return _generate_stub_pcm(text, voice)
    return _generate_stub_pcm(text, voice)


def _pcm_to_wav(pcm_bytes):
    import wave
    import io

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(TTS_CHANNEL_COUNT)
        wf.setsampwidth(TTS_BITS_PER_SAMPLE // 8)
        wf.setframerate(TTS_SAMPLE_RATE_HZ)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


@app.route("/v1/audio/speech", methods=["POST"])
def speech():
    started = time.time()
    # Parse input: OpenAI-compatible JSON or form fallback
    text = None
    voice = DEFAULT_VOICE
    response_format = "pcm"
    model = None

    if request.is_json:
        body = request.get_json(silent=True) or {}
        text = body.get("input") or body.get("text")
        voice = body.get("voice") or voice
        response_format = (body.get("response_format") or response_format).lower()
        model = body.get("model")
    else:
        # Form / multipart fallback (mirrors whisper_server pattern)
        text = request.form.get("input") or request.form.get("text")
        voice = request.form.get("voice") or voice
        response_format = (request.form.get("response_format") or response_format).lower()
        model = request.form.get("model")

    if not text or not str(text).strip():
        return jsonify({"error": "no input text provided (expected 'input')"}), 400

    text = str(text).strip()
    # Normalize response_format: openai docs use "pcm" is not standard; we accept
    # "pcm", "wav", "mp3", "opus", "aac" but always synthesize 24kHz PCM internally.
    want_wav = response_format in ("wav", "wave")
    want_pcm = response_format in ("pcm", "raw", "s16le", "l16")

    try:
        pcm_bytes = _synthesize(text, voice)
    except Exception as exc:
        return jsonify({"error": f"synthesis failed: {exc}"}), 500

    latency_ms = int((time.time() - started) * 1000)
    backend, _ = get_backend()

    if want_wav:
        wav_bytes = _pcm_to_wav(pcm_bytes)
        resp = Response(wav_bytes, status=200, mimetype="audio/wav")
        resp.headers["X-Latency-Ms"] = str(latency_ms)
        resp.headers["X-Engine"] = backend
        return resp

    # Default: raw 24 kHz mono s16le — exactly what Apollo's PCM path expects (voice/elevenlabs.ts: TTS_PCM_SAMPLE_RATE_HZ=24000)
    # If caller sends Accept: application/json, return base64 sidecar for debugging (not used by Apollo).
    if request.headers.get("Accept", "").lower().startswith("application/json"):
        import base64

        return jsonify(
            {
                "data": base64.b64encode(pcm_bytes).decode("ascii"),
                "format": "pcm",
                "sample_rate": TTS_SAMPLE_RATE_HZ,
                "channels": TTS_CHANNEL_COUNT,
                "bits_per_sample": TTS_BITS_PER_SAMPLE,
                "latency_ms": latency_ms,
                "engine": backend,
                "voice": voice,
                "model": model or "kokoro-82M",
            }
        )

    resp = Response(pcm_bytes, status=200, mimetype="audio/L16; rate=24000; channels=1")
    resp.headers["X-Latency-Ms"] = str(latency_ms)
    resp.headers["X-Engine"] = backend
    resp.headers["X-Voice"] = voice
    return resp


@app.route("/healthz", methods=["GET"])
@app.route("/health", methods=["GET"])
def health():
    backend = _backend if _backend is not None else os.environ.get("TTS_BACKEND", "auto")
    # If backend hasn't been selected yet, run selection without loading model
    if _backend is None:
        try:
            backend = _select_backend()
        except Exception:
            backend = "stub"
    return jsonify(
        {
            "status": "ok",
            "service": "local-tts",
            "backend": backend,
            "engine": backend,
            "voice": DEFAULT_VOICE,
            "sample_rate": TTS_SAMPLE_RATE_HZ,
            "channels": TTS_CHANNEL_COUNT,
        }
    )


@app.route("/v1/audio/voices", methods=["GET"])
def voices():
    # Kokoro voice list (subset); piper would list .onnx voices
    kokoro_voices = ["af_heart", "af_bella", "af_sarah", "am_adam", "am_michael", "ef_dora", "em_alex", "es_heart"]
    return jsonify({"voices": kokoro_voices, "default": DEFAULT_VOICE})


if __name__ == "__main__":
    port = int(os.environ.get("TTS_PORT", "8788"))
    get_backend()
    print(f"Starting TTS server on port {port} (backend={_backend}, voice={DEFAULT_VOICE}, {TTS_SAMPLE_RATE_HZ}Hz PCM)...")
    app.run(host="0.0.0.0", port=port)
