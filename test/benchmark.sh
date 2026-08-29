#!/bin/bash
# Timon WER Benchmark — Word Error Rate against local Whisper server
#
# Results are persisted to benchmark_results.json (overwritten each run).
#
# Audio: expects pre-generated files at $AUDIO_DIR/timon_test_<ID>.wav
#   (one file per corpus entry). Generate them with:
#   test/generate_speech_local.sh  (macOS `say`, no API key needed)
#
# Env:
#   STT_URL          Local Whisper server (default http://127.0.0.1:8787)
#   AUDIO_DIR        Where to find .wav files (default /tmp)
#   WHISPER_BACKEND  For labelling only: mlx | faster | auto

set -e

STT_URL="${STT_URL:-http://127.0.0.1:8787}"
AUDIO_DIR="${AUDIO_DIR:-/tmp}"
CORPUS_FILE="test/corpus.json"
RESULTS_FILE="benchmark_results.json"
WHISPER_BACKEND="${WHISPER_BACKEND:-auto}"

# Compute Word Error Rate (WER) using Python for Levenshtein distance
# Normalizes: lowercase, strip punctuation, remove accents, collapse whitespace
wer_python() {
  python3 -c '
import sys, json, re, unicodedata

def normalize(s):
    s = s.lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

ref = normalize(sys.argv[1])
hyp = normalize(sys.argv[2])

ref_words = ref.split()
hyp_words = hyp.split()

if not ref_words:
    print("1.0" if hyp_words else "0.0")
    sys.exit(0)

# Levenshtein distance at word level
m, n = len(ref_words), len(hyp_words)
dp = [[0] * (n + 1) for _ in range(m + 1)]
for i in range(m + 1):
    dp[i][0] = i
for j in range(n + 1):
    dp[0][j] = j

for i in range(1, m + 1):
    for j in range(1, n + 1):
        cost = 0 if ref_words[i - 1] == hyp_words[j - 1] else 1
        dp[i][j] = min(
            dp[i - 1][j] + 1,      # deletion
            dp[i][j - 1] + 1,      # insertion
            dp[i - 1][j - 1] + cost  # substitution
        )

wer = dp[m][n] / m
print(f"{wer:.4f}")
' "$1" "$2"
}

