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

// Resolve existing ancestors too. A missing leaf must not bypass a symlink boundary.
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
export function privateDirectory(directory) {
  directory = path.resolve(directory);
  for (let current = directory; ; current = path.dirname(current)) {
    if (fs.existsSync(current)) requireThat(!fs.lstatSync(current).isSymbolicLink(), `Symlinked private path: ${current}`);
    if (path.dirname(current) === current) break;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  requireThat((fs.statSync(directory).mode & 0o077) === 0, 'The private directory permits access by another user.');
  return fs.realpathSync(directory);
}
export function atomic(file, bytes, { replace = false } = {}) {
  const temp = `${file}.${id('tmp')}`;
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    if (replace) fs.renameSync(temp, file);
    else { fs.linkSync(temp, file); fs.unlinkSync(temp); }
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function localPath(root, value, { protectedPaths = [], write = false } = {}) {
  requireThat(typeof value === 'string' && value.length > 0, 'A path is required.');
  const file = canonical(path.resolve(root, value));
  requireThat(inside(root, file), 'The path is outside the authorized directory.', 'boundary');
  const relative = path.relative(root, file).split(path.sep);
  requireThat(!relative.some(part => /^\.env(?:\.|$)/.test(part)), 'Credential files are not model-readable.', 'boundary');
  if (write) {
    requireThat(!relative.some(part => ['.git', '.opencode', 'AGENTS.md', 'SPEC.md'].includes(part)), 'The path is protected.', 'boundary');
    requireThat(!protectedPaths.some(p => inside(canonical(p), file)), 'The path contains protected control data.', 'boundary');
  }
  return file;
}
export const errorText = error => error instanceof Error ? error.message : String(error);
