# Controlled conforming export example

Run `node bin/export.mjs --input FILE [--format json|csv]`.
JSON is the default. CSV uses comma-separated fields and CRLF records.
Run `node --test test/json.test.mjs` for the retained JSON check.
Run `node validate.mjs --candidate DIRECTORY` to assess another implementation.
Validation uses owned temporary files. It does not write the candidate.
