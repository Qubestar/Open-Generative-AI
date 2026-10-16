#!/usr/bin/env node
// Isolated runner for the @vidmyo/core test suite (Phase 3, item 1).
//
// It guarantees that NO test run can read or write the real `~/.vidmyo`:
//
//   1. mkdtemp a private directory and set `VIDMYO_HOME` to it — every
//      default path (jobs/, exports/, governor/, artifacts/,
//      publisher-queue.json) resolves there.
//   2. set `VIDMYO_TEST_RUN=<token>` — core stamps that marker into job
//      records, governor leases and persisted publish records it writes.
//   3. `HOME` is deliberately NOT overridden: puppeteer/HyperFrames caches,
//      Homebrew FFmpeg discovery and Chrome profiles need the real home, and
//      faking it would hide regressions instead of exposing them.
//   4. snapshot the real home, run `node --test test/*.test.js` with that
//      environment, then run the guard: fail the whole run if any NEW or
//      CHANGED file under the real ~/.vidmyo/{jobs,exports,governor,artifacts}
//      or publisher-queue.json carries this run's marker — or, under
//      exports/ and artifacts/, if its name/path matches this run's temp
//      patterns (an unmarked binary would otherwise only be a note).
//
// Exit code: the test-runner code if non-zero, otherwise 3 when the guard
// found a violation, otherwise 0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runGuard, scanHome, realVidmyoHome, testRunMarker, TEMP_PATH_PATTERNS, WATCHED_DIRS, WATCHED_FILES } from './homeGuard.mjs';

const pkgRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const testDir = path.join(pkgRoot, 'test');

const token = crypto.randomUUID();
const marker = testRunMarker(token);
const realHome = realVidmyoHome();
const before = scanHome(realHome);
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-home-'));

// This run's exact temp-home name, in addition to the generic patterns.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tempPatterns = [
  ...TEMP_PATH_PATTERNS,
  new RegExp(escapeRe(path.basename(tmpHome)), 'i'),
];

const testFiles = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testDir, name));

if (testFiles.length === 0) {
  console.error(`[runIsolated] no test files found in ${testDir}`);
  process.exit(1);
}

// HOME is intentionally left untouched — see the header comment.
const env = { ...process.env, VIDMYO_HOME: tmpHome, VIDMYO_TEST_RUN: token };

console.log('[runIsolated] VIDMYO_HOME=' + tmpHome);
console.log('[runIsolated] VIDMYO_TEST_RUN=' + token);
console.log('[runIsolated] real home watched entries before run: ' + before.size);
console.log('[runIsolated] test files: ' + testFiles.length);

const startedAt = Date.now();
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: pkgRoot,
  env,
  stdio: 'inherit',
});
const durationMs = Date.now() - startedAt;
const testCode = result.error ? 1 : (result.status === null ? 1 : result.status);

const guard = runGuard({ before, marker, home: realHome, tempPatterns });

console.log('[runIsolated] ── home-isolation guard ──');
console.log('[runIsolated] watched scopes: ' + WATCHED_DIRS.map((d) => d + '/').join(', ') + ', ' + WATCHED_FILES.join(', '));
console.log('[runIsolated] marker: ' + marker);
console.log('[runIsolated] temp patterns (exports/, artifacts/): ' + tempPatterns.map((p) => String(p)).join(', '));
if (guard.violations.length) {
  console.log('[runIsolated] VIOLATIONS (' + guard.violations.length + '):');
  for (const v of guard.violations) console.log('  - ' + v.change + ' ' + v.path + (v.reason ? ` [${v.reason}]` : ''));
} else {
  console.log('[runIsolated] no marked file reached the real home, no temp-pattern file under exports/ or artifacts/');
}
const noteSample = guard.notes.slice(0, 20);
if (noteSample.length) {
  console.log('[runIsolated] unrelated differences (live app / other agents may be writing): ' + guard.notes.length);
  for (const n of noteSample) console.log('  ~ ' + n.change + ' ' + n.path);
}
console.log('[runIsolated] guard verdict: ' + (guard.ok ? 'PASS' : 'FAIL'));
console.log('[runIsolated] tests exit=' + testCode + ' duration=' + durationMs + 'ms');

try {
  fs.rmSync(tmpHome, { recursive: true, force: true });
} catch {
  // best effort — os.tmpdir is cleaned by the OS
}

process.exit(testCode || (guard.ok ? 0 : 3));
