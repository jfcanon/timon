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
      null,
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
        .prepare(`SELECT * FROM tasks WHERE parent_id = ? AND id != ?`)
        .bind(task.parent_id, taskId)
        .all()
    : { results: [] };

  const subtasks = await db
    .prepare(`SELECT * FROM tasks WHERE parent_id = ?`)
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

  return {
    task,
    parent,
    siblings: siblings.results || [],
    subtasks: subtasks.results || [],
    blockers: blockers.results || [],
  };
}
