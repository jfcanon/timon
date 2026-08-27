const GROQ_MODEL = 'qwen/qwen3.8-27b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const FETCH_TIMEOUT_MS = 10000;
const PRIORITIES = ['high', 'medium', 'low'];

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

// Truncate to 50 code points (not UTF-16 units) so an emoji at the boundary
// is never split into a broken surrogate pair.
function truncateTitle(text) {
  return Array.from(String(text || '')).slice(0, 50).join('');
}

function fallback(transcript) {
  return {
    title: truncateTitle(transcript),
    date: null,
    priority: 'medium',
    category: null,
    tags: [],
  };
}

function todayInTimezone(tz) {
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

// Fail fast: abort the fetch after FETCH_TIMEOUT_MS so a hung Groq call
// doesn't hold a Worker until the platform cap (Talvi idiom).
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function extractIntent(transcript, env) {
  const today = todayInTimezone(env.TZ);
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
    const res = await fetchWithTimeout(GROQ_URL, {
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
      title: truncateTitle(json.title || transcript),
      date: json.date || null,
      priority: PRIORITIES.includes(json.priority) ? json.priority : 'medium',
      category: json.category || null,
      tags: Array.isArray(json.tags) ? json.tags : [],
    };
  } catch (err) {
    console.error('Intent JSON parse failed:', err.message);
    return fallback(transcript);
  }
}
