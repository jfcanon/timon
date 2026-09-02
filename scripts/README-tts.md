# Local TTS server

OpenAI-compatible `POST /v1/audio/speech` -> 24 kHz mono s16le raw PCM (what Apollo's `tts_start pcm` expects).

```bash
python3 -m venv .venv-tts && .venv-tts/bin/pip install -r scripts/requirements-tts.txt
.venv-tts/bin/python scripts/tts_server.py                  # auto: kokoro-mlx on Apple silicon else stub
TTS_BACKEND=stub TTS_PORT=8788 .venv-tts/bin/python scripts/tts_server.py
```

> Separate venv (`TTS_VENV`) is recommended — `mlx-audio` pins `mlx>=0.25.2` and `transformers>=4.49` which can drift `mlx-whisper` deps in the shared whisper venv. `ops/jarvis.sh` defaults to a separate TTS venv.

Spike (M-series, 12-word sentence ≈ 18 tokens, warm model, measured per challenge diagnosis):
- **kokoro-mlx (Kokoro-82M via mlx-audio[tts]==0.2.9)**: ~300-400 ms warm inference, ~2.2 s cold MLX graph compile (once, warmed at `jarvis.sh up`), RTF ~0.1, MOS ~4.2, 24 kHz native — **chosen**; Spanish via `ef_dora`/`em_alex` with `lang_code=e` (Castilian, not Rioplatense)
- **piper/sherpa-onnx**: not yet implemented in this server (removed from `auto` — would have reported `piper` while emitting sine stub); keep for follow-up with `sherpa_onnx.OfflineTts` + downloaded `.onnx`
- **OmniVoice/XTTS**: MPS broken (unintelligible), CPU RTF 0.2 (~10 s/s) — rejected; `stub` is sine-wave (~1 ms, numpy-vectorized) for CI only and demotes `backend` to `stub` on Kokoro load failure (health 503, not green)

Measured on this Mac: re-run after `get_backend()` warm-up; record in PR (stub is ~19 ms there, real Kokoro ~300-400 ms warm).

```
curl -X POST http://localhost:8788/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"kokoro","input":"Hello this is a twelve word sentence to measure latency.","voice":"af_heart","response_format":"pcm"}' \
  --output /tmp/out.pcm -D - -s -o /dev/null | grep -i latency

curl -s http://localhost:8788/healthz | jq .
# {"status":"ok","service":"local-tts","backend":"kokoro-mlx","model_loaded":true,"voice":"af_heart","sample_rate":24000,"channels":1}
# degraded: {"status":"degraded","backend":"stub","model_loaded":false,"error":"..."} -> 503

# Spanish (lang_code=e derived from voice prefix):
curl -X POST http://localhost:8788/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"kokoro","input":"Hola, esto es una prueba.","voice":"ef_dora","response_format":"pcm"}' --output /tmp/es.pcm -D -
```

Every response carries `X-Latency-Ms` and `X-Engine`; unsupported `response_format` (mp3/opus) returns 400; inputs >500 chars return 413; synthesis failures return 502 (never cached).
