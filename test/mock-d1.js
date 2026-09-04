export function createMockD1() {
  const store = { tasks: [], task_events: [], dependencies: [] };
  const tableColumns = {
    tasks: ['id', 'title', 'parent_id', 'due_date', 'priority', 'category', 'created_at', 'updated_at'],
    task_events: ['id', 'ts', 'task_id', 'event_type', 'data'],
    dependencies: ['id', 'task_id', 'depends_on_id', 'created_at'],
  };
  const columnDefaults = {};

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
      const m = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)(?: \w+)?(?: DEFAULT '([^']*)')?/i);
      if (m && tableColumns[m[1]] && !tableColumns[m[1]].includes(m[2])) {
        tableColumns[m[1]].push(m[2]);
        const def = m[3] !== undefined ? m[3] : null;
        columnDefaults[`${m[1]}.${m[2]}`] = def;
        store[m[1]].forEach(r => { r[m[2]] = def; });
      }
      return {};
    }

    if (/INSERT INTO/i.test(sql)) {
      const m = sql.match(/INSERT INTO (\w+) \(([^)]+)\)/i);
      const cols = m[2].split(',').map(c => c.trim());
      const row = {};
      cols.forEach((c, i) => { row[c] = p[i] !== undefined ? p[i] : null; });
      for (const c of tableColumns[m[1]] || []) {
        if (!(c in row)) row[c] = columnDefaults[`${m[1]}.${c}`] ?? null;
      }
      store[m[1]].push(row);
      return { meta: { changes: 1 } };
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
      return { meta: { changes: rows.length } };
    }

    if (/DELETE FROM/i.test(sql)) {
      const m = sql.match(/DELETE FROM (\w+) WHERE (.+)/i);
      const tbl = m[1];
      const where = m[2];
      const before = store[tbl].length;

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
        const andParts = where.split(' AND ');
        store[tbl] = store[tbl].filter(row => !matchRow(row, andParts, [...p]));
      }
      return { meta: { changes: before - store[tbl].length } };
    }

    return {};
  }

  return { prepare, _store: store, _columns: tableColumns };
}
