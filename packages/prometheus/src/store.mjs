import fs from 'node:fs';
import path from 'node:path';
import { privateDirectory, requireThat } from './util.mjs';

// OpenCode may embed Bun. Tests and the command-line inspector use Node.
let Database;
try { ({ DatabaseSync: Database } = await import('node:sqlite')); }
catch { ({ Database } = await import('bun:sqlite')); }

export class Store {
  constructor(directory, { now = Date.now } = {}) {
    this.directory = privateDirectory(directory);
    const file = path.join(this.directory, 'prometheus.sqlite');
    if (fs.existsSync(file)) requireThat(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'Unsafe database path.');
    this.db = new Database(file);
    fs.chmodSync(file, 0o600);
    this.now = now;
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(kind,id)
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY, time INTEGER NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
        event TEXT NOT NULL, data TEXT NOT NULL
      );
    `);
    const version = this.db.prepare("SELECT value FROM metadata WHERE key='schema'").get()?.value;
    requireThat(!version || version === '1', 'Unsupported Prometheus database version.');
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('schema','1')").run();
    this.depth = 0;
  }
  transaction(callback) {
    if (this.depth) return callback();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = callback();
      requireThat(!result?.then, 'A store transaction cannot contain asynchronous work.');
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  get(kind, id) {
    const row = this.db.prepare('SELECT revision,data FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? { ...JSON.parse(row.data), revision: row.revision } : undefined;
  }
  list(kind) {
    return this.db.prepare('SELECT revision,data FROM records WHERE kind=? ORDER BY rowid').all(kind)
      .map(row => ({ ...JSON.parse(row.data), revision: row.revision }));
  }
  put(kind, value, event, detail = {}) {
    return this.transaction(() => {
      const { revision, ...data } = value;
      const current = this.get(kind, value.id);
      requireThat(current?.revision === revision, 'Concurrent state change. Read the current record.', 'conflict');
      const next = (revision ?? 0) + 1;
      this.db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,data=excluded.data')
        .run(kind, value.id, next, JSON.stringify(data));
      this.db.prepare('INSERT INTO events(time,kind,id,event,data) VALUES (?,?,?,?,?)')
        .run(this.now(), kind, value.id, event, JSON.stringify(detail));
      return { ...data, revision: next };
    });
  }
  update(kind, id, callback, event, detail = {}) {
    return this.transaction(() => {
      const record = this.get(kind, id);
      requireThat(record, `Missing ${kind} record.`, 'missing');
      return this.put(kind, { ...record, ...callback(record), id }, event, detail);
    });
  }
  events(kind, id) {
    return this.db.prepare('SELECT * FROM events WHERE kind=? AND id=? ORDER BY sequence').all(kind, id)
      .map(row => ({ ...row, data: JSON.parse(row.data) }));
  }
  close() { this.db.close(); }
}
