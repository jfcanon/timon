#!/usr/bin/env python3
"""Generate test speech audio using Groq TTS API."""
import os
import sys
import json
import requests

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
if not GROQ_API_KEY:
    print("Error: GROQ_API_KEY not set")
    sys.exit(1)

# Test phrases from corpus (remaining 10)
test_phrases = [
    "reply to john email about budget",
    "gym at six pm today",
    "buy birthday gift for sarah",
    "schedule car maintenance",
    "plan vacation to portugal",
    "call mom tonight",
    "read chapter five of book",
    "send invoice to client",
    "book restaurant for saturday",
    "pick up dry cleaning"
]

# Generate audio for each phrase
for i, phrase in enumerate(test_phrases):
    print(f"Generating audio for: {phrase}")
    
    response = requests.post(
        "https://api.groq.com/openai/v1/audio/speech",
        headers={
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json"
        },
        json={
            "model": "canopylabs/orpheus-v1-english",
            "input": phrase,
            "voice": "autumn",
            "response_format": "wav"
        }
    )
    
    if response.status_code == 200:
        output_file = f"/tmp/timon_test_{i+11:03d}.wav"
        with open(output_file, "wb") as f:
            f.write(response.content)
        print(f"  Saved: {output_file}")
    else:
        print(f"  Error: {response.status_code} - {response.text[:100]}")

print("\nDone! Generated remaining test audio files.")
