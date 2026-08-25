export async function extractIntent(transcript, env) {
  const prompt = `Extract task details from voice transcript. Output JSON only.
Transcript: "${transcript}"
Output format: {"title": "string (max 50 chars)", "date": "ISO 8601 or null", "priority": "high|medium|low", "category": "string or null", "tags": ["array"]}`;

  try {
    const result = await env.AI.run('@cf/meta/llama-2-7b-chat-int8', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200
    });

    const responseText = result.response || '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');

    const json = JSON.parse(jsonMatch[0]);
    return {
      title: json.title || transcript.slice(0, 50),
      date: json.date || null,
      priority: json.priority || 'medium',
      category: json.category || null,
      tags: json.tags || []
    };
  } catch (err) {
    console.error('Intent extraction failed:', err.message);
    return {
      title: transcript.slice(0, 50),
      date: null,
      priority: 'medium',
      category: null,
      tags: []
    };
  }
}
