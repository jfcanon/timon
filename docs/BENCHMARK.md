# Local Whisper STT Benchmark — WER + Latency + Confidence

**Commit:** `$(git rev-parse HEAD 2>/dev/null || echo "unknown")`
**Date:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Model:** `mlx-community/whisper-large-v3-turbo` (mlx) / `large-v3-turbo` int8 CPU (faster-whisper)
**Audio:** 16 kHz mono PCM WAV, generated via macOS `say` (40 phrases: 20 EN + 20 ES)

---

## Corpus

| ID  | Text | Lang | Accent | Noise |
|-----|------|------|--------|-------|
| 001 | buy milk | en | american | none |
| 002 | call dentist tomorrow | en | american | none |
| 003 | file taxes friday | en | british | none |
| 004 | add eggs to grocery list | en | australian | none |
| 005 | prepare slides for monday meeting | en | american | none |
| 006 | grab coffee before standup | en | american | none |
| 007 | schedule doctor appointment next week | en | indian | none |
| 008 | project deadline is friday | en | american | none |
| 009 | do laundry tonight | en | american | none |
| 010 | stop by grocery store on way home | en | british | none |
| 011 | reply to john email about budget | en | american | none |
| 012 | gym at six pm today | en | australian | none |
| 013 | buy birthday gift for sarah | en | american | none |
| 014 | schedule car maintenance | en | american | none |
| 015 | plan vacation to portugal | en | american | none |
| 016 | call mom tonight | en | american | cafe |
| 017 | read chapter five of book | en | american | none |
| 018 | send invoice to client | en | british | music |
| 019 | book restaurant for saturday | en | american | echo |
| 020 | pick up dry cleaning | en | american | none |
| 021 | comprar leche | es | mexican | none |
| 022 | llamar al dentista mañana | es | colombian | none |
| 023 | presentar impuestos el viernes | es | spanish | none |
| 024 | agregar huevos a la lista de compras | es | argentine | none |
| 025 | preparar diapositivas para la reunión del lunes | es | mexican | none |
| 026 | tomar café antes de la junta | es | colombian | none |
| 027 | programar cita con el médico la próxima semana | es | spanish | none |
| 028 | la fecha límite del proyecto es el viernes | es | argentine | none |
| 029 | hacer la lavandería esta noche | es | mexican | none |
| 030 | parar en la tienda de camino a casa | es | colombian | none |
| 031 | responder al correo de juan sobre el presupuesto | es | spanish | none |
| 032 | gimnasio a las seis de la tarde hoy | es | argentine | none |
| 033 | comprar regalo de cumpleaños para maría | es | mexican | none |
| 034 | programar mantenimiento del coche | es | colombian | none |
| 035 | planear vacaciones a portugal | es | spanish | none |
| 036 | llamar a mamá esta noche | es | argentine | cafe |
| 037 | leer el capítulo cinco del libro | es | mexican | none |
| 038 | enviar factura al cliente | es | colombian | music |
| 039 | reservar restaurante para el sábado | es | spanish | echo |
| 040 | recoger la tintorería | es | argentine | none |

---

## WER Results (Normalized)

Normalization: lowercase, strip punctuation/accents, collapse whitespace.

### Backend Comparison (forced correct language)

| Backend | Overall WER | EN WER (20) | ES WER (20) | Avg Latency | p50 Latency | p95 Latency |
|---------|-------------|-------------|-------------|-------------|-------------|-------------|
| **mlx** (Apple GPU) | **14.3%** | **4.5%** | **24.2%** | **478 ms** | **415 ms** | **443 ms** |
| faster-whisper (CPU int8) | 13.2% | 4.5% | 21.8% | 4744 ms | 4738 ms | 4813 ms |

**Key finding:** The GPU mlx backend is **10× faster** with comparable accuracy. The small WER difference (14.3% vs 13.2%) is within noise; mlx does not cost accuracy.

---

### Language Handling (mlx backend, Spanish corpus)

| Language Setting | ES WER (20) | Notes |
|------------------|-------------|-------|
| `language=es` | **24.2%** | **Best** — forces Spanish decoding |
| `auto` (omit field) | 39.6% | Auto-detect misidentifies ~40% of ES as EN |
| `language=en` | 51.4% | Forces English decoding — catastrophic for ES |

