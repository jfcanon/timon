#!/usr/bin/env python3
"""Local Whisper STT server — OpenAI-compatible /v1/audio/transcriptions endpoint.

Backend selection (WHISPER_BACKEND, default "auto"):
  mlx    — mlx-whisper on Apple silicon GPU (~0.4 s for a 3 s clip, measured)
  faster — faster-whisper on CPU int8      (~9 s for the same clip, measured)
  auto   — mlx when importable, else faster
"""

import os
import tempfile
import time

from flask import Flask, jsonify, request

app = Flask(__name__)

MLX_MODEL_REPO = os.environ.get("WHISPER_MLX_REPO", "mlx-community/whisper-large-v3-turbo")
FASTER_MODEL_SIZE = os.environ.get("WHISPER_MODEL", "large-v3-turbo")

_backend = None
_model = None


def _select_backend():
    wanted = os.environ.get("WHISPER_BACKEND", "auto")
    if wanted in ("mlx", "auto"):
        try:
            import mlx_whisper  # noqa: F401
            return "mlx"
        except ImportError:
            if wanted == "mlx":
                raise
    return "faster"


def get_backend():
    global _backend, _model
    if _backend is None:
        _backend = _select_backend()
        if _backend == "mlx":
            import mlx_whisper
            print(f"Whisper backend: mlx ({MLX_MODEL_REPO}) — warming up...")
            _model = mlx_whisper
            # First call downloads + loads the weights; do it before serving.
            _model.transcribe(_silence_wav(), path_or_hf_repo=MLX_MODEL_REPO)
        else:
            from faster_whisper import WhisperModel
            print(f"Whisper backend: faster-whisper cpu/int8 ({FASTER_MODEL_SIZE})...")
            _model = WhisperModel(FASTER_MODEL_SIZE, device="cpu", compute_type="int8")
        print("Model loaded.")
    return _backend, _model


def _silence_wav():
    import struct
    import wave
    path = os.path.join(tempfile.gettempdir(), "whisper_warmup.wav")
    if not os.path.exists(path):
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(struct.pack("<h", 0) * 16000)
    return path


def _transcribe(path, language):
    backend, model = get_backend()
    if backend == "mlx":
        kwargs = {"path_or_hf_repo": MLX_MODEL_REPO}
        if language:
            kwargs["language"] = language
        result = model.transcribe(path, **kwargs)
        segments = result.get("segments") or []
        duration = segments[-1]["end"] if segments else None
        return result.get("text", "").strip(), duration, result.get("language")
    kwargs = {"beam_size": 5}
    if language:
        kwargs["language"] = language
    segments, info = model.transcribe(path, **kwargs)
    text = " ".join(seg.text.strip() for seg in segments)
    return text, info.duration, info.language


@app.route("/v1/audio/transcriptions", methods=["POST"])
def transcribe():
    if "file" not in request.files:
        return jsonify({"error": "no file provided"}), 400

    audio_file = request.files["file"]
    language = request.form.get("language") or None
    suffix = os.path.splitext(audio_file.filename or "audio.wav")[1] or ".wav"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        started = time.time()
        text, duration, detected_language = _transcribe(tmp_path, language)
        return jsonify({
            "text": text,
            "duration": duration,
            "language": detected_language,
            "backend": _backend,
            "latency_ms": int((time.time() - started) * 1000),
        })
    finally:
        os.unlink(tmp_path)


@app.route("/healthz", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "local-whisper", "backend": _backend})


if __name__ == "__main__":
    port = int(os.environ.get("WHISPER_PORT", "8787"))
    get_backend()
    print(f"Starting Whisper server on port {port}...")
    app.run(host="0.0.0.0", port=port)
