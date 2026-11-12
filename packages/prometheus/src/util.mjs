import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const id = (prefix = 'item') => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
export const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function requireThat(condition, message, code = 'invalid') {
  if (!condition) throw Object.assign(new Error(message), { code });
}
export const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

// Resolve existing ancestors so a missing leaf cannot bypass a symlink boundary.
export function canonical(file) {
  file = path.resolve(file);
  try { return fs.realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(canonical(parent), path.basename(file));
  }
}
