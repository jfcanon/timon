import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractIntent } from '../src/lib/intents.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

function mockGroqResponse(content) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  };
}

function mockGroqError(status) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message: 'fail' } }),
  };
}

function makeEnv(overrides = {}) {
  return {
    GROQ_API_KEY: 'test-key',
    TZ: 'America/Argentina/Buenos_Aires',
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Without this, a fetch stub from an earlier test leaks into later tests —
  // including the live smoke test, which would then never hit the real API.
  vi.unstubAllGlobals();
});

describe('extractIntent — English transcripts', () => {
  const englishCases = [
    {
      label: 'vague — single word',
      transcript: 'coffee',
      response: '{"title":"Get coffee","date":null,"priority":"low","category":"errand","tags":["coffee"]}',
      expectTitle: 'Get coffee',
    },
    {
      label: 'simple command',
      transcript: 'buy milk',
      response: '{"title":"Buy milk","date":null,"priority":"medium","category":"shopping","tags":["grocery","milk"]}',
      expectTitle: 'Buy milk',
    },
    {
      label: 'relative date — tomorrow',
      transcript: 'call dentist tomorrow',
      response: '{"title":"Call dentist","date":"2026-08-27T00:00:00.000Z","priority":"high","category":"health","tags":["dentist","appointment"]}',
      expectTitle: 'Call dentist',
    },
    {
      label: 'specific time — 3pm',
      transcript: 'meeting with Juan at 3pm',
      response: '{"title":"Meeting with Juan","date":"2026-08-26T15:00:00.000Z","priority":"high","category":"work","tags":["meeting","Juan"]}',
      expectTitle: 'Meeting with Juan',
    },
    {
      label: 'multi-task sentence',
      transcript: 'buy milk when I pass the shop and also pick up the dry cleaning',
      response: '{"title":"Buy milk and pick up dry cleaning","date":null,"priority":"medium","category":"errand","tags":["shopping","dry-cleaning"]}',
      expectTitle: 'Buy milk and pick up dry cleaning',
    },
    {
      label: 'long transcript — title truncation',
      transcript: 'I need to go to the hardware store and buy a new hammer and some nails and also a tape measure and some screws and a drill bit set',
      response: '{"title":"Buy tools at hardware store","date":null,"priority":"low","category":"errand","tags":["hardware","tools"]}',
      expectTitle: 'Buy tools at hardware store',
    },
    {
      label: 'reminder intent',
      transcript: 'remind me to water the plants every Monday',
      response: '{"title":"Water the plants","date":"2026-09-01T09:00:00.000Z","priority":"medium","category":"home","tags":["plants","recurring"]}',
      expectTitle: 'Water the plants',
    },
    {
      label: 'high priority',
      transcript: 'urgent: send the proposal before noon',
      response: '{"title":"Send proposal before noon","date":"2026-08-26T12:00:00.000Z","priority":"high","category":"work","tags":["proposal","deadline"]}',
      expectTitle: 'Send proposal before noon',
    },
    {
      label: 'minimal — no category',
      transcript: 'fix the squeaky door',
      response: '{"title":"Fix the squeaky door","date":null,"priority":"low","category":null,"tags":["home-repair"]}',
      expectTitle: 'Fix the squeaky door',
    },
    {
      label: 'with code fences',
      transcript: 'schedule dentist appointment',
      response: '```json\n{"title":"Schedule dentist appointment","date":"2026-09-02T10:00:00.000Z","priority":"medium","category":"health","tags":["dentist"]}\n```',
      expectTitle: 'Schedule dentist appointment',
    },
  ];

  englishCases.forEach(({ label, transcript, response, expectTitle }) => {
    it(label, async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockGroqResponse(response)));
      const result = await extractIntent(transcript, makeEnv());
      expect(result.title).toBe(expectTitle);
      expect(['high', 'medium', 'low']).toContain(result.priority);
      expect(Array.isArray(result.tags)).toBe(true);
    });
  });
});

describe('extractIntent — Spanish transcripts', () => {
  const spanishCases = [
    {
      label: 'compra simple',
      transcript: 'comprar leche',
      response: '{"title":"Comprar leche","date":null,"priority":"medium","category":"compras","tags":["leche"]}',
      expectTitle: 'Comprar leche',
    },
    {
      label: 'fecha relativa — mañana',
      transcript: 'llamar al dentista mañana',
      response: '{"title":"Llamar al dentista","date":"2026-08-27T00:00:00.000Z","priority":"high","category":"salud","tags":["dentista"]}',
      expectTitle: 'Llamar al dentista',
    },
    {
      label: 'tarea con hora',
      transcript: 'reunión con María a las tres de la tarde',
      response: '{"title":"Reunión con María","date":"2026-08-26T15:00:00.000Z","priority":"high","category":"trabajo","tags":["reunión","María"]}',
      expectTitle: 'Reunión con María',
    },
    {
      label: 'tarea urgente',
      transcript: 'urgente: enviar el informe antes del mediodía',
      response: '{"title":"Enviar informe urgente","date":"2026-08-26T12:00:00.000Z","priority":"high","category":"trabajo","tags":["informe","deadline"]}',
      expectTitle: 'Enviar informe urgente',
    },
    {
      label: 'tarea del hogar',
      transcript: 'arreglar la puerta que cruje',
      response: '{"title":"Arreglar puerta","date":null,"priority":"low","category":"hogar","tags":["reparación"]}',
      expectTitle: 'Arreglar puerta',
    },
  ];

  spanishCases.forEach(({ label, transcript, response, expectTitle }) => {
    it(label, async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockGroqResponse(response)));
      const result = await extractIntent(transcript, makeEnv());
      expect(result.title).toBe(expectTitle);
      expect(['high', 'medium', 'low']).toContain(result.priority);
      expect(Array.isArray(result.tags)).toBe(true);
    });
  });
});