# Percentile helper
percentile() {
  local p="$1"; shift
  local arr=($(printf '%s\n' "$@" | sort -n))
  local n=${#arr[@]}
  if [ $n -eq 0 ]; then echo "0"; return; fi
  local idx=$(echo "($p / 100) * ($n - 1) + 1" | bc -l)
  local idx_int=$(printf "%.0f" "$idx")
  if [ $idx_int -lt 1 ]; then idx_int=1; fi
  if [ $idx_int -gt $n ]; then idx_int=$n; fi
  echo "${arr[$((idx_int - 1))]}"
}

echo "=== Timon WER Benchmark ==="
echo "STT URL: $STT_URL"
echo "Audio dir: $AUDIO_DIR"
echo "Whisper backend (for labelling): $WHISPER_BACKEND"
echo ""

if [ ! -f "$CORPUS_FILE" ]; then
  echo "Error: Corpus file not found at $CORPUS_FILE"
  exit 1
fi

# Test healthz
echo "Testing /healthz..."
HEALTHZ=$(curl -s -m 10 "$STT_URL/healthz" || echo "FAILED")
echo "Response: $HEALTHZ"
echo ""

TOTAL=0
WER_SUM=0
LATENCY_LIST=()
AVG_LOGPROB_LIST=()
NO_SPEECH_PROB_LIST=()
RESULTS_TMP="$(mktemp)"
EN_WER_SUM=0
EN_COUNT=0
ES_WER_SUM=0
ES_COUNT=0

TOTAL_ENTRIES=$(jq 'length' "$CORPUS_FILE")

for i in $(seq 0 $((TOTAL_ENTRIES - 1))); do
  ENTRY=$(jq -r ".[$i]" "$CORPUS_FILE")
  ID=$(echo "$ENTRY" | jq -r '.id')
  TEXT=$(echo "$ENTRY" | jq -r '.text')
  EXPECTED=$(echo "$ENTRY" | jq -r '.expected')
  LANG=$(echo "$ENTRY" | jq -r '.language')
  ACCENT=$(echo "$ENTRY" | jq -r '.accent')
  NOISE=$(echo "$ENTRY" | jq -r '.noise')

  echo -n "Test $ID [$LANG] ($ACCENT/$NOISE): \"$TEXT\"... "

  AUDIO_FILE="$AUDIO_DIR/timon_test_$ID.wav"

  if [ ! -f "$AUDIO_FILE" ]; then
    echo "SKIP (no audio file)"
    echo "{\"id\":\"$ID\",\"lang\":\"$LANG\",\"accent\":\"$ACCENT\",\"noise\":\"$NOISE\",\"text\":$(jq -Rn --arg s "$TEXT" '$s'),\"expected\":$(jq -Rn --arg s "$EXPECTED" '$s'),\"transcription\":null,\"latency_ms\":null,\"wer\":null,\"avg_logprob\":null,\"no_speech_prob\":null,\"backend\":null,\"status\":\"SKIP\"}" >> "$RESULTS_TMP"
    continue
  fi

  START_TIME=$(date +%s%N)
  RESULT=$(curl -s -m 60 -X POST "$STT_URL/v1/audio/transcriptions" \
    -F "file=@$AUDIO_FILE" \
    -F "language=$LANG" 2>/dev/null || echo '{"error":"curl_failed"}')
  END_TIME=$(date +%s%N)

  LATENCY_MS=$(( (END_TIME - START_TIME) / 1000000 ))
  LATENCY_LIST+=("$LATENCY_MS")

  ERROR=$(echo "$RESULT" | jq -r '.error // empty' 2>/dev/null)
  TRANSCRIPTION=$(echo "$RESULT" | jq -r '.text // empty' 2>/dev/null)
  BACKEND=$(echo "$RESULT" | jq -r '.backend // empty' 2>/dev/null)
  AVG_LOGPROB=$(echo "$RESULT" | jq -r '.avg_logprob // empty' 2>/dev/null)
  NO_SPEECH_PROB=$(echo "$RESULT" | jq -r '.no_speech_prob // empty' 2>/dev/null)
  DETECTED_LANG=$(echo "$RESULT" | jq -r '.language // empty' 2>/dev/null)

  if [ -n "$ERROR" ] && [ "$ERROR" != "null" ] && [ "$ERROR" != "" ]; then
    echo "ERROR: $ERROR"
    echo "{\"id\":\"$ID\",\"lang\":\"$LANG\",\"accent\":\"$ACCENT\",\"noise\":\"$NOISE\",\"text\":$(jq -Rn --arg s "$TEXT" '$s'),\"expected\":$(jq -Rn --arg s "$EXPECTED" '$s'),\"transcription\":null,\"latency_ms\":$LATENCY_MS,\"wer\":null,\"avg_logprob\":null,\"no_speech_prob\":null,\"backend\":\"$BACKEND\",\"status\":\"ERROR\",\"error\":$(jq -Rn --arg s "$ERROR" '$s')}" >> "$RESULTS_TMP"
    continue
  fi

  if [ -z "$TRANSCRIPTION" ] || [ "$TRANSCRIPTION" = "null" ] || [ "$TRANSCRIPTION" = "" ]; then
    echo "EMPTY transcription"
    WER=1.0
    echo "{\"id\":\"$ID\",\"lang\":\"$LANG\",\"accent\":\"$ACCENT\",\"noise\":\"$NOISE\",\"text\":$(jq -Rn --arg s "$TEXT" '$s'),\"expected\":$(jq -Rn --arg s "$EXPECTED" '$s'),\"transcription\":\"\",\"latency_ms\":$LATENCY_MS,\"wer\":$WER,\"avg_logprob\":${AVG_LOGPROB:-null},\"no_speech_prob\":${NO_SPEECH_PROB:-null},\"backend\":\"$BACKEND\",\"status\":\"EMPTY\"}" >> "$RESULTS_TMP"
  else
    WER=$(wer_python "$EXPECTED" "$TRANSCRIPTION")
    WER_SUM=$(echo "$WER_SUM + $WER" | bc -l)
    LATENCY_LIST+=("$LATENCY_MS")
    [ -n "$AVG_LOGPROB" ] && [ "$AVG_LOGPROB" != "null" ] && AVG_LOGPROB_LIST+=("$AVG_LOGPROB")
    [ -n "$NO_SPEECH_PROB" ] && [ "$NO_SPEECH_PROB" != "null" ] && NO_SPEECH_PROB_LIST+=("$NO_SPEECH_PROB")

    if [ "$LANG" = "en" ]; then
      EN_WER_SUM=$(echo "$EN_WER_SUM + $WER" | bc -l)
      EN_COUNT=$((EN_COUNT + 1))
    else
      ES_WER_SUM=$(echo "$ES_WER_SUM + $WER" | bc -l)
      ES_COUNT=$((ES_COUNT + 1))
    fi

    WER_PCT=$(echo "$WER * 100" | bc -l | xargs printf "%.1f")
    echo "WER=${WER_PCT}% (latency=${LATENCY_MS}ms backend=$BACKEND avg_logprob=${AVG_LOGPROB:-N/A} no_speech_prob=${NO_SPEECH_PROB:-N/A})"
    echo "{\"id\":\"$ID\",\"lang\":\"$LANG\",\"accent\":\"$ACCENT\",\"noise\":\"$NOISE\",\"text\":$(jq -Rn --arg s "$TEXT" '$s'),\"expected\":$(jq -Rn --arg s "$EXPECTED" '$s'),\"transcription\":$(jq -Rn --arg s "$TRANSCRIPTION" '$s'),\"latency_ms\":$LATENCY_MS,\"wer\":$WER,\"avg_logprob\":${AVG_LOGPROB:-null},\"no_speech_prob\":${NO_SPEECH_PROB:-null},\"backend\":\"$BACKEND\",\"detected_language\":\"$DETECTED_LANG\",\"status\":\"OK\"}" >> "$RESULTS_TMP"
  fi

  TOTAL=$((TOTAL + 1))
  [ "$i" -lt $((TOTAL_ENTRIES - 1)) ] && sleep 0.5
done

echo ""
echo "=== Summary ==="
echo "Total tests: $TOTAL"

if [ $TOTAL -gt 0 ]; then
  AVG_WER=$(echo "scale=4; $WER_SUM / $TOTAL" | bc -l)
  AVG_WER_PCT=$(echo "$AVG_WER * 100" | bc -l | xargs printf "%.1f")
  echo "Overall WER: ${AVG_WER_PCT}%"

  if [ $EN_COUNT -gt 0 ]; then
    EN_AVG_WER=$(echo "scale=4; $EN_WER_SUM / $EN_COUNT" | bc -l)
    EN_AVG_WER_PCT=$(echo "$EN_AVG_WER * 100" | bc -l | xargs printf "%.1f")
    echo "English WER: ${EN_AVG_WER_PCT}% ($EN_COUNT samples)"
  fi
  if [ $ES_COUNT -gt 0 ]; then
    ES_AVG_WER=$(echo "scale=4; $ES_WER_SUM / $ES_COUNT" | bc -l)
    ES_AVG_WER_PCT=$(echo "$ES_AVG_WER * 100" | bc -l | xargs printf "%.1f")
    echo "Spanish WER: ${ES_AVG_WER_PCT}% ($ES_COUNT samples)"
  fi

  # Latency percentiles
  if [ ${#LATENCY_LIST[@]} -gt 0 ]; then
    P50=$(percentile 50 "${LATENCY_LIST[@]}")
    P95=$(percentile 95 "${LATENCY_LIST[@]}")
    AVG_LATENCY=$(printf '%s\n' "${LATENCY_LIST[@]}" | awk '{sum+=$1} END {if (NR>0) print sum/NR; else print 0}')
    echo "Latency: avg=${AVG_LATENCY%.*}ms p50=${P50}ms p95=${P95}ms"
  fi

  # Confidence stats
  if [ ${#AVG_LOGPROB_LIST[@]} -gt 0 ]; then
    AVG_AVG_LOGPROB=$(printf '%s\n' "${AVG_LOGPROB_LIST[@]}" | awk '{sum+=$1} END {if (NR>0) print sum/NR; else print 0}')
    echo "Avg avg_logprob: ${AVG_AVG_LOGPROB}"
  fi
  if [ ${#NO_SPEECH_PROB_LIST[@]} -gt 0 ]; then
    AVG_NO_SPEECH_PROB=$(printf '%s\n' "${NO_SPEECH_PROB_LIST[@]}" | awk '{sum+=$1} END {if (NR>0) print sum/NR; else print 0}')
    echo "Avg no_speech_prob: ${AVG_NO_SPEECH_PROB}"
  fi
fi
echo ""

# Persist results
SUMMARY_JSON=$(jq -n \
  --argjson total "$TOTAL" \
  --argjson en_count "$EN_COUNT" \
  --argjson es_count "$ES_COUNT" \
  --argjson avg_wer "$(echo "scale=4; if ($TOTAL>0) $WER_SUM/$TOTAL else 0" | bc -l)" \
  --argjson en_avg_wer "$(echo "scale=4; if ($EN_COUNT>0) $EN_WER_SUM/$EN_COUNT else 0" | bc -l)" \
  --argjson es_avg_wer "$(echo "scale=4; if ($ES_COUNT>0) $ES_WER_SUM/$ES_COUNT else 0" | bc -l)" \
  --argjson avg_latency "$(printf '%s\n' "${LATENCY_LIST[@]}" | awk '{sum+=$1} END {if (NR>0) print sum/NR; else print 0}')" \
  --argjson p50_latency "$(percentile 50 "${LATENCY_LIST[@]}")" \
  --argjson p95_latency "$(percentile 95 "${LATENCY_LIST[@]}")" \
  --arg stt_url "$STT_URL" \
  --arg backend "$WHISPER_BACKEND" \
  --arg healthz "$HEALTHZ" \
  --arg commit_sha "$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    total: $total,
    en_count: $en_count,
    es_count: $es_count,
    avg_wer: $avg_wer,
    en_avg_wer: $en_avg_wer,
    es_avg_wer: $es_avg_wer,
    avg_latency_ms: $avg_latency,
    p50_latency_ms: $p50_latency,
    p95_latency_ms: $p95_latency,
    stt_url: $stt_url,
    backend: $backend,
    healthz: $healthz,
    commit_sha: $commit_sha,
    timestamp: $timestamp
  }')

jq -n \
  --argjson tests "$(jq -s '.' "$RESULTS_TMP")" \
  --argjson summary "$SUMMARY_JSON" \
  '{tests: $tests, summary: $summary}' > "$RESULTS_FILE"

rm -f "$RESULTS_TMP"

echo "Results written to $RESULTS_FILE"