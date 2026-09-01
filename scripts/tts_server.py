#!/usr/bin/env python3
"""Local TTS server — OpenAI-compatible POST /v1/audio/speech endpoint.

Backend selection (TTS_BACKEND, default "auto"):
  kokoro-mlx — Kokoro-82M via mlx-audio[tts] on Apple silicon (24 kHz native, ~0.3-0.4 s warm)
  stub       — sine-wave stub for CI / fallback (deterministic, ~1 ms)
  auto       — kokoro-mlx when importable and warmable, else stub

API:
  POST /v1/audio/speech  {model, input, voice, response_format: pcm|wav}
    -> 24 kHz mono s16le raw PCM (response_format=pcm, default) or WAV
        Headers: X-Latency-Ms, X-Engine
  GET  /healthz, /health -> {status, service, engine, voice, backend, model_loaded, warm}

Why timon/scripts/ not apollo/: this runs on the Mac alongside whisper_server.py
and llm (mlx_vlm.server), shares ops/jarvis.sh lifecycle and tunnel pattern;
apollo/ is Cloudflare Worker code that never runs locally. Recorded per NID-534.
"""

import os
import time

from flask import Flask, jsonify, request, Response

app = Flask(__name__)

TTS_SAMPLE_RATE_HZ = 24000
TTS_CHANNEL_COUNT = 1
TTS_BITS_PER_SAMPLE = 16
MAX_INPUT_CHARS = 500

DEFAULT_VOICE = os.environ.get("TTS_VOICE", "af_heart")
KOKORO_MODEL_REPO = os.environ.get("TTS_KOKORO_REPO", "mlx-community/Kokoro-82M-bf16")
# prince-canuma/Kokoro-82M is the voice repo; mlx variant is separate
KOKORO_VOICE_REPO = os.environ.get("TTS_KOKORO_VOICE_REPO", "prince-canuma/Kokoro-82M")

_backend = None
_model = None
_pipeline_map = {}
_model_loaded = False
_model_error = None

# Valid Kokoro voices (confirmed in hf hub). es_heart does not exist; Spanish is ef_dora/em_alex
VALID_KOKORO_VOICES = {
    "af_heart", "af_bella", "af_sarah", "af_nicole", "af_sky",
    "am_adam", "am_michael",
    "bf_emma", "bf_isabella",
    "bm_george", "bm_lewis",
    "ef_dora", "em_alex", "em_santa",
}


def _lang_code_for_voice(voice):
    # Kokoro LANG_CODES: a/b=American/British English, e=Spanish, f=French, etc.
    # Prefix 'e' -> Spanish pipeline (misaki espeak). Default to 'a'.
    v = (voice or DEFAULT_VOICE).lower()
    if v.startswith("e"):
        return "e"
    if v.startswith("b"):
        return "b"
    return "a"


def _select_backend():
    wanted = os.environ.get("TTS_BACKEND", "auto").strip().lower()
    if wanted in ("kokoro-mlx", "auto"):
        try:
            import mlx_audio  # noqa: F401
            import mlx_audio.tts  # noqa: F401
            # Check that the tts extra is installed (misaki)
            import misaki  # noqa: F401
            return "kokoro-mlx"
        except ImportError as exc:
            if wanted == "kokoro-mlx":
                raise
            print(f"kokoro-mlx not available ({exc}), falling back to stub")
    if wanted == "stub":
        return "stub"
    if wanted == "piper":
        # Not implemented yet; reviewer requires not masquerading as piper
        print("piper backend requested but not implemented — using stub")
        return "stub"
    return "stub"


