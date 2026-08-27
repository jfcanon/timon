import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensureSchema,
  createTask,
  getTaskWithContext,
  setParent,
  addDependency,
  updateTask,
  deleteTask,
  listTasks,
} from '../src/lib/store.js';

function createMockD1() {
  const store = { tasks: [], task_events: [], dependencies: [] };
  const tableColumns = {
    tasks: ['id', 'title', 'parent_id', 'due_date', 'priority', 'category', 'created_at', 'updated_at'],
    task_events: ['id', 'ts', 'task_id', 'event_type', 'data'],
    dependencies: ['id', 'task_id', 'depends_on_id', 'created_at'],
  };

  function matchRow(row, conditions, params) {
    const p = [...params];
    for (const cond of conditions) {
      const c = cond.trim();
      if (c === '1=1') continue;
      let m;
      if ((m = c.match(/^(\w+) IS NULL$/))) {
        if (row[m[1]] !== null && row[m[1]] !== undefined) return false;
      } else if ((m = c.match(/^(\w+) IS NOT NULL$/))) {
        if (row[m[1]] === null || row[m[1]] === undefined) return false;
      } else if ((m = c.match(/^(\w+) != \?$/))) {
        if (row[m[1]] === p.shift()) return false;
      } else if ((m = c.match(/^(\w+) = \?$/))) {
        if (row[m[1]] !== p.shift()) return false;
      } else if ((m = c.match(/^(\w+) = '?([^']*)'?$/))) {
        if (row[m[1]] !== m[2]) return false;
      }
    }
    return true;
  }

  function selectRows(tableName, whereClause, params) {
    let rows = [...store[tableName]];
    if (whereClause) {
      const orParts = whereClause.split(' OR ');
      if (orParts.length > 1) {
        rows = rows.filter(row => {
          return orParts.some(part => {
            const andParts = part.replace(/^\(/, '').replace(/\)$/, '').split(' AND ');
            return matchRow(row, andParts, [...params]);
          });
        });
      } else {
        const andParts = whereClause.split(' AND ');
        rows = rows.filter(row => matchRow(row, andParts, [...params]));
      }
    }
    return rows;
  }

  function prepare(sql) {
    const norm = sql.replace(/\s+/g, ' ').trim();
    let _bound = [];

    const stmt = {
      bind(...args) { _bound = [...args]; return stmt; },
      async run() { return execute(norm, [..._bound]); },
      async all() { const r = execute(norm, [..._bound]); return { results: r._rows || [] }; },
      async first() { const r = execute(norm, [..._bound]); return (r._rows || [])[0] || null; },
    };
    return stmt;
  }

  function execute(sql, params) {
    const p = [...params];

    if (/CREATE TABLE/i.test(sql)) return {};

    if (/PRAGMA table_info/i.test(sql)) {
      const tbl = sql.match(/PRAGMA table_info\((\w+)\)/i)[1];
      return { _rows: (tableColumns[tbl] || []).map(name => ({ name })) };
    }

    if (/ALTER TABLE/i.test(sql)) {
      const m = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
      if (m && tableColumns[m[1]] && !tableColumns[m[1]].includes(m[2])) {
        tableColumns[m[1]].push(m[2]);
        store[m[1]].forEach(r => { r[m[2]] = null; });
      }
      return {};
    }

    if (/INSERT INTO/i.test(sql)) {
      const m = sql.match(/INSERT INTO (\w+) \(([^)]+)\)/i);
      const cols = m[2].split(',').map(c => c.trim());
      const row = {};
      cols.forEach((c, i) => { row[c] = p[i] !== undefined ? p[i] : null; });
      store[m[1]].push(row);
      return {};
    }

    if (/SELECT t\.\* FROM/i.test(sql)) {
      const m = sql.match(/SELECT t\.\* FROM (\w+) d JOIN (\w+) t ON d\.(\w+) = t\.(\w+) WHERE d\.(\w+) = \?/i);
      const deps = store[m[1]].filter(r => r[m[5]] === p[0]);
      const rows = deps.map(d => store[m[2]].find(r => r[m[4]] === d[m[3]])).filter(Boolean);
      return { _rows: rows };
    }

    if (/SELECT \*/i.test(sql) || /SELECT \w+(\.\w+)?(?:,\s*\w+(\.\w+)*)*\s+FROM/i.test(sql)) {
      const m = sql.match(/SELECT .+ FROM (\w+)( WHERE (.+?))?( ORDER BY (.+))?$/i);
      const tbl = m[1];
      const whereClause = m[3];
      const order = m[5];
      const rows = selectRows(tbl, whereClause, p);
      if (order && order.includes('DESC')) rows.reverse();
      return { _rows: rows };
    }

    if (/UPDATE (\w+) SET/i.test(sql)) {
      const m = sql.match(/UPDATE (\w+) SET (.+?) WHERE (.+?) = \?/i);
      const tbl = m[1];
      const setClause = m[2];
      const whereCol = m[3];
      const whereVal = p[p.length - 1];

      const rows = store[tbl].filter(r => r[whereCol] === whereVal);
      const setParts = setClause.split(',').map(s => s.trim());
      const setParams = p.slice(0, p.length - 1);

      for (const row of rows) {
        for (const part of setParts) {
          const eqMatch = part.match(/(\w+) = \?/);
          if (eqMatch) {
            row[eqMatch[1]] = setParams.shift();
          } else if (part.match(/(\w+) = NULL/i)) {
            const col = part.match(/(\w+) = NULL/i)[1];
            row[col] = null;
          }
        }
      }
      return {};
    }

    if (/DELETE FROM/i.test(sql)) {
      const m = sql.match(/DELETE FROM (\w+) WHERE (.+)/i);
      const tbl = m[1];
      const where = m[2];

      if (where.includes(' OR ')) {
        const orParts = where.split(' OR ');
        store[tbl] = store[tbl].filter(row => {
          return !orParts.some(part => {
            const eqMatch = part.trim().match(/(\w+) = \?/);
            if (eqMatch) {
              const idx = orParts.indexOf(part);
              return row[eqMatch[1]] === p[idx];
            }
            return false;
          });
        });
      } else {
        const eqMatch = where.match(/(\w+) = \?/);
        if (eqMatch) {
          const val = p[0];
          store[tbl] = store[tbl].filter(r => r[eqMatch[1]] !== val);
        }
      }
      return {};
    }

    return {};
  }

  return { prepare, _store: store, _columns: tableColumns };
}

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
});