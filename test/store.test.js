import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensureSchema,
  createTask,
  getTaskWithContext,
  getDecoratedTask,
  setParent,
  addDependency,
  removeDependency,
  updateTask,
  deleteTask,
  listTasks,
} from '../src/lib/store.js';
import { createMockD1 } from './mock-d1.js';

let db;

beforeEach(() => { db = createMockD1(); });

describe('ensureSchema', () => {
  it('should create tables and be idempotent', async () => {
    await ensureSchema(db);
    await ensureSchema(db);
    expect(db._columns.tasks).toContain('status');
    expect(db._columns.tasks).toContain('completed_at');
  });
});

describe('createTask', () => {
  it('should create task with parent_id, category, and device_id in event', async () => {
    await ensureSchema(db);
    const intent = { title: 'Test', parent_id: 'p1', date: '2026-08-27', priority: 'high', category: 'work' };
    const id = await createTask(db, intent, 'owner', 'device-1');
    const task = db._store.tasks.find(t => t.id === id);
    expect(task.title).toBe('Test');
    expect(task.parent_id).toBe('p1');
    expect(task.category).toBe('work');
    const event = db._store.task_events.find(e => e.task_id === id);
    expect(JSON.parse(event.data).device_id).toBe('device-1');
  });

  it('should default parent_id to null', async () => {
    await ensureSchema(db);
    const id = await createTask(db, { title: 'X', date: null, priority: 'medium', category: null });
    expect(db._store.tasks.find(t => t.id === id).parent_id).toBeNull();
  });
});

describe('getDecoratedTask', () => {
  it('matches the GET /api/tasks row shape', async () => {
    await ensureSchema(db);
    const id = await createTask(db, { title: 'Milk', date: null, priority: 'medium', category: 'errand' });
    const decorated = await getDecoratedTask(db, id);
    const [listed] = await listTasks(db);
    expect(decorated).toEqual(listed);
    expect(decorated).toHaveProperty('parent_title');
    expect(decorated).toHaveProperty('blocked_by');
    expect(decorated).toHaveProperty('subtask_count');
  });
});

describe('getTaskWithContext', () => {
  it('should return task with parent, siblings, subtasks, blockers', async () => {
    await ensureSchema(db);
    const pid = await createTask(db, { title: 'Parent' });
    const cid = await createTask(db, { title: 'Child', parent_id: pid });
    const sid = await createTask(db, { title: 'Sibling', parent_id: pid });
    const bid = await createTask(db, { title: 'Blocker' });
    await addDependency(db, cid, bid);

    const ctx = await getTaskWithContext(db, cid);
    expect(ctx.task.id).toBe(cid);
    expect(ctx.parent.id).toBe(pid);
    expect(ctx.siblings.length).toBe(1);
    expect(ctx.siblings[0].id).toBe(sid);
    expect(ctx.subtasks.length).toBe(0);
    expect(ctx.blockers.length).toBe(1);
    expect(ctx.blockers[0].id).toBe(bid);
  });

  it('should return null for nonexistent task', async () => {
    await ensureSchema(db);
    expect(await getTaskWithContext(db, 'nope')).toBeNull();
  });
});

describe('setParent', () => {
  it('should update parent_id and emit event', async () => {
    await ensureSchema(db);
    const p1 = await createTask(db, { title: 'P1' });
    const p2 = await createTask(db, { title: 'P2' });
    const c = await createTask(db, { title: 'C', parent_id: p1 });
    await setParent(db, c, p2);
    expect(db._store.tasks.find(t => t.id === c).parent_id).toBe(p2);
    expect(db._store.task_events.filter(e => e.task_id === c && e.event_type === 'parent_changed').length).toBe(1);
  });

  it('should reject self parent', async () => {
    await ensureSchema(db);
    const id = await createTask(db, { title: 'X' });
    await expect(setParent(db, id, id)).rejects.toThrow('cannot set parent to self');
  });

  it('should reject cycles', async () => {
    await ensureSchema(db);
    const a = await createTask(db, { title: 'A' });
    const b = await createTask(db, { title: 'B' });
    const c = await createTask(db, { title: 'C' });
    await setParent(db, a, b);
    await setParent(db, b, c);
    await expect(setParent(db, c, a)).rejects.toThrow('cycle detected');
  });
});