def get_backend():
    global _backend, _model, _pipeline_map, _model_loaded, _model_error
    if _backend is None:
        _backend = _select_backend()
        if _backend == "kokoro-mlx":
            try:
                from mlx_audio.tts.utils import load_model
                from mlx_audio.tts.models.kokoro.pipeline import KokoroPipeline

                print(f"TTS backend: kokoro-mlx ({KOKORO_MODEL_REPO}) — loading...")
                _model = load_model(KOKORO_MODEL_REPO)
                # Create pipelines per lang_code lazily; warm the default one
                default_lang = _lang_code_for_voice(DEFAULT_VOICE)
                pipeline = KokoroPipeline(lang_code=default_lang, model=_model, repo_id=KOKORO_VOICE_REPO)
                _pipeline_map[default_lang] = pipeline
                # Warm with a short phrase: first call compiles MLX graph (~2.2 s)
                try:
                    list(pipeline("Hello", voice=DEFAULT_VOICE))
                    print("Kokoro model loaded and warmed (default lang).")
                    _model_loaded = True
                    _model_error = None
                except Exception as warm_err:
                    print(f"Warm-up failed — keeping kokoro-mlx but degraded: {warm_err}")
                    _model_error = str(warm_err)
                    _model_loaded = False
                    # Keep _backend as kokoro-mlx so health reports degraded (503) and
                    # synthesis returns 502 instead of silent sine tone
                else:
                    _model_loaded = True
            except Exception as exc:
                # Explicit kokoro-mlx request should stay degraded (not silent stub)
                if os.environ.get("TTS_BACKEND", "auto").strip().lower() == "kokoro-mlx":
                    print(f"Kokoro load failed (explicit) — degraded: {exc}")
                    _model_error = str(exc)
                    _model_loaded = False
                else:
                    print(f"Kokoro load failed, falling back to stub: {exc}")
                    _backend = "stub"
                    _model = None
                    _pipeline_map = {}
                    _model_error = str(exc)
                    _model_loaded = False
        else:
            print(f"TTS backend: stub (TTS_BACKEND={os.environ.get('TTS_BACKEND', 'auto')})")
            _model_loaded = False
    return _backend, _model


def _synthesize_with_kokoro(text, voice):
    global _pipeline_map, _model
    if _model is None:
        raise RuntimeError("kokoro model not loaded")
    lang_code = _lang_code_for_voice(voice)
    pipeline = _pipeline_map.get(lang_code)
    if pipeline is None:
        from mlx_audio.tts.models.kokoro.pipeline import KokoroPipeline
        pipeline = KokoroPipeline(lang_code=lang_code, model=_model, repo_id=KOKORO_VOICE_REPO)
        _pipeline_map[lang_code] = pipeline
    if voice not in VALID_KOKORO_VOICES:
        print(f"Warning: voice {voice} not in known list; attempting anyway (may 404)")
    # pipeline is a generator: yields Result per chunk; need to concatenate
    import numpy as np
    audio_chunks = []
    for result in pipeline(text, voice=voice):
        if result.output is not None and hasattr(result.output, "audio"):
            mx_audio = result.output.audio
            # mx.array -> numpy; reshape to 1-D to handle 2-D (1, N) from kokoro
            np_audio = np.array(mx_audio).reshape(-1)
            audio_chunks.append(np_audio)
    if not audio_chunks:
        raise RuntimeError("kokoro pipeline produced no audio")
    full_audio = np.concatenate(audio_chunks) if len(audio_chunks) > 1 else audio_chunks[0]
    return _array_to_pcm(full_audio, TTS_SAMPLE_RATE_HZ)


def _array_to_pcm(audio_array, sample_rate):
    import numpy as np

    if isinstance(audio_array, list):
        audio_array = np.array(audio_array, dtype=np.float32)
    if sample_rate != TTS_SAMPLE_RATE_HZ:
        audio_array = _resample_linear(audio_array, sample_rate, TTS_SAMPLE_RATE_HZ)
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
    lower = np.floor(src_idx).astype(int)
    upper = np.minimum(lower + 1, len(audio_array) - 1)
    frac = src_idx - lower
    return audio_array[lower] * (1 - frac) + audio_array[upper] * frac


