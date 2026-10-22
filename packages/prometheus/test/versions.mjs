import metadata from '../package.json' with { type: 'json' };
import { OPENCODE_RELEASE_LINE } from '../src/compatibility.mjs';

export const serviceVersion = metadata.dependencies['@opencode/client'];
const [major, minor] = OPENCODE_RELEASE_LINE.split('.').map(Number);
export const unsupportedVersions = [
  `${major}.${minor + 1}.0`, `${major + 1}.${minor}.0`,
  `${serviceVersion}-beta.1`, `${serviceVersion}+build`,
  OPENCODE_RELEASE_LINE, `${OPENCODE_RELEASE_LINE}.02`, `v${serviceVersion}`,
  `${serviceVersion}\n`, '', undefined, null, 0,
];
