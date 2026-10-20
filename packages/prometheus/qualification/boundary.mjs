import fs from 'node:fs';
import path from 'node:path';
import { sandboxProfile, sandboxAvailable } from '../src/sandbox.mjs';
import { canonical, inside, localPath, requireThat } from '../src/util.mjs';

const quote = text => `'${text.replaceAll("'", "'\\''")}'`;

// Apply the same declared filesystem authority to native Build, without adding a repair loop.
export function nativeShellBoundary(event, { root, scratch, protectedPaths }) {
  requireThat(sandboxAvailable(), 'Native qualification processes require macOS sandbox-exec.');
  const cwd = canonical(event.cwd ?? root);
  requireThat(inside(root, cwd) || inside(scratch, cwd), 'A native qualification shell cannot leave its owned workspace.', 'boundary');
  requireThat(typeof event.command === 'string' && typeof event.shell === 'string' && path.isAbsolute(event.shell), 'The native shell invocation cannot be assessed.');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const profile = sandboxProfile({ readRoots: [root, scratch], writeRoots: [root, scratch], protectedPaths });
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, TMPDIR: scratch, LANG: 'en_US.UTF-8', CI: '1' };
  // env -i also prevents an outer-shell implementation from merging inherited credentials back in.
  event.command = `exec /usr/bin/env -i ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} /usr/bin/sandbox-exec -p ${quote(profile)} ${quote(event.shell)} -c ${quote(event.command)}`;
  event.env = env;
}

export function nativeFileBoundary(event, root) {
  const input = event.input ?? {};
  const write = ['write', 'edit', 'patch', 'apply_patch'].includes(event.tool);
  if (!['read', 'glob', 'grep', 'write', 'edit', 'patch', 'apply_patch'].includes(event.tool)) return;
  const paths = [input.path, input.filePath].filter(value => typeof value === 'string');
  if (event.tool === 'patch' || event.tool === 'apply_patch') {
    const patch = input.patchText ?? input.patch;
    requireThat(typeof patch === 'string', 'A native patch must expose its file paths.', 'boundary');
    for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.push(match[1]);
  }
  if (!paths.length && ['glob', 'grep'].includes(event.tool)) paths.push('.');
  requireThat(paths.length, 'The native qualification file operation cannot be assessed.', 'boundary');
  for (const file of paths) {
    localPath(root, file, { write });
    if (write) requireThat(!file.split(/[\\/]/).some(p => /^opencode\.jsonc?$/.test(p)), 'Native tools cannot change qualification configuration.', 'boundary');
  }
  if (event.tool === 'grep') requireThat(paths.every(file => fs.statSync(localPath(root, file)).isFile()),
    'Use the bounded native shell for recursive qualification searches.', 'boundary');
  if (event.tool === 'glob') requireThat(typeof input.pattern === 'string' && !path.isAbsolute(input.pattern) &&
    !input.pattern.split(/[\\/]/).includes('..'), 'The native glob leaves its workspace.', 'boundary');
}
