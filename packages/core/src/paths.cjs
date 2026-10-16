// Canonical Vidmyo home-directory resolution.
//
// Kept as CommonJS so the Electron main-process bridges (CJS) and the core
// package (ESM, via src/paths.js) share ONE implementation instead of two
// copies that can drift.
//
// `VIDMYO_HOME` is an OVERRIDE used by the test-isolation wrapper so no test
// run can touch the real `~/.vidmyo`. `HOME` is never overridden — puppeteer /
// HyperFrames caches, Homebrew FFmpeg discovery and Chrome profiles depend on
// it, and faking it would hide regressions.

'use strict';

const path = require('node:path');
const os = require('node:os');

const VIDMYO_HOME_ENV = 'VIDMYO_HOME';
const TEST_RUN_ENV = 'VIDMYO_TEST_RUN';

function vidmyoHome() {
  const override = process.env[VIDMYO_HOME_ENV];
  if (override && String(override).trim()) return path.resolve(String(override));
  return path.join(os.homedir(), '.vidmyo');
}

// Test-run provenance marker. When `VIDMYO_TEST_RUN` is set (only the
// isolated test wrapper sets it), every job record, governor lease and
// persisted publish record carries `VIDMYO_TEST_RUN=<token>` in its JSON so
// the home-isolation guard can prove that a file under the real ~/.vidmyo
// was written by a test run and not by the live app.
function testRunMarker() {
  const token = process.env[TEST_RUN_ENV];
  if (!token || !String(token).trim()) return null;
  return `${TEST_RUN_ENV}=${String(token).trim()}`;
}

module.exports = { VIDMYO_HOME_ENV, TEST_RUN_ENV, vidmyoHome, testRunMarker };
