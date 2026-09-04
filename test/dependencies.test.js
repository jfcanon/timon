import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockD1 } from './mock-d1.js';
import { ensureSchema, createTask, addDependency } from '../src/lib/store.js';

function makeEnv() {
  return {
    TIMON_API_KEY: 'test-api-key-123',
    TIMON_META: createMockD1(),
    SESSION: {
      idFromName: vi.fn(() => 'mock-id'),
      get: vi.fn(() => ({
        addTask: vi.fn(async () => ({})),
        updateTask: vi.fn(async () => ({})),
        removeTask: vi.fn(async () => ({})),
      })),
    },
    ASSETS: {
      fetch: vi.fn(async () => new Response('ok', { status: 200 })),
    },
  };
}

function authHeaders(env) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${env.TIMON_API_KEY}`,
  };
}

describe('POST /api/tasks/:id/dependencies', () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/index.js');
    worker = mod.default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a dependency and returns 201', async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await createTask(env.TIMON_META, { title: 'A' });
    const b = await createTask(env.TIMON_META, { title: 'B' });

    const response = await worker.fetch(
      new Request(`https://timon-worker.example.com/api/tasks/${a}/dependencies`, {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify({ depends_on_id: b }),
      }),
      env
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data).toEqual({ task_id: a, depends_on_id: b, status: 'created' });
    expect(env.TIMON_META._store.dependencies.filter(d => d.task_id === a && d.depends_on_id === b).length).toBe(1);
  });

  it('returns 400 when depends_on_id is missing', async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await createTask(env.TIMON_META, { title: 'A' });

    const response = await worker.fetch(
      new Request(`https://timon-worker.example.com/api/tasks/${a}/dependencies`, {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify({}),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'depends_on_id_required' });
  });

  it('returns 400 on invalid JSON', async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await createTask(env.TIMON_META, { title: 'A' });

    const response = await worker.fetch(
      new Request(`https://timon-worker.example.com/api/tasks/${a}/dependencies`, {
        method: 'POST',
        headers: authHeaders(env),
        body: 'not-json',
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 on self-dependency', async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await createTask(env.TIMON_META, { title: 'A' });

    const response = await worker.fetch(
      new Request(`https://timon-worker.example.com/api/tasks/${a}/dependencies`, {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify({ depends_on_id: a }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'cannot_depend_on_self' });
  });

  it('returns 400 on a cycle', async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await createTask(env.TIMON_META, { title: 'A' });
    const b = await createTask(env.TIMON_META, { title: 'B' });
    await addDependency(env.TIMON_META, a, b);

    const response = await worker.fetch(
      new Request(`https://timon-worker.example.com/api/tasks/${b}/dependencies`, {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify({ depends_on_id: a }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'dependency_cycle_detected' });
  });

  it('returns 404 when the source task does not exist', async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const b = await createTask(env.TIMON_META, { title: 'B' });

    const response = await worker.fetch(
      new Request('https://timon-worker.example.com/api/tasks/missing/dependencies', {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify({ depends_on_id: b }),
      }),
      env
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'task_not_found' });
  });

  it('returns 400 when depends_on_id does not exist', async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await createTask(env.TIMON_META, { title: 'A' });

    const response = await worker.fetch(
      new Request(`https://timon-worker.example.com/api/tasks/${a}/dependencies`, {
        method: 'POST',
        headers: authHeaders(env),
        body: JSON.stringify({ depends_on_id: 'missing' }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'depends_on_not_found' });
  });

  it('returns 401 without auth', async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request('https://timon-worker.example.com/api/tasks/x/dependencies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ depends_on_id: 'y' }),
      }),
      env
    );
    expect(response.status).toBe(401);
  });
});

describe('DELETE /api/tasks/:id/dependencies/:dependsOnId', () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/index.js');
    worker = mod.default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes the row and returns { removed: true }', async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await createTask(env.TIMON_META, { title: 'A' });
    const b = await createTask(env.TIMON_META, { title: 'B' });
    await addDependency(env.TIMON_META, a, b);

    const response = await worker.fetch(
      new Request(`https://timon-worker.example.com/api/tasks/${a}/dependencies/${b}`, {
        method: 'DELETE',
        headers: authHeaders(env),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
    expect(env.TIMON_META._store.dependencies.length).toBe(0);
    expect(
      env.TIMON_META._store.task_events.filter(e => e.event_type === 'dependency_removed').length
    ).toBe(1);
  });

  it('is idempotent when the row is already gone', async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);
    const a = await createTask(env.TIMON_META, { title: 'A' });
    const b = await createTask(env.TIMON_META, { title: 'B' });

    const response = await worker.fetch(
      new Request(`https://timon-worker.example.com/api/tasks/${a}/dependencies/${b}`, {
        method: 'DELETE',
        headers: authHeaders(env),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: false });
    expect(
      env.TIMON_META._store.task_events.filter(e => e.event_type === 'dependency_removed').length
    ).toBe(0);
  });

  it('returns 404 when the source task does not exist', async () => {
    const env = makeEnv();
    await ensureSchema(env.TIMON_META);

    const response = await worker.fetch(
      new Request('https://timon-worker.example.com/api/tasks/missing/dependencies/other', {
        method: 'DELETE',
        headers: authHeaders(env),
      }),
      env
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'task_not_found' });
  });

  it('returns 401 without auth', async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request('https://timon-worker.example.com/api/tasks/x/dependencies/y', {
        method: 'DELETE',
      }),
      env
    );
    expect(response.status).toBe(401);
  });
});