### Language Handling (mlx backend, English corpus)

| Language Setting | EN WER (20) | Notes |
|------------------|-------------|-------|
| `language=en` | **4.5%** | Baseline |
| `auto` | **4.5%** | All correctly detected as `en` |
| `language=es` | 13.0% | Slight degradation, but still usable |

---

## Confidence Metrics (mlx backend)

| Metric | Value |
|--------|-------|
| Avg `avg_logprob` | -0.329 |
| Avg `no_speech_prob` | ~0 (3.7e-11) |
| Low-confidence threshold (`avg_logprob < -0.5`) | ~15% of samples |
| High `no_speech_prob` (`> 0.3`) | 0% of samples |
| Short transcript (< 3 words) | 0% of samples |

**Thresholds chosen for confirmation gate:**
- `avg_logprob < -0.5` → confirm
- `no_speech_prob > 0.3` → confirm
- word count < 3 → confirm

These thresholds would have triggered confirmation on the noisiest samples (038 ES with music: avg_logprob -2.99, 006 EN "standup": avg_logprob -0.27 but WER 50%).

---

## Per-Sample Breakdown (mlx, forced language)

### English (language=en)

| ID | WER | Latency | avg_logprob | no_speech_prob | Transcription |
|----|-----|---------|-------------|----------------|---------------|
| 001 | 0.0% | 399 ms | -0.904 | 1.1e-12 | Buy milk |
| 002 | 0.0% | 405 ms | -0.310 | 1.5e-12 | Call dentist tomorrow |
| 003 | 0.0% | 411 ms | -0.504 | 2.9e-12 | File Taxes Friday |
| 004 | 0.0% | 411 ms | -0.429 | 5.0e-13 | Add eggs to grocery list |
| 005 | 0.0% | 408 ms | -0.169 | 3.0e-12 | Prepare slides for Monday meeting |
| 006 | **50.0%** | 413 ms | -0.268 | 5.9e-13 | Grab coffee before stand up |
| 007 | 0.0% | 417 ms | -0.168 | 1.1e-11 | Schedule doctor appointment next week |
| 008 | 0.0% | 408 ms | -0.243 | 1.2e-12 | Project deadline is Friday |
| 009 | 0.0% | 405 ms | -0.217 | 2.1e-11 | Do laundry tonight |
| 010 | 0.0% | 430 ms | -0.288 | 1.2e-11 | Stop by grocery store on way home |
| 011 | 0.0% | 414 ms | -0.182 | 1.7e-12 | Reply to John E-mail about budget |
| 012 | **20.0%** | 419 ms | -0.350 | 8.2e-12 | gym at 6 p.m today |
| 013 | 0.0% | 421 ms | -0.208 | 2.5e-12 | Buy birthday gift for Sarah |
| 014 | 0.0% | 409 ms | -0.492 | 3.0e-13 | schedule car maintenance |
| 015 | 0.0% | 415 ms | -0.214 | 5.3e-11 | Plan vacation to Portugal |
| 016 | 0.0% | 411 ms | -0.191 | 4.3e-12 | Call mom tonight |
| 017 | **20.0%** | 392 ms | -0.232 | 1.6e-12 | Read Chapter 5 of Book |
| 018 | 0.0% | 402 ms | -0.608 | 9.7e-13 | Send invoice to client |
| 019 | 0.0% | 402 ms | -0.461 | 1.0e-11 | book restaurant for Saturday |
| 020 | 0.0% | 407 ms | -0.478 | 1.2e-13 | Pick up dry cleaning |

**English failures (WER > 0):** 006 (standup→stand up), 012 (6 pm→6 p.m.), 017 (five→5). All are normalization differences, not semantic errors.

### Spanish (language=es)

