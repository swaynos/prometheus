import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { withRegistryLock } from './opencode-browser-sessions.mjs';

// A missing ledger is never implicitly created: initialization is an explicit
// administrative operation, separate from an MCP solve.
const bad = () => new Error('budget storage unavailable');
function directory(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || typeof process.getuid !== 'function') throw bad();
  const real = fs.realpathSync(dir), st = fs.lstatSync(dir);
  if (real !== dir || !st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw bad();
  for (let p = real; ; p = path.dirname(p)) {
    const parent = fs.lstatSync(p);
    if (!parent.isDirectory() || (parent.uid !== 0 && parent.uid !== process.getuid()) || ((parent.mode & 0o022) && !(parent.mode & 0o1000))) throw bad();
    if (fs.existsSync(path.join(p, '.git')) || (fs.existsSync(path.join(p, 'HEAD')) && fs.existsSync(path.join(p, 'objects')))) throw bad();
    if (p === path.dirname(p)) break;
  }
  return real;
}
const file = dir => path.join(dir, 'captcha-budget.json');
function read(dir) {
  const fd = fs.openSync(file(dir), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 4_000_000) throw bad();
    const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const keys = (obj, expected) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).sort().join(',') === expected;
    if (!keys(data, 'entries,lastDay,version') || data.version !== 1 || !/^\d{4}-\d\d-\d\d$/.test(data.lastDay) || !Array.isArray(data.entries) || data.entries.some(e => !keys(e, 'actual,day,estimate,id') || !/^[a-f0-9]{64}$/.test(e.id) || !/^\d{4}-\d\d-\d\d$/.test(e.day) || e.day > data.lastDay || !Number.isSafeInteger(e.estimate) || e.estimate < 1 || !(e.actual === null || Number.isSafeInteger(e.actual) && e.actual >= 0)) || new Set(data.entries.map(e => e.id)).size !== data.entries.length) throw bad();
    return data;
  } finally { fs.closeSync(fd); }
}
function write(dir, data) {
  const tmp = path.join(dir, `.captcha-budget-${randomBytes(16).toString('hex')}`);
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file(dir));
    const d = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch {} }
}
export async function initializeBudget(dir) {
  dir = directory(dir);
  return withRegistryLock(dir, () => {
    const fd = fs.openSync(file(dir), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, lastDay: new Date().toISOString().slice(0, 10), entries: [] })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const d = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  });
}
export async function reserveBudget(dir, { id, estimate, dailyTasks, lifetimeTasks, dailyMicros, lifetimeMicros, signal }) {
  try {
    dir = directory(dir);
    if (!/^[a-f0-9]{64}$/.test(id) || ![estimate, dailyTasks, lifetimeTasks, dailyMicros, lifetimeMicros].every(n => Number.isSafeInteger(n) && n > 0)) return false;
    return await withRegistryLock(dir, () => {
      if (signal?.aborted) return false;
      const data = read(dir), day = new Date().toISOString().slice(0, 10);
      // A reservation is durably unresolved before any billable dispatch.
      // Until its actual receipt is persisted (or explicitly reconciled),
      // even a different task cannot spend: a lost/failed receipt may exceed
      // every estimate and the condition must survive process restart.
      if (day < data.lastDay || data.entries.some(e => e.id === id || e.actual === null)) return false;
      const today = data.entries.filter(e => e.day === day);
      const total = list => list.reduce((n, e) => n + Math.max(e.estimate, e.actual ?? 0), 0);
      if (data.entries.length >= lifetimeTasks || today.length >= dailyTasks || total(data.entries) + estimate > lifetimeMicros || total(today) + estimate > dailyMicros || signal?.aborted) return false;
      data.lastDay = day; data.entries.push({ id, day, estimate, actual: null }); write(dir, data); return true;
    }, { timeoutMs: 1000 });
  } catch { return false; }
}
export async function settleBudget(dir, id, actual) {
  if (!Number.isSafeInteger(actual) || actual < 0) return false;
  try {
    dir = directory(dir);
    return await withRegistryLock(dir, () => {
      const data = read(dir), entry = data.entries.find(e => e.id === id);
      if (!entry || entry.actual !== null && entry.actual !== actual) return false;
      entry.actual = actual; write(dir, data); return true;
    }, { timeoutMs: 1000 });
  } catch { return false; }
}