def _generate_stub_pcm(text, voice=""):
    import numpy as np
    voice_hash = sum(ord(c) for c in (voice or DEFAULT_VOICE)) % 100
    freq_hz = 220 + voice_hash
    word_count = max(1, len(text.split()))
    duration_s = max(0.5, min(10.0, word_count * 0.35))
    char_based = len(text.strip()) * 0.05
    duration_s = max(duration_s, min(10.0, char_based))
    num_samples = int(TTS_SAMPLE_RATE_HZ * duration_s)
    t = np.arange(num_samples) / TTS_SAMPLE_RATE_HZ
    envelope = np.ones(num_samples, dtype=np.float32)
    fade_samples = int(0.01 * TTS_SAMPLE_RATE_HZ)
    if fade_samples > 0 and num_samples > 2 * fade_samples:
        fade_in = np.linspace(0, 1, fade_samples, dtype=np.float32)
        fade_out = np.linspace(1, 0, fade_samples, dtype=np.float32)
        envelope[:fade_samples] = fade_in
        envelope[-fade_samples:] = fade_out
    audio = 0.3 * np.sin(2 * np.pi * freq_hz * t) * envelope
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    return pcm


def _synthesize(text, voice):
    backend, _ = get_backend()
    if backend == "kokoro-mlx":
        return _synthesize_with_kokoro(text, voice)
    return _generate_stub_pcm(text, voice)


def _pcm_to_wav(pcm_bytes):
    import io
    import wave

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
        text = request.form.get("input") or request.form.get("text")
        voice = request.form.get("voice") or voice
        response_format = (request.form.get("response_format") or response_format).lower()
        model = request.form.get("model")

    if not text or not str(text).strip():
        return jsonify({"error": "no input text provided (expected 'input')"}), 400

    text = str(text).strip()
    if len(text) > MAX_INPUT_CHARS:
        return jsonify({"error": f"input too long ({len(text)} > {MAX_INPUT_CHARS} chars)"}), 413

    # Only pcm and wav are supported; reject mp3/opus/aac explicitly per review
    if response_format not in ("pcm", "wav", "wave", "raw", "s16le", "l16"):
        if response_format in ("mp3", "opus", "aac", "flac"):
            return jsonify({"error": f"response_format '{response_format}' not supported; use 'pcm' or 'wav'"}), 400
        # Unknown formats also 400
        return jsonify({"error": f"unsupported response_format '{response_format}'"}), 400

    want_wav = response_format in ("wav", "wave")

    try:
        pcm_bytes = _synthesize(text, voice)
    except Exception as exc:
        # Never substitute stub on failure for real backend — return 502 so Apollo surfaces it and does not cache
        backend, _ = get_backend()
        print(f"synthesis failed (backend={backend}, voice={voice}): {exc}")
        return jsonify({"error": f"synthesis failed: {exc}", "engine": backend}), 502

    latency_ms = int((time.time() - started) * 1000)
    backend, _ = get_backend()

    if want_wav:
        wav_bytes = _pcm_to_wav(pcm_bytes)
        resp = Response(wav_bytes, status=200, mimetype="audio/wav")
        resp.headers["X-Latency-Ms"] = str(latency_ms)
        resp.headers["X-Engine"] = backend
        resp.headers["X-Voice"] = voice
        return resp

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
    if _backend is None:
        try:
            backend = _select_backend()
        except Exception:
            backend = "stub"
    # Health reflects whether model actually loaded
    status = "ok" if (_backend != "kokoro-mlx" or _model_loaded) else "degraded"
    http_status = 200 if status == "ok" else 503
    return jsonify(
        {
            "status": status,
            "service": "local-tts",
            "backend": backend,
            "engine": backend,
            "voice": DEFAULT_VOICE,
            "sample_rate": TTS_SAMPLE_RATE_HZ,
            "channels": TTS_CHANNEL_COUNT,
            "model_loaded": _model_loaded,
            "model": KOKORO_MODEL_REPO,
            **({"error": _model_error} if _model_error else {}),
        }
    ), http_status


@app.route("/v1/audio/voices", methods=["GET"])
def voices():
    kokoro_voices = sorted(VALID_KOKORO_VOICES)
    return jsonify({"voices": kokoro_voices, "default": DEFAULT_VOICE})


if __name__ == "__main__":
    port = int(os.environ.get("TTS_PORT", "8788"))
    get_backend()
    print(f"Starting TTS server on port {port} (backend={_backend}, voice={DEFAULT_VOICE}, {TTS_SAMPLE_RATE_HZ}Hz PCM, model_loaded={_model_loaded})...")
    app.run(host="0.0.0.0", port=port)