describe('addDependency', () => {
  it('should add dependency and emit event', async () => {
    await ensureSchema(db);
    const t1 = await createTask(db, { title: 'T1' });
    const t2 = await createTask(db, { title: 'T2' });
    await addDependency(db, t1, t2);
    expect(db._store.dependencies.filter(d => d.task_id === t1).length).toBe(1);
    expect(db._store.task_events.filter(e => e.task_id === t1 && e.event_type === 'dependency_added').length).toBe(1);
  });

  it('should not duplicate', async () => {
    await ensureSchema(db);
    const t1 = await createTask(db, { title: 'T1' });
    const t2 = await createTask(db, { title: 'T2' });
    await addDependency(db, t1, t2);
    await addDependency(db, t1, t2);
    expect(db._store.dependencies.filter(d => d.task_id === t1).length).toBe(1);
  });

  it('should reject self dependency', async () => {
    await ensureSchema(db);
    const id = await createTask(db, { title: 'X' });
    await expect(addDependency(db, id, id)).rejects.toThrow('cannot depend on self');
  });

  it('should reject cycles', async () => {
    await ensureSchema(db);
    const a = await createTask(db, { title: 'A' });
    const b = await createTask(db, { title: 'B' });
    const c = await createTask(db, { title: 'C' });
    await addDependency(db, a, b);
    await addDependency(db, b, c);
    await expect(addDependency(db, c, a)).rejects.toThrow('dependency cycle detected');
  });
});

describe('removeDependency', () => {
  it('should delete the row and emit dependency_removed', async () => {
    await ensureSchema(db);
    const t1 = await createTask(db, { title: 'T1' });
    const t2 = await createTask(db, { title: 'T2' });
    await addDependency(db, t1, t2);
    const result = await removeDependency(db, t1, t2);
    expect(result.meta.changes).toBe(1);
    expect(db._store.dependencies.filter(d => d.task_id === t1).length).toBe(0);
    expect(db._store.task_events.filter(e => e.task_id === t1 && e.event_type === 'dependency_removed').length).toBe(1);
  });

  it('should no-op without emitting when the row is missing', async () => {
    await ensureSchema(db);
    const t1 = await createTask(db, { title: 'T1' });
    const t2 = await createTask(db, { title: 'T2' });
    const result = await removeDependency(db, t1, t2);
    expect(result.meta.changes).toBe(0);
    expect(db._store.task_events.filter(e => e.event_type === 'dependency_removed').length).toBe(0);
  });
});

describe('updateTask', () => {
  it('should update fields and emit event', async () => {
    await ensureSchema(db);
    const id = await createTask(db, { title: 'Old' });
    await updateTask(db, id, { title: 'New', status: 'completed', completed_at: '2026-08-27' });
    const task = db._store.tasks.find(t => t.id === id);
    expect(task.title).toBe('New');
    expect(task.status).toBe('completed');
    expect(task.completed_at).toBe('2026-08-27');
    expect(db._store.task_events.filter(e => e.task_id === id && e.event_type === 'updated').length).toBe(1);
  });

  it('should ignore invalid fields', async () => {
    await ensureSchema(db);
    const id = await createTask(db, { title: 'Old' });
    await updateTask(db, id, { bad: 'val', title: 'New' });
    expect(db._store.tasks.find(t => t.id === id).title).toBe('New');
  });
});

describe('deleteTask', () => {
  it('should re-parent children and delete', async () => {
    await ensureSchema(db);
    const pid = await createTask(db, { title: 'Parent' });
    const cid = await createTask(db, { title: 'Child', parent_id: pid });
    await deleteTask(db, pid);
    expect(db._store.tasks.find(t => t.id === pid)).toBeUndefined();
    expect(db._store.tasks.find(t => t.id === cid).parent_id).toBeNull();
  });

  it('should remove dependencies', async () => {
    await ensureSchema(db);
    const t1 = await createTask(db, { title: 'T1' });
    const t2 = await createTask(db, { title: 'T2' });
    await addDependency(db, t1, t2);
    await deleteTask(db, t1);
    expect(db._store.dependencies.filter(d => d.task_id === t1 || d.depends_on_id === t1).length).toBe(0);
  });
});

