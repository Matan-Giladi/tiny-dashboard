'use strict';

//   DASHBOARD_DB   path to the database file (default: data/dashboard.db;
//                  ':memory:' for tests)
//
// On first start the table is empty, so it is seeded from data/services.json
// after validating that file with the service schema.
//

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { serviceSchema, servicesFileSchema } = require('./schema');
const logger = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SEED_FILE = path.join(DATA_DIR, 'services.json');
const DB_FILE = process.env.DASHBOARD_DB || path.join(DATA_DIR, 'dashboard.db');

const SORTABLE = new Set(['name', 'owner', 'status', 'updated_at']);

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS services (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    owner      TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'maintenance')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`);

const insert = db.prepare('INSERT INTO services (name, owner, status) VALUES (@name, @owner, @status)');
const selectOne = db.prepare('SELECT * FROM services WHERE id = ?');
const update = db.prepare(`
  UPDATE services
     SET name = @name, owner = @owner, status = @status,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = @id
`);
const remove = db.prepare('DELETE FROM services WHERE id = ?');
const count = db.prepare('SELECT COUNT(*) AS n FROM services');

function seedIfEmpty() {
  if (count.get().n > 0 || !fs.existsSync(SEED_FILE)) return;
  const services = servicesFileSchema.parse(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
  db.transaction(() => {
    for (const s of services) insert.run(s);
  })();
  logger.info({ file: SEED_FILE, count: services.length, db: DB_FILE }, 'seeded services table');
}

seedIfEmpty();

function listServices({ q = '', status = '', sort = 'name', order = 'asc' } = {}) {
  const where = [];
  const params = {};
  if (q) {
    where.push(`(name LIKE @q ESCAPE '\\' OR owner LIKE @q ESCAPE '\\')`);
    params.q = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  }
  if (status) {
    where.push('status = @status');
    params.status = status;
  }
  const column = SORTABLE.has(sort) ? sort : 'name';
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  const sql = `SELECT * FROM services
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${column} COLLATE NOCASE ${direction}, id ASC`;
  return db.prepare(sql).all(params);
}

function getService(id) {
  return selectOne.get(id) || null;
}

function createService(input) {
  const data = serviceSchema.parse(input);
  try {
    const info = insert.run(data);
    return getService(info.lastInsertRowid);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ConflictError(`a service named "${data.name}" already exists`);
    throw err;
  }
}

function updateService(id, input) {
  const data = serviceSchema.parse(input);
  try {
    const info = update.run({ ...data, id });
    return info.changes ? getService(id) : null;
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ConflictError(`a service named "${data.name}" already exists`);
    throw err;
  }
}

function deleteService(id) {
  return remove.run(id).changes > 0;
}

// Kept for callers that predate filtering/sorting.
function loadServices() {
  return listServices();
}

module.exports = {
  ConflictError,
  listServices,
  getService,
  createService,
  updateService,
  deleteService,
  loadServices
};
