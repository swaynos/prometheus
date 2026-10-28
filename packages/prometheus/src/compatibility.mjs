import metadata from '../package.json' with { type: 'json' };
import { requireThat } from './util.mjs';

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const OPENCODE_MAJOR_VERSION = metadata.prometheus?.openCodeMajorVersion;
requireThat(Number.isSafeInteger(OPENCODE_MAJOR_VERSION) && OPENCODE_MAJOR_VERSION >= 0,
  'The package must declare a stable OpenCode major version.');
export const OPENCODE_VERSION_LABEL = `${OPENCODE_MAJOR_VERSION}.x`;

export function supportsOpenCodeVersion(version, majorVersion = OPENCODE_MAJOR_VERSION) {
  const match = typeof version === 'string' && stableVersionPattern.exec(version);
  return !!match && match[0] === version && match[1] === String(majorVersion);
}

export function requireOpenCodeVersion(version) {
  requireThat(supportsOpenCodeVersion(version),
    `Prometheus supports stable OpenCode ${OPENCODE_VERSION_LABEL}. The current service reports ${version}.`);
}
