import metadata from '../package.json' with { type: 'json' };
import { requireThat } from './util.mjs';

const releaseLinePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const OPENCODE_RELEASE_LINE = metadata.prometheus?.openCodeReleaseLine;
requireThat(typeof OPENCODE_RELEASE_LINE === 'string' && releaseLinePattern.exec(OPENCODE_RELEASE_LINE)?.[0] === OPENCODE_RELEASE_LINE,
  'The package must declare a stable OpenCode major.minor release line.');
export const OPENCODE_VERSION_LABEL = `${OPENCODE_RELEASE_LINE}.x`;

export function supportsOpenCodeVersion(version, releaseLine = OPENCODE_RELEASE_LINE) {
  const match = typeof version === 'string' && stableVersionPattern.exec(version);
  return !!match && match[0] === version && `${match[1]}.${match[2]}` === releaseLine;
}

export function requireOpenCodeVersion(version) {
  requireThat(supportsOpenCodeVersion(version),
    `Prometheus supports stable OpenCode ${OPENCODE_VERSION_LABEL}. The current service reports ${version}.`);
}
