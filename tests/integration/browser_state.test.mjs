// Deterministic, browser-free unit tests for the secure browser state store.
// Runs under `node --test`; needs no Chromium download.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertValidName,
  normaliseOrigins,
  saveState,
  loadStateForOrigin,
  statMetadata,
  listStates,
  removeState,
  readRecord,
  sessionsDir,
  BrowserStateError,
} from "../../scripts/opencode-browser-state.mjs";

function tmpConfig() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cw-state-"));
}

const sampleState = {
  cookies: [{ name: "sid", value: "SECRET-COOKIE-VALUE", domain: "example.com", path: "/" }],
  origins: [
    {
      origin: "https://example.com",
      localStorage: [{ name: "token", value: "SECRET-LS-VALUE" }],
    },
  ],
};

test("assertValidName rejects path traversal and separators", () => {
  for (const bad of ["..", ".", "a/b", "../x", "/abs", "a\\b", "", "a b"]) {
    assert.throws(() => assertValidName(bad), BrowserStateError, `should reject ${JSON.stringify(bad)}`);
  }
  for (const ok of ["chatgpt", "site.example", "a_b-1", "A1"]) {
    assert.equal(assertValidName(ok), ok);
  }
});

test("normaliseOrigins requires https and dedupes to bare origin", () => {
  assert.deepEqual(normaliseOrigins(["https://example.com/path", "https://example.com"]), [
    "https://example.com",
  ]);
  assert.throws(() => normaliseOrigins([]), BrowserStateError);
  assert.throws(() => normaliseOrigins(["http://example.com"]), BrowserStateError);
  assert.throws(() => normaliseOrigins(["not a url"]), BrowserStateError);
});

test("saveState writes a mode-0600 record and readRecord round-trips", () => {
  const configDir = tmpConfig();
  const file = saveState({
    configDir,
    name: "chatgpt",
    origins: ["https://example.com"],
    storageState: sampleState,
    verification: { selector: "#account-menu" },
  });
  assert.ok(fs.existsSync(file));
  if (process.platform !== "win32") {
    const mode = fs.statSync(file).st_mode ?? fs.statSync(file).mode;
    assert.equal(mode & 0o777, 0o600, "record must be owner read/write only");
  }
  const rec = readRecord(configDir, "chatgpt");
  assert.equal(rec.schemaVersion, 1);
  assert.deepEqual(rec.origins, ["https://example.com"]);
  assert.equal(rec.storageState.cookies[0].value, "SECRET-COOKIE-VALUE");
  assert.deepEqual(rec.verification, { selector: "#account-menu" });
});

test("loadStateForOrigin releases state only for an approved origin", () => {
  const configDir = tmpConfig();
  saveState({
    configDir,
    name: "acct",
    origins: ["https://example.com"],
    storageState: sampleState,
    verification: { selector: "#account-menu" },
  });

  const ok = loadStateForOrigin({ configDir, name: "acct", origin: "https://example.com/somewhere" });
  assert.ok(ok, "approved origin should release state");
  assert.equal(ok.storageState.cookies[0].value, "SECRET-COOKIE-VALUE");
  assert.deepEqual(ok.verification, { selector: "#account-menu" });

  const wrong = loadStateForOrigin({ configDir, name: "acct", origin: "https://evil.example" });
  assert.equal(wrong, null, "unapproved origin must not release state");

  const missing = loadStateForOrigin({ configDir, name: "nope", origin: "https://example.com" });
  assert.equal(missing, null);
});

test("state records retain only cookies and storage for approved origins", () => {
  const configDir = tmpConfig();
  saveState({
    configDir,
    name: "acct",
    origins: ["https://example.com"],
    storageState: {
      cookies: [
        { name: "approved", value: "A", domain: ".example.com", path: "/" },
        { name: "identity-provider", value: "B", domain: "login.example.net", path: "/" },
      ],
      origins: [
        { origin: "https://example.com", localStorage: [{ name: "token", value: "A" }] },
        { origin: "https://login.example.net", localStorage: [{ name: "token", value: "B" }] },
      ],
    },
    sessionStorage: {
      "https://example.com": { token: "A" },
      "https://login.example.net": { token: "B" },
    },
  });

  const loaded = loadStateForOrigin({ configDir, name: "acct", origin: "https://example.com" });
  assert.deepEqual(loaded.storageState.cookies.map((cookie) => cookie.name), ["approved"]);
  assert.deepEqual(loaded.storageState.origins.map((entry) => entry.origin), ["https://example.com"]);
  assert.deepEqual(Object.keys(loaded.sessionStorage), ["https://example.com"]);
});

test("metadata surfaces never contain secret values", () => {
  const configDir = tmpConfig();
  saveState({ configDir, name: "acct", origins: ["https://example.com"], storageState: sampleState });

  const meta = statMetadata(configDir, "acct");
  const metaText = JSON.stringify(meta);
  assert.doesNotMatch(metaText, /SECRET-/, "status metadata must not leak state values");
  assert.deepEqual(meta.origins, ["https://example.com"]);
  assert.ok(meta.capturedAt);

  const listText = JSON.stringify(listStates(configDir));
  assert.doesNotMatch(listText, /SECRET-/, "listing must not leak state values");
});

test("removeState affects only the named record", () => {
  const configDir = tmpConfig();
  saveState({ configDir, name: "a", origins: ["https://a.example"], storageState: sampleState });
  saveState({ configDir, name: "b", origins: ["https://b.example"], storageState: sampleState });

  assert.equal(removeState(configDir, "a"), true);
  assert.equal(removeState(configDir, "a"), false, "second remove is a no-op");
  assert.equal(statMetadata(configDir, "a"), null);
  assert.ok(statMetadata(configDir, "b"), "unrelated record survives");
});

test("a symlinked sessions directory is rejected", () => {
  if (process.platform === "win32") return; // symlink perms differ on Windows CI
  const configDir = tmpConfig();
  const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), "cw-real-"));
  fs.symlinkSync(realTarget, sessionsDir(configDir));
  assert.throws(
    () => saveState({ configDir, name: "x", origins: ["https://x.example"], storageState: sampleState }),
    BrowserStateError,
  );
  assert.throws(() => listStates(configDir), BrowserStateError);
});
