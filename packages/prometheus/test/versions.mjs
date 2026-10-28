import metadata from '../package.json' with { type: 'json' };
import { OPENCODE_MAJOR_VERSION } from '../src/compatibility.mjs';

export const serviceVersion = metadata.dependencies['@opencode/client'];
export const unsupportedVersions = [
  `${OPENCODE_MAJOR_VERSION + 1}.0.0`,
  `${serviceVersion}-beta.1`, `${serviceVersion}+build`,
  `${OPENCODE_MAJOR_VERSION}`, `${OPENCODE_MAJOR_VERSION}.02.0`, `v${serviceVersion}`,
  `${serviceVersion}\n`, '', undefined, null, 0,
];
