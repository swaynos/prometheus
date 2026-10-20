import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { canonical, requireThat, id, inside } from './util.mjs';

const quote = value => JSON.stringify(value);
const subpath = value => `(subpath ${quote(canonical(value))})`;
function toolchainRoots() {
  const roots = [];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(directory, 'node');
    if (fs.existsSync(file)) {
      const binary = canonical(file);
      const bin = path.dirname(binary);
      roots.push(path.basename(bin) === 'bin' ? path.dirname(bin) : bin);
      break;
    }
  }
  return roots.filter(p => p !== path.parse(p).root);
}

export function sandboxAvailable() {
  return process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
}
export function sandboxProfile({ readRoots, writeRoots, protectedPaths = [], secretPaths = protectedPaths, exceptionRoots = [], network = false }) {
  requireThat(readRoots.length, 'A sandbox read boundary is required.');
  const system = ['/System/Library', '/System/Cryptexes', '/System/DriverKit', '/usr', '/bin', '/sbin', '/Library/Apple', '/Library/Developer', '/Library/Frameworks', '/private/etc', '/private/var/db', '/dev', '/opt/homebrew'];
  const reads = [...system.filter(p => fs.existsSync(p)), ...readRoots, path.dirname(process.execPath), ...toolchainRoots()];
  return `(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read* (literal "/") ${reads.map(subpath).join(' ')})
(allow file-map-executable ${reads.map(subpath).join(' ')})
(allow file-write* ${writeRoots.map(subpath).join(' ')} (literal "/dev/null"))
(deny file-read-data (regex #${JSON.stringify('(^|/)[.]env([.]|$)')}))
(deny file-write* (regex #${JSON.stringify('(^|/)[.]env([.]|$)')}))
(deny file-write* (regex #${JSON.stringify('(^|/)([.]git|[.]opencode)(/|$)|(^|/)(AGENTS[.]md|SPEC[.]md|opencode[.]jsonc?)$')}))
${protectedPaths.map(p => {
    const exceptions = writeRoots.filter(root => exceptionRoots.includes(root) && inside(canonical(p), canonical(root)));
    const filter = exceptions.length ? `(require-all ${subpath(p)} ${exceptions.map(root => `(require-not ${subpath(root)})`).join(' ')})` : subpath(p);
    return `(deny file-write* ${filter})`;
  }).join('\n')}
${secretPaths.map(p => {
    const exceptions = readRoots.filter(root => exceptionRoots.includes(root) && inside(canonical(p), canonical(root)));
    const filter = exceptions.length ? `(require-all ${subpath(p)} ${exceptions.map(root => `(require-not ${subpath(root)})`).join(' ')})` : subpath(p);
    return `(deny file-read-data ${filter})`;
  }).join('\n')}
${network ? '(allow network*)' : ''}
`;
}

export class Runner {
  constructor({ scratchRoot, protectedPaths = [], available = sandboxAvailable, spawnProcess = spawn } = {}) {
    this.scratchRoot = scratchRoot;
    this.protectedPaths = protectedPaths;
    this.available = available;
    this.spawn = spawnProcess;
    this.active = new Map();
  }
  async run({ argv, cwd, project = cwd, readRoots = [], writable = false, network = false, signal, owner, timeoutMs = 120000, onSpawn }) {
    requireThat(Array.isArray(argv) && argv.length && argv.every(a => typeof a === 'string' && !a.includes('\0')), 'Supply a nonempty argument array.');
    requireThat(this.available(), 'A supported process boundary is unavailable. This build supports macOS sandbox-exec.', 'isolation');
    requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Supply a positive process timeout in milliseconds.');
    const scratch = path.join(this.scratchRoot, id('process'));
    fs.mkdirSync(scratch, { mode: 0o700 });
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const owned = inside(canonical(this.scratchRoot), canonical(cwd)) ||
      !writable && inside(canonical(path.join(path.dirname(this.scratchRoot), 'candidates')), canonical(cwd));
    const profile = sandboxProfile({ readRoots: [cwd, scratch, ...readRoots], writeRoots: writable ? [cwd, scratch] : [scratch],
      protectedPaths: [...this.protectedPaths, ...['.git', '.opencode', 'AGENTS.md', 'SPEC.md'].map(p => path.join(cwd, p))],
      secretPaths: [...this.protectedPaths, ...['.git', '.opencode'].map(p => path.join(cwd, p))], exceptionRoots: [scratch, ...(owned ? [cwd] : [])], network });
    const command = argv.map(a => a.replaceAll('{candidate}', cwd).replaceAll('{scratch}', scratch).replaceAll('{project}', project));
    const executable = command[0];
    signal?.throwIfAborted();
    const processToken = id('process');
    const child = this.spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, ...command.slice(1)], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, TMPDIR: scratch, LANG: 'en_US.UTF-8', CI: '1', PROMETHEUS_PROCESS_ID: processToken },
    });
    const key = id('process');
    this.active.set(key, { owner, child });
    let timer;
    let truncated = false;
    let size = 0;
    const chunks = [];
    const append = chunk => {
      // This bounds retained tool output, not execution attempts or model work.
      const remaining = Math.max(0, 1024 * 1024 - size);
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      size += chunk.length;
      truncated ||= chunk.length > remaining;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let stopSent = false;
    const stop = () => {
      if (stopSent || !Number.isSafeInteger(child.pid)) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      stopSent = true;
    };
    this.active.get(key).stop = stop;
    const aborted = () => stop();
    signal?.addEventListener('abort', aborted, { once: true });
    if (timeoutMs) timer = setTimeout(stop, timeoutMs);
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, termSignal) => resolve({ code, signal: termSignal }));
    });
    this.active.get(key).completion = completion;
    void completion.catch(() => {});
    try {
      if (child.pid) onSpawn?.({ pid: child.pid, processGroup: child.pid, processToken, host: os.hostname(), started: Date.now(), scratch });
      const result = await completion;
      stop(); // Stop the owned process group. This does not certify remote cessation.
      return { ...result, output: Buffer.concat(chunks).toString('utf8'), truncated, argv: command, scratch,
        environment: { platform: process.platform, hostRuntime: process.version, isolation: 'sandbox-exec', network, writable },
        interrupted: !!signal?.aborted || !!result.signal };
    } finally {
      stop();
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      this.active.delete(key);
    }
  }
  stop(owner) {
    for (const process of this.active.values()) if (process.owner === owner) process.stop();
  }
  async quiesce(owner) {
    const processes = [...this.active.values()].filter(p => p.owner === owner);
    this.stop(owner);
    await Promise.all(processes.map(p => p.completion));
  }
}
