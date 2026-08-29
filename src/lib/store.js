async function columnExists(db, tableName, columnName) {
  const stmt = db.prepare(`PRAGMA table_info(${tableName})`);
  const { results } = await stmt.all();
  return results.some(col => col.name === columnName);
}

export async function ensureSchema(db) {
  await db
    .prepare(
      `
    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `
    )
    .run();

  await db
    .prepare(
      `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      parent_id TEXT,
      due_date TEXT,
      priority TEXT DEFAULT 'medium',
      category TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
    )
    .run();

  await db
    .prepare(
      `
    CREATE TABLE IF NOT EXISTS dependencies (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      depends_on_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `
    )
    .run();

  // Migration: add missing columns if they don't exist
  if (!(await columnExists(db, 'tasks', 'status'))) {
    await db.prepare(`ALTER TABLE tasks ADD COLUMN status TEXT DEFAULT 'pending'`).run();
  }
  if (!(await columnExists(db, 'tasks', 'completed_at'))) {
    await db.prepare(`ALTER TABLE tasks ADD COLUMN completed_at TEXT`).run();
  }
}

export async function createTask(db, intent, userId = "owner", deviceId = null) {
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `
    INSERT INTO tasks (id, title, parent_id, due_date, priority, category, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .bind(
      taskId,
      intent.title,
      intent.parent_id || null,
      intent.date,
      intent.priority,
      intent.category,
      now,
      now
    )
    .run();

  const eventData = { ...intent };
  if (deviceId) eventData.device_id = deviceId;

  await db
    .prepare(
      `
    INSERT INTO task_events (id, ts, task_id, event_type, data)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .bind(crypto.randomUUID(), now, taskId, "created", JSON.stringify(eventData))
    .run();

  return taskId;
}

export async function getTaskWithContext(db, taskId) {
  const task = await db
    .prepare(`SELECT * FROM tasks WHERE id = ?`)
    .bind(taskId)
    .first();

  if (!task) return null;

  const parent = task.parent_id
    ? await db
        .prepare(`SELECT * FROM tasks WHERE id = ?`)
        .bind(task.parent_id)
        .first()
    : null;

  const siblings = task.parent_id
    ? await db
        .prepare(`SELECT * FROM tasks WHERE parent_id = ? AND id != ? ORDER BY priority DESC, due_date ASC`)
        .bind(task.parent_id, taskId)
        .all()
    : { results: [] };

  const subtasks = await db
    .prepare(`SELECT * FROM tasks WHERE parent_id = ? ORDER BY priority DESC, due_date ASC`)
    .bind(taskId)
    .all();

  const blockers = await db
    .prepare(
      `
    SELECT t.* FROM dependencies d
    JOIN tasks t ON d.depends_on_id = t.id
    WHERE d.task_id = ?
  `
    )
    .bind(taskId)
    .all();

  const blocks = await db
    .prepare(
      `
    SELECT t.* FROM dependencies d
    JOIN tasks t ON d.task_id = t.id
    WHERE d.depends_on_id = ?
  `
    )
    .bind(taskId)
    .all();

  return {
    task,
    parent,
    siblings: siblings.results || [],
    subtasks: subtasks.results || [],
    blockers: blockers.results || [],
    blocks: blocks.results || [],
  };
}

export async function setParent(db, taskId, parentId) {
  // Check if setting parent to self
  if (taskId === parentId) {
    throw new Error("cannot set parent to self");
  }

  // Check for cycles: traverse up from parentId to see if taskId is ancestor
  let current = parentId;
  while (current) {
    if (current === taskId) {
      throw new Error("cycle detected");
    }
    const parent = await db
      .prepare(`SELECT parent_id FROM tasks WHERE id = ?`)
      .bind(current)
      .first();
    current = parent?.parent_id;
  }

  const now = new Date().toISOString();
  await db
    .prepare(`UPDATE tasks SET parent_id = ?, updated_at = ? WHERE id = ?`)
    .bind(parentId, now, taskId)
    .run();

  // Append event
  await db
    .prepare(
      `
    INSERT INTO task_events (id, ts, task_id, event_type, data)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .bind(
      crypto.randomUUID(),
      now,
      taskId,
      "parent_changed",
      JSON.stringify({ parent_id: parentId })
    )
    .run();
}

export async function addDependency(db, taskId, dependsOnId) {
  if (taskId === dependsOnId) {
    throw new Error("cannot depend on self");
  }

  // Check for cycles: BFS from dependsOnId to see if taskId is reachable
  const visited = new Set();
  const queue = [dependsOnId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === taskId) {
      throw new Error("dependency cycle detected");
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const deps = await db
      .prepare(`SELECT depends_on_id FROM dependencies WHERE task_id = ?`)
      .bind(current)
      .all();
    for (const dep of deps.results || []) {
      queue.push(dep.depends_on_id);
    }
  }

  const now = new Date().toISOString();
  // Check if dependency already exists
  const existing = await db
    .prepare(`SELECT id FROM dependencies WHERE task_id = ? AND depends_on_id = ?`)
    .bind(taskId, dependsOnId)
    .first();
  if (!existing) {
    await db
      .prepare(
        `
      INSERT INTO dependencies (id, task_id, depends_on_id, created_at)
      VALUES (?, ?, ?, ?)
    `
      )
      .bind(crypto.randomUUID(), taskId, dependsOnId, now)
      .run();

    // Append event
    await db
      .prepare(
        `
      INSERT INTO task_events (id, ts, task_id, event_type, data)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .bind(
        crypto.randomUUID(),
        now,
        taskId,
        "dependency_added",
        JSON.stringify({ depends_on_id: dependsOnId })
      )
      .run();
  }
}

export async function updateTask(db, taskId, updates) {
  const now = new Date().toISOString();
  const setClauses = [];
  const values = [];
  for (const [key, value] of Object.entries(updates)) {
    if (["title", "parent_id", "due_date", "priority", "category", "status", "completed_at"].includes(key)) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (setClauses.length === 0) return;

  setClauses.push("updated_at = ?");
  values.push(now, taskId);

  await db
    .prepare(`UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  // Append event
  await db
    .prepare(
      `
    INSERT INTO task_events (id, ts, task_id, event_type, data)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .bind(
      crypto.randomUUID(),
      now,
      taskId,
      "updated",
      JSON.stringify(updates)
    )
    .run();
}

export async function deleteTask(db, taskId) {
  const now = new Date().toISOString();

  // Re-parent children to null
  await db
    .prepare(`UPDATE tasks SET parent_id = NULL, updated_at = ? WHERE parent_id = ?`)
    .bind(now, taskId)
    .run();

  // Delete dependencies where task is blocker or blocked
  await db.prepare(`DELETE FROM dependencies WHERE task_id = ? OR depends_on_id = ?`).bind(taskId, taskId).run();

  // Delete the task itself
  await db.prepare(`DELETE FROM tasks WHERE id = ?`).bind(taskId).run();

  // Append event (before deletion, but we already deleted the task; we can still write event with taskId)
  await db
    .prepare(
      `
    INSERT INTO task_events (id, ts, task_id, event_type, data)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .bind(crypto.randomUUID(), now, taskId, "deleted", JSON.stringify({}))
    .run();
}

export async function listTasks(db, { status, category, parent_id } = {}) {
  let sql = `SELECT * FROM tasks WHERE 1=1`;
  const params = [];
  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  }
  if (category) {
    sql += ` AND category = ?`;
    params.push(category);
  }
  if (parent_id !== undefined) {
    if (parent_id === null) {
      sql += ` AND parent_id IS NULL`;
    } else {
      sql += ` AND parent_id = ?`;
      params.push(parent_id);
    }
  }
  sql += ` ORDER BY created_at DESC`;

  const { results } = await db.prepare(sql).bind(...params).all();
  const tasks = results || [];

  if (tasks.length === 0) return [];

  return decorateTasks(db, tasks);
}

// Decoration adds the context a list card needs without a second round-trip:
// the parent's title (inline breadcrumb), how many subtasks hang off the row,
// and WHICH tasks block it — not just how many.
//
// ⚠ Both lookups take ZERO bound parameters on purpose. The previous version
// built `WHERE id IN (?, ?, …)` from the result ids, and D1 caps a query at
// **100 bound parameters** — so `GET /api/tasks` started throwing a 1101 the
// moment the table passed 100 rows (verified live 2026-08-29: unfiltered and
// `?status=pending` both 500, `?status=done` with 0 rows returned fine).
// Reading the small index tables whole and aggregating in JS cannot break on
// size again.
//
// The index read is deliberately NOT skipped when the caller was unfiltered,
// even though those rows would serve. That shortcut would make correctness
// depend on "unfiltered result == the whole table" — an invariant the LIMIT +
// cursor this endpoint still needs would silently break, dropping parents and
// blockers with no error. Row count remains the next wall to hit here; see the
// scale note in docs/CONTRACT.md.
async function decorateTasks(db, tasks) {
  const indexRows =
    (await db.prepare(`SELECT id, title, parent_id, status FROM tasks`).all())
      .results || [];
  const depRows =
    (await db.prepare(`SELECT task_id, depends_on_id FROM dependencies`).all())
      .results || [];

  const byId = new Map();
  const subtaskCounts = new Map();
  for (const row of indexRows) {
    byId.set(row.id, row);
    if (row.parent_id) {
      subtaskCounts.set(row.parent_id, (subtaskCounts.get(row.parent_id) || 0) + 1);
    }
  }

  const blockersByTask = new Map();
  for (const dep of depRows) {
    const blocker = byId.get(dep.depends_on_id);
    if (!blocker) continue; // dangling edge — the blocker row is gone
    const list = blockersByTask.get(dep.task_id) || [];
    list.push({ id: blocker.id, title: blocker.title, status: blocker.status || null });
    blockersByTask.set(dep.task_id, list);
  }

  return tasks.map((task) => {
    const blockedBy = blockersByTask.get(task.id) || [];
    const parent = task.parent_id ? byId.get(task.parent_id) : null;
    return {
      ...task,
      parent_title: parent ? parent.title : null,
      subtask_count: subtaskCounts.get(task.id) || 0,
      blocked_by: blockedBy,
      // Two different questions, so two different fields. `blocked_by_count`
      // is every dependency edge (unchanged, pre-existing semantics);
      // `blocked_by_open_count` is how many still block, which is what the UI
      // acts on. A task whose dependencies are all done reports count 2 and
      // open_count 0 — consumers deciding "can I start this?" want the latter.
      blocked_by_count: blockedBy.length,
      blocked_by_open_count: blockedBy.filter((b) => !isResolved(b.status))
        .length,
    };
  });
}

/** A done or cancelled dependency no longer blocks anything. */
function isResolved(status) {
  return status === "done" || status === "cancelled";
}
