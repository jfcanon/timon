#!/bin/bash
# Timon Benchmark Test Script
# Tests Whisper STT accuracy and latency against deployed Worker

set -e

WORKER_URL="${WORKER_URL:-https://timon-worker.ygdcbtmc4u.workers.dev}"
CORPUS_FILE="test/corpus.json"
RESULTS_FILE="benchmark_results.json"
AUDIO_DIR="/tmp"

echo "=== Timon Benchmark Tests ==="
echo "Worker URL: $WORKER_URL"
echo ""

# Check if corpus exists
if [ ! -f "$CORPUS_FILE" ]; then
  echo "Error: Corpus file not found at $CORPUS_FILE"
  exit 1
fi

# Initialize results
echo '{"tests": [], "summary": {}}' > "$RESULTS_FILE"

# Test healthz endpoint
echo "Testing /healthz..."
HEALTHZ=$(curl -s "$WORKER_URL/healthz")
echo "Response: $HEALTHZ"
echo ""

# Run corpus tests
echo "Running STT accuracy tests..."
TOTAL=0
PASSED=0
FAILED=0
TOTAL_LATENCY=0

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
    continue
  fi
  
  START_TIME=$(date +%s%N)
  RESULT=$(curl -s -X POST "$WORKER_URL/api/voice" \
    -H "Content-Type: audio/wav" \
    -H "x-session-id: benchmark-test" \
    --data-binary "@$AUDIO_FILE" 2>/dev/null)
  END_TIME=$(date +%s%N)
  
  LATENCY_MS=$(( (END_TIME - START_TIME) / 1000000 ))
  TOTAL_LATENCY=$((TOTAL_LATENCY + LATENCY_MS))
  
  # Check for errors
  ERROR=$(echo "$RESULT" | jq -r '.error // empty' 2>/dev/null)
  TRANSCRIPTION=$(echo "$RESULT" | jq -r '.transcription // empty' 2>/dev/null)
  
  if [ -n "$ERROR" ] && [ "$ERROR" != "null" ]; then
    echo "ERROR: $ERROR"
    continue
  fi
  
  # Simple WER-like comparison (case-insensitive, ignoring punctuation)
  TRANSLATION_LOWER=$(echo "$TRANSCRIPTION" | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:]')
  EXPECTED_LOWER=$(echo "$EXPECTED" | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:]')
  
  if [ "$TRANSLATION_LOWER" = "$EXPECTED_LOWER" ]; then
    echo "PASS (${LATENCY_MS}ms)"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL (got: \"$TRANSCRIPTION\", expected: \"$EXPECTED\", ${LATENCY_MS}ms)"
    FAILED=$((FAILED + 1))
  fi
  
  TOTAL=$((TOTAL + 1))
done

echo ""
echo "=== Summary ==="
echo "Total tests: $TOTAL"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
if [ $TOTAL -gt 0 ]; then
  ACCURACY=$(( (PASSED * 100) / TOTAL ))
  AVG_LATENCY=$(( TOTAL_LATENCY / TOTAL ))
  echo "Accuracy: $ACCURACY%"
  echo "Average latency: ${AVG_LATENCY}ms"
fi
echo ""

# Test WebSocket connectivity
echo "Testing WebSocket connectivity..."
if command -v wscat &> /dev/null; then
  echo "Connecting to wss://$WORKER_URL/api/ws..."
  timeout 3 wscat -c "wss://$WORKER_URL/api/ws" -x '{"type":"subscribe"}' 2>/dev/null || echo "WebSocket test completed (timeout expected)"
else
  echo "SKIP (wscat not installed)"
fi
