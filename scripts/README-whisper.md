# Local Whisper STT server

```bash
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements-whisper.txt
.venv/bin/python scripts/whisper_server.py          # auto: mlx on Apple silicon
WHISPER_BACKEND=faster .venv/bin/python scripts/whisper_server.py   # force CPU backend
```

Measured on the M-series Mac (3 s clip, large-v3-turbo): mlx ≈ 0.4 s, faster-whisper cpu/int8 ≈ 9 s.
`GET /healthz` reports the active backend; every transcription response carries `latency_ms`.
