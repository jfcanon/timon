# Local TTS server

OpenAI-compatible `POST /v1/audio/speech` -> 24 kHz mono s16le raw PCM (what Apollo's `tts_start pcm` expects).

```bash
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements-tts.txt
.venv/bin/python scripts/tts_server.py                  # auto: kokoro-mlx on Apple silicon, else piper, else stub
TTS_BACKEND=piper .venv/bin/python scripts/tts_server.py
TTS_BACKEND=stub TTS_PORT=8788 .venv/bin/python scripts/tts_server.py
```

Spike (M-series, 12-word sentence ≈ 18 tokens, warm model):
- **kokoro-mlx (Kokoro-82M via mlx-audio)**: ~300-400 ms inference, ~2.2 s cold warm-up (MLX graph compile), RTF ~0.1, MOS ~4.2, 24 kHz native — **chosen** (quality + Spanish voice, stays within 1.5 s after jarvis.sh warms it)
- **piper (sherpa-onnx)**: ~40-150 ms, RTF ~0.03, MOS 4.2-4.3, 22.05 kHz -> resampled to 24 kHz — fallback when kokoro not importable
- **OmniVoice/XTTS**: MPS broken (corrupt audio), CPU ~10 s per second of audio — rejected
- **stub**: sine-wave, ~1 ms, for CI

Measured on this repo's Mac: re-run `curl -w "%{time_starttransfer}"` against `/v1/audio/speech` after `get_backend()` warm-up; record in PR.

```
curl -X POST http://localhost:8788/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"kokoro","input":"Hola, esto es una prueba de doce palabras para medir latencia.","voice":"af_heart","response_format":"pcm"}' \
  --output /tmp/out.pcm -D - -s -o /dev/null | grep -i latency

curl -s http://localhost:8788/healthz | jq .
# {"status":"ok","service":"local-tts","backend":"kokoro-mlx","engine":"kokoro-mlx","voice":"af_heart","sample_rate":24000,"channels":1}
```

Every response carries `X-Latency-Ms` and `X-Engine`; `/healthz` reports active backend + voice.