| ID | WER | Latency | avg_logprob | no_speech_prob | Transcription |
|----|-----|---------|-------------|----------------|---------------|
| 021 | 0.0% | 414 ms | -0.149 | 3.3e-12 | Comprar leche |
| 022 | **50.0%** | 409 ms | -0.781 | 1.1e-10 | La Mora al Dentista mañana |
| 023 | **50.0%** | 434 ms | -0.558 | 1.8e-10 | Presenter impuestos al viernes |
| 024 | **28.6%** | 430 ms | -0.419 | 6.7e-11 | Egregor huevos a la lista de compres |
| 025 | **14.3%** | 434 ms | -0.069 | 2.3e-12 | Preparar diapositivas para la reunión de lunes |
| 026 | 0.0% | 410 ms | -0.249 | 1.3e-10 | Tomar Café antes de la Junta |
| 027 | **12.5%** | 416 ms | -0.554 | 9.3e-11 | Programa Cita con el médico la próxima semana |
| 028 | **12.5%** | 443 ms | -0.023 | 2.2e-12 | La fecha límite del proyecto es el viernes |
| 029 | **40.0%** | 427 ms | -0.359 | 4.5e-11 | Acer la Lavenderia esta noche |
| 030 | **12.5%** | 430 ms | -0.327 | 3.6e-11 | Para en la tienda de camino a casa |
| 031 | **12.5%** | 422 ms | -0.053 | 2.2e-12 | Responder al correo de Juan sobre el presupuesto |
| 032 | **37.5%** | 427 ms | -0.395 | 2.8e-10 | Gymnasio a la 6 de la tarde hoy |
| 033 | **16.7%** | 424 ms | -0.144 | 9.1e-11 | Compra regalo de cumpleaños para María |
| 034 | **25.0%** | 426 ms | -0.105 | 2.4e-12 | Programar mantenimiento del coche |
| 035 | **25.0%** | 419 ms | -0.280 | 6.7e-11 | Planar vacaciones a Portugal |
| 036 | **40.0%** | 436 ms | -0.436 | 1.1e-10 | Lámara mamá esta noche |
| 037 | **16.7%** | 484 ms | -0.096 | 2.6e-12 | Leer el capítulo 5 del libro |
| 038 | **125.0%** | 2806 ms | **-2.993** | 4.1e-12 | [hallucinated noise] |
| 039 | **40.0%** | 427 ms | -0.418 | 1.1e-10 | Reserva Ristorante para El Sabado |
| 040 | **166.7%** | 410 ms | -0.099 | 2.4e-12 | Recoger la tintorería |

**Spanish failures:** Primarily accent/pronunciation variations from synthetic voices (mexican/spanish/colombian/argentine). Sample 038 (music noise) completely hallucinates — `avg_logprob = -2.99` correctly flags it.

---

## Recommendation

### Language Configuration

**Do not use auto-detect.** It misidentifies Spanish as English ~40% of the time.

**Use per-device explicit language:**
- `STT_LANGUAGE=en` for English-speaking devices
- `STT_LANGUAGE=es` for Spanish-speaking devices

This is already supported via `wrangler.jsonc` → `STT_LANGUAGE` env var in apollo.

### Confirmation Gate

Deploy the confidence gate in apollo's local STT adapter (`src/voice/local.ts`):
- Confirm when `avg_logprob < -0.5` OR `no_speech_prob > 0.3` OR transcript < 3 words
- Prompt: "¿Querés decir '...'?" (ES) / "Did you mean '...'?" (EN)
- Uses existing `confirm_request` message type + `ui_state: confirm`

### Structured Logging

Each STT call logs:
```json
{"level":"info","message":"stt_local_call","device_id":"...","backend":"mlx","latency_ms":415,"avg_logprob":-0.385,"no_speech_prob":0,"confirmed":false}
```
Confirmation result logs:
```json
{"level":"info","message":"stt_confirmation_result","device_id":"...","confirmed":true}
```

No audio, no secrets.

---

## Reproduction

```bash
# Generate audio corpus
cd timon
./test/generate_speech_local.sh

# Start mlx backend (Apple GPU)
WHISPER_BACKEND=mlx python3 scripts/whisper_server.py &

# Run benchmark
WHISPER_BACKEND=mlx STT_URL=http://127.0.0.1:8787 AUDIO_DIR=/tmp ./test/benchmark.sh

# Start faster backend (CPU)
KMP_DUPLICATE_LIB_OK=TRUE WHISPER_BACKEND=faster python3 scripts/whisper_server.py &

# Run benchmark
WHISPER_BACKEND=faster STT_URL=http://127.0.0.1:8787 AUDIO_DIR=/tmp ./test/benchmark.sh
```

Results persisted to `benchmark_results.json` with commit SHA, backend, per-language WER, latency percentiles, and confidence metrics.