#!/bin/bash
# Timon Benchmark Test Script
# Tests Whisper STT accuracy and latency against the deployed Worker.
#
# Results are persisted to benchmark_results.json (overwritten each run).
#
# Audio: expects pre-generated files at $AUDIO_DIR/timon_test_<ID>.wav
#   (one file per corpus entry). Generate them with either:
#   - test/generate_speech.py        (Groq TTS, requires GROQ_API_KEY)
#   - test/generate_speech_local.sh  (macOS `say`, no API key needed)

set -e

WORKER_URL="${WORKER_URL:-https://timon-worker.ygdcbtmc4u.workers.dev}"
CORPUS_FILE="test/corpus.json"
RESULTS_FILE="benchmark_results.json"
AUDIO_DIR="/tmp"

# Normalize a transcript for scoring: lowercase, strip punctuation, expand
# number words to digits ("six"->"6"), and collapse common compounds
# ("stand up"->"standup"). Mirrors standard STT benchmark normalization so a
# correct transcription isn't penalized for spelling/format differences.
normalize() {
  local s="$1"
  s=$(echo "$s" | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:]')
  s=$(echo "$s" | perl -pe \
    's/\bzero\b/0/g; s/\bone\b/1/g; s/\btwo\b/2/g; s/\bthree\b/3/g;
     s/\bfour\b/4/g; s/\bfive\b/5/g; s/\bsix\b/6/g; s/\bseven\b/7/g;
     s/\beight\b/8/g; s/\bnine\b/9/g; s/\bten\b/10/g; s/stand up/standup/g')
  s=$(echo "$s" | tr -s ' ' | sed 's/^ *//; s/ *$//')
  echo "$s"
}

# POST one audio file to the worker, retrying transient STT failures
# (Groq rate limits surface as fast 4xx/transcription_failed responses).
post_audio() {
  local audio="$1" attempt result err
  for attempt in 1 2 3; do
    result=$(curl -s -m 60 -X POST "$WORKER_URL/api/voice" \
      -H "Content-Type: audio/wav" \
      -H "x-session-id: benchmark-test" \
      --data-binary "@$audio" 2>/dev/null)
    err=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
    if [ -z "$err" ] || [ "$err" = "null" ] || [ "$err" = "empty" ]; then
      echo "$result"
      return 0
    fi
    [ $attempt -lt 3 ] && sleep 3
  done
  echo "$result"
  return 1
}

echo "=== Timon Benchmark Tests ==="
echo "Worker URL: $WORKER_URL"
echo ""

# Check if corpus exists
if [ ! -f "$CORPUS_FILE" ]; then
  echo "Error: Corpus file not found at $CORPUS_FILE"
  exit 1
fi

# Test healthz endpoint
echo "Testing /healthz..."
HEALTHZ=$(curl -s -m 10 "$WORKER_URL/healthz")
echo "Response: $HEALTHZ"
echo ""

# Run corpus tests
echo "Running STT accuracy tests..."
TOTAL=0
PASSED=0
FAILED=0
NPASSED=0
TOTAL_LATENCY=0
RESULTS_TMP="$(mktemp)"

for i in $(seq 0 19); do
  ENTRY=$(jq -r ".[$i]" "$CORPUS_FILE")
  ID=$(echo "$ENTRY" | jq -r '.id')
  TEXT=$(echo "$ENTRY" | jq -r '.text')
  EXPECTED=$(echo "$ENTRY" | jq -r '.expected')

  echo -n "Test $ID: \"$TEXT\"... "

  # Use pre-generated speech audio
  AUDIO_FILE="$AUDIO_DIR/timon_test_$ID.wav"

  if [ ! -f "$AUDIO_FILE" ]; then
    echo "SKIP (no audio file)"
    echo "{\"id\":\"$ID\",\"text\":$(jq -Rn --arg s "$TEXT" '$s'),\"expected\":$(jq -Rn --arg s "$EXPECTED" '$s'),\"transcription\":null,\"latency_ms\":null,\"status\":\"SKIP\",\"normalized_status\":\"SKIP\"}" >> "$RESULTS_TMP"
    continue
  fi

  START_TIME=$(date +%s%N)
  RESULT=$(post_audio "$AUDIO_FILE")
  END_TIME=$(date +%s%N)

  LATENCY_MS=$(( (END_TIME - START_TIME) / 1000000 ))
  TOTAL_LATENCY=$((TOTAL_LATENCY + LATENCY_MS))

  # Check for errors
  ERROR=$(echo "$RESULT" | jq -r '.error // empty' 2>/dev/null)
  TRANSCRIPTION=$(echo "$RESULT" | jq -r '.transcription // empty' 2>/dev/null)

  if [ -n "$ERROR" ] && [ "$ERROR" != "null" ]; then
    echo "ERROR: $ERROR"
    echo "{\"id\":\"$ID\",\"text\":$(jq -Rn --arg s "$TEXT" '$s'),\"expected\":$(jq -Rn --arg s "$EXPECTED" '$s'),\"transcription\":null,\"latency_ms\":$LATENCY_MS,\"status\":\"ERROR\",\"normalized_status\":\"ERROR\",\"error\":$(jq -Rn --arg s "$ERROR" '$s')}" >> "$RESULTS_TMP"
    continue
  fi

  # Strict comparison: exact match, case-insensitive, punctuation-stripped
  TRANSLATION_LOWER=$(echo "$TRANSCRIPTION" | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:]')
  EXPECTED_LOWER=$(echo "$EXPECTED" | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:]')

  # Normalized comparison: also expands number words and known compounds
  TRANSLATION_NORM=$(normalize "$TRANSCRIPTION")
  EXPECTED_NORM=$(normalize "$EXPECTED")

  if [ "$TRANSLATION_LOWER" = "$EXPECTED_LOWER" ]; then
    echo -n "PASS (${LATENCY_MS}ms)"
    PASSED=$((PASSED + 1))
    STATUS="PASS"
  else
    echo -n "FAIL (got: \"$TRANSCRIPTION\", expected: \"$EXPECTED\", ${LATENCY_MS}ms)"
    FAILED=$((FAILED + 1))
    STATUS="FAIL"
  fi

  if [ "$TRANSLATION_NORM" = "$EXPECTED_NORM" ]; then
    NPASSED=$((NPASSED + 1))
    NSTATUS="PASS"
  else
    NSTATUS="FAIL"
  fi

  if [ "$STATUS" = "FAIL" ] && [ "$NSTATUS" = "PASS" ]; then
    echo " [normalized: PASS]"
  else
    echo ""
  fi

  TOTAL=$((TOTAL + 1))
  echo "{\"id\":\"$ID\",\"text\":$(jq -Rn --arg s "$TEXT" '$s'),\"expected\":$(jq -Rn --arg s "$EXPECTED" '$s'),\"transcription\":$(jq -Rn --arg s "$TRANSCRIPTION" '$s'),\"latency_ms\":$LATENCY_MS,\"status\":\"$STATUS\",\"normalized_status\":\"$NSTATUS\"}" >> "$RESULTS_TMP"

  # Pace requests to stay under Groq free-tier rate limits
  [ "$i" -lt 19 ] && sleep 1
done

echo ""
echo "=== Summary ==="
echo "Total tests: $TOTAL"
echo "Passed (strict): $PASSED"
echo "Failed (strict): $FAILED"
if [ $TOTAL -gt 0 ]; then
  ACCURACY=$(( (PASSED * 100) / TOTAL ))
  NACCURACY=$(( (NPASSED * 100) / TOTAL ))
  AVG_LATENCY=$(( TOTAL_LATENCY / TOTAL ))
  echo "Accuracy (strict): $ACCURACY%"
  echo "Accuracy (normalized): $NACCURACY%"
  echo "Average latency: ${AVG_LATENCY}ms"
fi
echo ""

# Test WebSocket connectivity
echo "Testing WebSocket connectivity..."
WS_RESULT="SKIP (wscat not installed)"
if command -v wscat &> /dev/null; then
  echo "Connecting to wss://$WORKER_URL/api/ws..."
  WS_RESULT="ok (connect timeout expected)"
  timeout 3 wscat -c "wss://$WORKER_URL/api/ws" -x '{"type":"subscribe"}' 2>/dev/null || echo "WebSocket test completed (timeout expected)"
fi

# Persist results to benchmark_results.json
SUMMARY="{\"total\":$TOTAL,\"passed\":$PASSED,\"failed\":$FAILED,\"accuracy_pct\":$ACCURACY,\"normalized_accuracy_pct\":$NACCURACY,\"avg_latency_ms\":$AVG_LATENCY,\"worker_url\":$(jq -Rn --arg s "$WORKER_URL" '$s'),\"healthz\":$(jq -Rn --arg s "$HEALTHZ" '$s'),\"websocket\":$(jq -Rn --arg s "$WS_RESULT" '$s')}"

if [ $TOTAL -gt 0 ]; then
  jq -n \
    --argjson tests "$(jq -s '.' "$RESULTS_TMP")" \
    --argjson summary "$SUMMARY" \
    '{tests: $tests, summary: $summary}' > "$RESULTS_FILE"
else
  echo '{"tests": [], "summary": {}}' > "$RESULTS_FILE"
fi
rm -f "$RESULTS_TMP"

echo ""
echo "Results written to $RESULTS_FILE"