describe('extractIntent — error handling', () => {
  it('returns fallback on network timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const result = await extractIntent('buy milk', makeEnv());
    expect(result.title).toBe('buy milk');
    expect(result.date).toBeNull();
    expect(result.priority).toBe('medium');
    expect(result.category).toBeNull();
    expect(result.tags).toEqual([]);
  });

  it('returns fallback on non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockGroqError(429)));
    const result = await extractIntent('buy milk', makeEnv());
    expect(result.title).toBe('buy milk');
    expect(result.date).toBeNull();
  });

  it('returns fallback on invalid JSON in response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockGroqResponse('not json at all')));
    const result = await extractIntent('buy milk', makeEnv());
    expect(result.title).toBe('buy milk');
    expect(result.date).toBeNull();
    expect(result.priority).toBe('medium');
  });

  it('truncates title to 50 chars', async () => {
    const longTitle = 'A'.repeat(60);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockGroqResponse(`{"title":"${longTitle}","date":null,"priority":"medium","category":null,"tags":[]}`)
    ));
    const result = await extractIntent('test', makeEnv());
    expect(result.title.length).toBeLessThanOrEqual(50);
  });

  it('handles missing optional fields gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockGroqResponse('{"title":"Task"}')
    ));
    const result = await extractIntent('do something', makeEnv());
    expect(result.title).toBe('Task');
    expect(result.date).toBeNull();
    expect(result.priority).toBe('medium');
    expect(result.category).toBeNull();
    expect(result.tags).toEqual([]);
  });

  it('handles missing tags array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockGroqResponse('{"title":"Task","date":null,"priority":"low","category":"work"}')
    ));
    const result = await extractIntent('work thing', makeEnv());
    expect(Array.isArray(result.tags)).toBe(true);
    expect(result.tags).toEqual([]);
  });

  it('clamps invalid priority to medium', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockGroqResponse('{"title":"Task","date":null,"priority":"URGENT","category":"work","tags":[]}')
    ));
    const result = await extractIntent('urgent task', makeEnv());
    expect(result.priority).toBe('medium');
  });

  it('does not split a surrogate pair at the 50-char boundary', async () => {
    const title = 'a'.repeat(49) + '😀' + 'b'.repeat(10);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockGroqResponse(`{"title":"${title}","date":null,"priority":"medium","category":null,"tags":[]}`)
    ));
    const result = await extractIntent('test', makeEnv());
    // 50 code points, with the emoji (a surrogate pair) kept whole.
    expect(result.title).toBe('a'.repeat(49) + '😀');
  });
});

describe('extractIntent — GROQ_API_KEY usage', () => {
  it('sends Authorization header with the key', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockGroqResponse('{"title":"Test"}'));
    vi.stubGlobal('fetch', fetchSpy);
    await extractIntent('test', makeEnv({ GROQ_API_KEY: 'sk-test-123' }));
    expect(fetchSpy).toHaveBeenCalledWith(
      GROQ_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test-123',
        }),
      })
    );
  });

  it('uses JSON response format', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockGroqResponse('{"title":"Test"}'));
    vi.stubGlobal('fetch', fetchSpy);
    await extractIntent('test', makeEnv());
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('injects today date and timezone into the system prompt', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockGroqResponse('{"title":"Test"}'));
    vi.stubGlobal('fetch', fetchSpy);
    await extractIntent('test', makeEnv({ TZ: 'America/Argentina/Buenos_Aires' }));
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const system = body.messages[0].content;
    expect(system).toContain('Timezone: America/Argentina/Buenos_Aires');
    expect(system).toMatch(/Today's date: \d{4}-\d{2}-\d{2}/);
  });
});

describe('extractIntent — live smoke test', () => {
  it.skipIf(!process.env.GROQ_API_KEY)('resolves a relative date from a real Groq call', async () => {
    const result = await extractIntent('buy milk tomorrow', {
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      TZ: 'UTC',
    });
    expect(result.title).toBeTruthy();
    expect(result.title.length).toBeLessThanOrEqual(50);
    expect(['high', 'medium', 'low']).toContain(result.priority);
    expect(Array.isArray(result.tags)).toBe(true);
    // A real LLM must resolve "tomorrow" to a non-null date; the heuristic
    // fallback always returns date: null. This assertion is the regression
    // gate that catches a broken model / dead integration.
    expect(result.date).not.toBeNull();
  });
});
