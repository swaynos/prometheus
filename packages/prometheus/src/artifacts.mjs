import fs from 'node:fs';
import path from 'node:path';
import { canonical, hash, inside, requireThat } from './util.mjs';

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
        const target = fs.readlinkSync(file);
        requireThat(!path.isAbsolute(target), `Absolute candidate symlink: ${rel}`, 'candidate');
        requireThat(inside(directory, canonical(file)), `External candidate symlink: ${rel}`, 'candidate');
        files.push({ path: rel, type: 'symlink', target });
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

// Enumerate paths before reading file bytes so native read permission is checked first.
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
