#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { requireThat } from './util.mjs';

// Historical records remain readable. This interface cannot grant authority or resume work.
const [operation, directory, taskID] = process.argv.slice(2);
let database;
try {
  requireThat(operation === 'inspect' && directory, 'Use inspect LEGACY_DIRECTORY [TASK]. Legacy grants and execution are retired.');
  const file = path.join(directory, 'prometheus.sqlite');
  requireThat(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'Identify an existing legacy database file.');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
    const { Database } = await import('bun:sqlite');
    database = new Database(file, { readonly: true });
  }
  const query = taskID ? database.prepare('SELECT kind,id,data FROM records WHERE id=?') : database.prepare('SELECT kind,id,data FROM records');
  const records = taskID ? query.all(taskID) : query.all();
  console.log(JSON.stringify({ legacy: true, resumed: false, records: records.map(record => ({ ...record, data: JSON.parse(record.data) })) }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { database?.close(); }
