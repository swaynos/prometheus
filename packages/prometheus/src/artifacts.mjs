import fs from 'node:fs';
import path from 'node:path';
import { atomic, canonical, hash, id, inside, localPath, requireThat } from './util.mjs';

const excluded = name => ['.git', '.opencode', 'node_modules', '.DS_Store'].includes(name) || /^\.env(?:\.|$)/.test(name);

export function manifest(directory, { beforeRead = () => {} } = {}) {
  directory = canonical(directory);
  const files = [];
  function visit(relative) {
    const current = path.join(directory, relative);
    for (const name of fs.readdirSync(current).sort()) {
      if (excluded(name)) continue;
      const rel = path.join(relative, name);
      const file = path.join(directory, rel);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(rel);
      else if (stat.isSymbolicLink()) {
        requireThat(!path.isAbsolute(fs.readlinkSync(file)), `Absolute candidate symlink: ${rel}`, 'candidate');
        requireThat(inside(directory, canonical(file)), `External candidate symlink: ${rel}`, 'candidate');
        files.push({ path: rel, type: 'symlink', target: fs.readlinkSync(file) });
      } else {
        requireThat(stat.isFile(), `Unsupported candidate entry: ${rel}`, 'candidate');
        requireThat(stat.nlink === 1, `A candidate file has multiple hardlinks: ${rel}`, 'candidate');
        beforeRead(file);
        files.push({ path: rel, type: 'file', bytes: stat.size, executable: !!(stat.mode & 0o111), hash: hash(fs.readFileSync(file)) });
      }
    }
  }
  visit('');
  return { id: hash(files), files, exclusions: ['.git', '.opencode', 'node_modules', '.env and .env.*', '.DS_Store'] };
}

// Enumerate paths without reading file contents. Native read permission must be
// established before verification hashes those contents.
export function candidatePaths(directory) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (excluded(entry.name)) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  visit(canonical(directory));
  return files;
}

export function capture(directory, destination, { afterFile } = {}) {
  const before = manifest(directory);
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const item of before.files) {
    const target = path.join(destination, item.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (item.type === 'symlink') fs.symlinkSync(item.target, target);
    else {
      const bytes = fs.readFileSync(path.join(directory, item.path));
      requireThat(hash(bytes) === item.hash, 'The candidate changed during capture.', 'candidate_changed');
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: item.executable ? 0o500 : 0o400 });
    }
    afterFile?.(item);
  }
  requireThat(manifest(directory).id === before.id && manifest(destination).id === before.id, 'The candidate changed during capture.', 'candidate_changed');
  return { ...before, directory: destination };
}

export function evidenceFile(directory, content) {
  const bytes = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  const key = id('evidence');
  const file = path.join(directory, `${key}.json`);
  atomic(file, bytes);
  return { id: key, file, hash: hash(bytes), bytes: bytes.length };
}
export function validatorIdentity(root, validator) {
  const files = validator.files.map(relative => {
    const file = localPath(canonical(root), relative);
    if (!fs.existsSync(file)) return { path: relative, hash: null };
    requireThat(fs.statSync(file).isFile(), 'A validator source path must identify a file.');
    return { path: relative, hash: hash(fs.readFileSync(file)) };
  });
  return hash({ declaration: validator, files });
}
export function checkEvidence(record) {
  requireThat(record && fs.existsSync(record.file), 'Evidence is missing.', 'evidence');
  requireThat(hash(fs.readFileSync(record.file)) === record.hash, 'Evidence changed after collection.', 'evidence');
  return record;
}
