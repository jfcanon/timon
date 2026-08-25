export async function transcribeAudio(audioBuffer, env) {
  try {
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([audioBuffer], { type: 'audio/wav' }),
      'audio.wav'
    );
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Groq STT failed with status ${response.status}`);
    }

    const result = await response.json();
    const transcript = result.text?.trim() ?? '';
    if (transcript.length === 0) {
      throw new Error('STT returned empty text');
    }

    return {
      text: transcript,
      duration: result.duration || 0,
    };
  } catch (err) {
    console.error("Whisper failed:", err.message);
    return { error: "transcription_failed", message: err.message };
  }
}
