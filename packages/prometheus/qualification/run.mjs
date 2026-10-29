#!/usr/bin/env node
// Do not admit old campaigns against the unrelated native /goal command.
console.error('The custom-controller campaign runner is retired. No service or model request was made. Run npm run test:native for isolated scripted checks. Real-model qualification requires a new, explicitly approved native-workflow procedure; old manifests are not accepted.');
process.exitCode = 1;
