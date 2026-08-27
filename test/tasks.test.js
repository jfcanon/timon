import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeEnv(overrides = {}) {
  const tasks = [];
  const mockDB = {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
      })),
    })),
  };
  const mockSession = {
    addTask: vi.fn(async () => ({})),
  };
  const mockSessionDO = {
    idFromName: vi.fn(() => 'mock-id'),
    get: vi.fn(() => mockSession),
  };

  return {
    TIMON_API_KEY: 'test-api-key-123',
    TIMON_META: mockDB,
    SESSION: mockSessionDO,
    ...overrides,
  };
}

function makeRequest(body, env, headers = {}) {
  const request = new Request('https://timon-worker.example.com/api/tasks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.TIMON_API_KEY}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return request;
}

describe('POST /api/tasks', () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/index.js');
    worker = mod.default;
  });

  it('should return 401 without valid API key', async () => {
    const env = makeEnv();
    const request = new Request('https://timon-worker.example.com/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'buy milk' }),
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('unauthorized');
  });

  it('should return 401 with wrong API key', async () => {
    const env = makeEnv();
    const request = new Request('https://timon-worker.example.com/api/tasks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-key',
      },
      body: JSON.stringify({ text: 'buy milk' }),
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
  });

  it('should return 400 on empty text', async () => {
    const env = makeEnv();
    const request = makeRequest({ text: '' }, env);

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('text_required');
  });

  it('should return 400 on whitespace-only text', async () => {
    const env = makeEnv();
    const request = makeRequest({ text: '   ' }, env);

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('text_required');
  });

  it('should return 400 on missing text field', async () => {
    const env = makeEnv();
    const request = makeRequest({ device_id: 'esp32-01' }, env);

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('text_required');
  });

  it('should return 400 on invalid JSON body', async () => {
    const env = makeEnv();
    const request = new Request('https://timon-worker.example.com/api/tasks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.TIMON_API_KEY}`,
      },
      body: 'not-json',
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('invalid_json');
  });

  it('should create task with valid text and return 201', async () => {
    const env = makeEnv();
    const mockTask = {
      id: 'mock-task-id',
      title: 'buy milk',
      parent_id: null,
      due_date: null,
      priority: 'medium',
      category: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const chainable = {
      run: vi.fn(async () => {}),
      first: vi.fn(async () => mockTask),
      all: vi.fn(async () => ({ results: [] })),
    };
    const bindFn = vi.fn(() => chainable);
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      bind: bindFn,
    }));

    const request = makeRequest({ text: 'buy milk' }, env);
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.status).toBe('created');
    expect(data.task_id).toBeDefined();
    expect(data.task).toBeDefined();
    expect(data.task.title).toBe('buy milk');
  });

  it('should store device_id in task_events when provided', async () => {
    const env = makeEnv();
    const capturedData = [];

    const chainable = {
      run: vi.fn(async () => {}),
      first: vi.fn(async () => ({
        id: 'mock-id', title: 'buy milk', priority: 'medium',
      })),
      all: vi.fn(async () => ({ results: [] })),
    };
    const bindFn = vi.fn((...args) => {
      // Capture the data argument (5th arg for task_events INSERT)
      if (args.length === 5) capturedData.push(args[4]);
      return chainable;
    });
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      bind: bindFn,
    }));

    const request = makeRequest(
      { text: 'buy milk', device_id: 'esp32-jarvis-01' },
      env
    );

    await worker.fetch(request, env);

    expect(capturedData.length).toBeGreaterThan(0);
    const eventData = JSON.parse(capturedData[0]);
    expect(eventData.device_id).toBe('esp32-jarvis-01');
    expect(eventData.title).toBe('buy milk');
  });

  it('should persist a valid ts as the task due date', async () => {
    const env = makeEnv();
    let capturedDueDate = null;

    const mockTask = {
      id: 'mock-task-id',
      title: 'buy milk',
      parent_id: null,
      due_date: '2026-08-27T09:00:00.000Z',
      priority: 'medium',
      category: null,
      created_at: 'now',
      updated_at: 'now',
    };
    const chainable = {
      run: vi.fn(async () => {}),
      first: vi.fn(async () => mockTask),
      all: vi.fn(async () => ({ results: [] })),
    };
    const bindFn = vi.fn((...args) => {
      // tasks INSERT binds (id, title, parent_id, due_date, priority,
      // category, created_at, updated_at) — due_date is arg index 3.
      if (args.length === 8) capturedDueDate = args[3];
      return chainable;
    });
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      bind: bindFn,
    }));

    const request = makeRequest(
      { text: 'buy milk', device_id: 'esp32-jarvis-01', ts: '2026-08-27T09:00:00Z' },
      env
    );

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(201);
    expect(capturedDueDate).toBe('2026-08-27T09:00:00.000Z');
  });

  it('should return 400 on an invalid ts', async () => {
    const env = makeEnv();
    const request = makeRequest({ text: 'buy milk', ts: 'not-a-date' }, env);

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('invalid_ts');
  });

  it('should override priority and category from the body', async () => {
    const env = makeEnv();
    let capturedTaskArgs = null;

    const mockTask = {
      id: 'mock-task-id',
      title: 'buy milk',
      parent_id: null,
      due_date: null,
      priority: 'high',
      category: 'shopping',
      created_at: 'now',
      updated_at: 'now',
    };
    const chainable = {
      run: vi.fn(async () => {}),
      first: vi.fn(async () => mockTask),
      all: vi.fn(async () => ({ results: [] })),
    };
    const bindFn = vi.fn((...args) => {
      // tasks INSERT binds (id, title, parent_id, due_date, priority,
      // category, created_at, updated_at) — priority is arg index 4,
      // category is arg index 5.
      if (args.length === 8) capturedTaskArgs = args;
      return chainable;
    });
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      bind: bindFn,
    }));

    const request = makeRequest(
      { text: 'buy milk', priority: 'high', category: 'shopping' },
      env
    );

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(201);
    expect(capturedTaskArgs[4]).toBe('high');
    expect(capturedTaskArgs[5]).toBe('shopping');
  });

  it('should return 400 on an invalid priority', async () => {
    const env = makeEnv();
    // ensureSchema calls db.prepare(sql).run(), so prepare must expose run.
    env.TIMON_META.prepare = vi.fn(() => ({
      run: vi.fn(async () => {}),
      bind: vi.fn(() => ({
        run: vi.fn(async () => {}),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
      })),
    }));
    const request = makeRequest({ text: 'buy milk', priority: 'urgent' }, env);

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('invalid_priority');
  });
});
