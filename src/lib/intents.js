const GROQ_MODEL = 'llama-3.1-8b-instant';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `Extract task details from voice transcripts. Output strict JSON only.
Today's date: {TODAY}
Timezone: {TZ}

Required JSON shape:
{
  "title": "string (max 50 chars, concise task summary)",
  "date": "ISO 8601 datetime or null (resolve relative dates like 'tomorrow', 'next week', '3pm' using the given date and timezone)",
  "priority": "high|medium|low",
  "category": "string or null (e.g. shopping, work, health, errand)",
  "tags": ["array of short keyword strings"]
}`;

function fallback(transcript) {
  return {
    title: transcript.slice(0, 50),
    date: null,
    priority: 'medium',
    category: null,
    tags: [],
  };
}

function resolveDate(text, tz) {
  const now = new Date();
  const locale = tz || 'UTC';
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: locale,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(now);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    return `${y}-${m}-${d}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export async function extractIntent(transcript, env) {
  const today = resolveDate(null, env.TZ);
  const tz = env.TZ || 'UTC';
  const systemPrompt = SYSTEM_PROMPT
    .replace('{TODAY}', today)
    .replace('{TZ}', tz);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: transcript },
  ];

  let responseText = '';
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.1,
        max_tokens: 256,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      throw new Error(`Groq chat failed with status ${res.status}`);
    }

    const body = await res.json();
    responseText = body.choices?.[0]?.message?.content || '';
    if (!responseText) throw new Error('Empty response from Groq');
  } catch (err) {
    console.error('Intent extraction failed:', err.message);
    return fallback(transcript);
  }

  try {
    let cleaned = responseText.trim();
    // strip markdown code fences if present
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const json = JSON.parse(cleaned);
    return {
      title: (json.title || transcript.slice(0, 50)).slice(0, 50),
      date: json.date || null,
      priority: json.priority || 'medium',
      category: json.category || null,
      tags: Array.isArray(json.tags) ? json.tags : [],
    };
  } catch (err) {
    console.error('Intent JSON parse failed:', err.message);
    return fallback(transcript);
  }
}