describe('listTasks', () => {
  it('should filter by category', async () => {
    await ensureSchema(db);
    await createTask(db, { title: 'W', category: 'work' });
    await createTask(db, { title: 'H', category: 'home' });
    const r = await listTasks(db, { category: 'work' });
    expect(r.length).toBe(1);
    expect(r[0].title).toBe('W');
  });

  it('should filter by parent_id', async () => {
    await ensureSchema(db);
    const p = await createTask(db, { title: 'P' });
    await createTask(db, { title: 'C', parent_id: p });
    await createTask(db, { title: 'R' });
    expect((await listTasks(db, { parent_id: p })).length).toBe(1);
    expect((await listTasks(db, { parent_id: null })).length).toBe(2);
  });

  it('should filter by status', async () => {
    await ensureSchema(db);
    const id = await createTask(db, { title: 'D' });
    await updateTask(db, id, { status: 'completed' });
    expect((await listTasks(db, { status: 'pending' })).length).toBe(0);
    expect((await listTasks(db, { status: 'completed' })).length).toBe(1);
  });

  it('should return all when no filters', async () => {
    await ensureSchema(db);
    await createTask(db, { title: 'A' });
    await createTask(db, { title: 'B' });
    expect((await listTasks(db)).length).toBe(2);
  });

  it('should expose parent_title and named blockers, not just counts', async () => {
    await ensureSchema(db);
    const pid = await createTask(db, { title: 'Pintar el living' });
    const cid = await createTask(db, { title: 'Elegir el color', parent_id: pid });
    const bid = await createTask(db, { title: 'Comprar la pintura' });
    await addDependency(db, cid, bid);

    const rows = await listTasks(db);
    const child = rows.find(r => r.id === cid);
    const parent = rows.find(r => r.id === pid);

    expect(child.parent_title).toBe('Pintar el living');
    expect(child.blocked_by).toEqual([
      { id: bid, title: 'Comprar la pintura', status: 'pending' },
    ]);
    expect(child.blocked_by_count).toBe(1);
    expect(parent.parent_title).toBeNull();
    expect(parent.subtask_count).toBe(1);
  });

  it('should separate every dependency from the ones that still block', async () => {
    await ensureSchema(db);
    const tid = await createTask(db, { title: 'Pintar el living' });
    const openId = await createTask(db, { title: 'Comprar la pintura' });
    const doneId = await createTask(db, { title: 'Elegir el color' });
    await addDependency(db, tid, openId);
    await addDependency(db, tid, doneId);
    await updateTask(db, doneId, { status: 'done' });

    const row = (await listTasks(db)).find(r => r.id === tid);

    // Both edges exist, but only one of them still blocks. A consumer asking
    // "can I start this?" must read blocked_by_open_count, not the total.
    expect(row.blocked_by_count).toBe(2);
    expect(row.blocked_by_open_count).toBe(1);
  });

  it('should report zero open blockers once every dependency is resolved', async () => {
    await ensureSchema(db);
    const tid = await createTask(db, { title: 'Mudanza' });
    const depId = await createTask(db, { title: 'Contratar el flete' });
    await addDependency(db, tid, depId);
    await updateTask(db, depId, { status: 'cancelled' });

    const row = (await listTasks(db)).find(r => r.id === tid);
    expect(row.blocked_by_count).toBe(1);
    expect(row.blocked_by_open_count).toBe(0);
  });

  // Regression: the previous implementation decorated the list with
  // `WHERE id IN (?, ?, …)` built from every returned id. D1 caps a query at
  // 100 bound parameters, so `GET /api/tasks` threw a 1101 on the live worker
  // as soon as the table passed 100 rows. No query may bind more than 100.
  it('should not exceed D1 100-bound-parameter cap with 150 tasks', async () => {
    await ensureSchema(db);

    const maxBound = { count: 0, sql: '' };
    const realPrepare = db.prepare;
    db.prepare = (sql) => {
      const stmt = realPrepare(sql);
      const realBind = stmt.bind;
      stmt.bind = (...args) => {
        if (args.length > maxBound.count) {
          maxBound.count = args.length;
          maxBound.sql = sql.replace(/\s+/g, ' ').trim().slice(0, 80);
        }
        return realBind(...args);
      };
      return stmt;
    };

    for (let i = 0; i < 150; i++) {
      await createTask(db, { title: `Tarea ${i}` });
    }
    maxBound.count = 0;

    const rows = await listTasks(db);

    expect(rows.length).toBe(150);
    expect(maxBound.count).toBeLessThanOrEqual(100);
  });
});