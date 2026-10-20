# Export feature agreement

## Outcome

Add CSV export to the existing Node CLI and library. Preserve JSON as the default.

## Scope and authority

Change this fixture's library, CLI, tests, and README as necessary.
Use Node built-ins. Do not install dependencies, access the network, deploy, publish, commit, or change governing configuration.
Do not change this agreement or acceptance meaning.

## Acceptance

1. `node bin/export.mjs --input FILE` retains JSON output with one final LF.
2. `--format json` selects the same output. `--format csv` selects CSV. Either option order works.
3. Input is a JSON array of plain objects. Values are strings, finite numbers, booleans, or null. Missing object keys are allowed.
4. CSV headers follow first appearance of each key across all rows. Preserve row order. Emit an empty string for an empty array.
5. Use commas and CRLF records, including the final CSV record. Quote fields that contain a comma, quote, CR, or LF. Double embedded quotes.
6. Missing values and null become empty CSV fields. Other scalar values use their string representation.
7. Invalid JSON, invalid row/value types, missing or duplicate options, unknown options, unknown formats, and missing input files return exit code 2 with a useful stderr message and no stdout.
8. The input file remains unchanged. Existing JSON checks remain meaningful and pass.
9. `exportRows(rows, { format })` provides the same format selection. The library throws on invalid input or format.
10. Add a documented `node validate.mjs --candidate DIRECTORY` procedure. It checks the agreed behavior against another fixture copy without writing that copy. It returns zero for a conforming implementation and nonzero for a relevant defect.

## Delivery

Deliver the fixture changes and runnable validation. Report known limitations honestly.
When the selected outcome is explicitly validator-only, deliver `validate.mjs` and its supporting test files. Leave product code unchanged. The incomplete product can correctly fail validation.
