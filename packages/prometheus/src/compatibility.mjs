import metadata from '../package.json' with { type: 'json' };
import { requireThat } from './util.mjs';

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const OPENCODE_MAJOR_VERSION = metadata.prometheus?.openCodeMajorVersion;
requireThat(Number.isSafeInteger(OPENCODE_MAJOR_VERSION) && OPENCODE_MAJOR_VERSION >= 0,
  'The package must declare a stable OpenCode major version.');
export const OPENCODE_MINIMUM_VERSION = metadata.prometheus.minimumOpenCodeVersion;
export const OPENCODE_VERSION_LABEL = `>=${OPENCODE_MINIMUM_VERSION} <${OPENCODE_MAJOR_VERSION + 1}.0.0`;

export function supportsOpenCodeVersion(version, majorVersion = OPENCODE_MAJOR_VERSION) {
  const match = typeof version === 'string' && stableVersionPattern.exec(version);
  if (!match || match[0] !== version || match[1] !== String(majorVersion)) return false;
  const minimum = OPENCODE_MINIMUM_VERSION.split('.').map(Number);
  const actual = match.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

export function requireOpenCodeVersion(version) {
  requireThat(supportsOpenCodeVersion(version),
    `Prometheus supports stable OpenCode ${OPENCODE_VERSION_LABEL}. The current service reports ${version}.`);
}
