#!/usr/bin/env node
// Check links in tracked and non-ignored Markdown without reading private files.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function safeFile(directory, name) {
  const absolute = path.resolve(directory, name);
  const relative = path.relative(directory, absolute);
  if (relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  if (parts.some(part => part === '.git' || part === 'node_modules' || part === 'private' ||
      part === '.prometheus-local' || part === 'proxies.txt' ||
      (part.startsWith('.env') && part !== '.env.example'))) return false;
  let current = directory;
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try { info = fs.lstatSync(current); } catch { return false; }
    if (info.isSymbolicLink()) return false;
  }
  return fs.lstatSync(absolute).isFile();
}

function withoutFences(text) {
  let fence;
  return text.split('\n').map(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      return '';
    }
    return fence ? '' : line;
  });
}

export function headingIDs(text) {
  const counts = new Map(), ids = new Set();
  for (const line of withoutFences(text)) {
    const heading = line.match(/^#{1,6}\s+(.*?)\s*#*$/);
    if (!heading) continue;
    const base = heading[1].toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    ids.add(count ? `${base}-${count}` : base);
  }
  return ids;
}

export function localLinkIssues(directory, name, text) {
  const issues = [];
  withoutFences(text).forEach((line, index) => {
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const destination = match[1];
      if (/^(?:https?:|mailto:)/.test(destination)) continue;
      const [target, anchor] = destination.split('#');
      let decoded, fragment;
      try { decoded = decodeURIComponent(target); fragment = anchor && decodeURIComponent(anchor); }
      catch { issues.push({ line: index + 1, message: 'invalid link encoding' }); continue; }
      const resolved = target ? path.normalize(path.join(path.dirname(name), decoded)) : name;
      if (!safeFile(directory, resolved)) {
        issues.push({ line: index + 1, message: `missing or unsafe local link: ${destination}` });
      } else if (fragment) {
        if (!resolved.endsWith('.md')) {
          issues.push({ line: index + 1, message: `section target must be project Markdown: ${destination}` });
        } else if (!headingIDs(fs.readFileSync(path.join(directory, resolved), 'utf8')).has(fragment)) {
          issues.push({ line: index + 1, message: `missing section: ${destination}` });
        }
      }
    }
  });
  return issues;
}

export function checkLinks(directory = root) {
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'], { cwd: directory })
    .toString('utf8').split('\0').filter(Boolean);
  return [...new Set(names)].flatMap(name => {
    if (!safeFile(directory, name)) return [{ path: name, line: 1, message: 'not a regular file or has symlink ancestors' }];
    return localLinkIssues(directory, name, fs.readFileSync(path.join(directory, name), 'utf8'))
      .map(issue => ({ path: name, ...issue }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = checkLinks();
  for (const issue of issues) console.error(`${issue.path}:${issue.line}: ${issue.message}`);
  console.log(`Documentation links: ${issues.length} issue(s).`);
  process.exitCode = issues.length ? 1 : 0;
}
