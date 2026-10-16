// Home-isolation guard for the Vidmyo core test suite (Phase 3, item 1).
//
// The suite runs with `VIDMYO_HOME` pointed at a private mkdtemp directory
// (see runIsolated.mjs), so every default path — jobs/, exports/, governor/,
// artifacts/, publisher-queue.json — resolves into that directory instead of
// the real `~/.vidmyo`.
//
// This module is the safety net that proves it: it snapshots the real home
// before the run and fails afterwards on any NEW or CHANGED file under the
// watched scopes whose contents carry the run's fixture marker
// `VIDMYO_TEST_RUN=<token>`.
//
// Second rule (review R4): a new/changed file under `exports/` or
// `artifacts/` whose NAME or PATH matches this run's temp patterns is also a
// violation, marker or not — a binary written by a leaking test would never
// contain the marker, and no live export can look like a test temp file.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const TEST_RUN_ENV = 'VIDMYO_TEST_RUN';
export const WATCHED_DIRS = ['jobs', 'exports', 'governor', 'artifacts'];
export const WATCHED_FILES = ['publisher-queue.json'];

// Scopes where an unmarked binary would otherwise be reported as a note only.
export const TEMP_PATTERN_DIRS = ['exports', 'artifacts'];

// This run's temp shapes. `vidmyo-home-*` is the mkdtemp prefix of the
// isolated runner's private VIDMYO_HOME; the marker string must never appear
// in a path either. Callers may pass additional patterns (runIsolated adds the
// exact basename of its temp home).
export const TEMP_PATH_PATTERNS = [
  /vidmyo-home-/i,
  new RegExp(TEST_RUN_ENV),
];

// Everything else (the live app or another agent may legitimately be writing
// in the real home) is reported as a note only.

// Largest file we read whole when looking for the marker.
const MAX_READ_BYTES = 4 * 1024 * 1024;

export function realVidmyoHome() {
  return path.join(os.homedir(), '.vidmyo');
}

export function testRunMarker(token) {
  if (!token || !String(token).trim()) return null;
  return `${TEST_RUN_ENV}=${String(token).trim()}`;
}

function statEntry(full) {
  try {
    const st = fs.lstatSync(full);
    return { mtimeMs: Math.round(st.mtimeMs), size: st.size, dir: st.isDirectory() };
  } catch {
    return null;
  }
}

// Map of `relative/path` -> { mtimeMs, size, dir } for every entry under the
// watched scopes of `home`.
export function scanHome(home = realVidmyoHome()) {
  const map = new Map();
  if (!fs.existsSync(home)) return map;

  for (const dirName of WATCHED_DIRS) {
    const root = path.join(home, dirName);
    if (!fs.existsSync(root)) continue;
    const walk = (dir, prefix) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : `${dirName}/${entry.name}`;
        const full = path.join(dir, entry.name);
        const meta = statEntry(full);
        if (meta) map.set(rel, meta);
        if (entry.isDirectory()) walk(full, rel);
      }
    };
    walk(root, dirName);
  }

  for (const fileName of WATCHED_FILES) {
    const meta = statEntry(path.join(home, fileName));
    if (meta) map.set(fileName, meta);
  }
  return map;
}

function readForMarker(full, size) {
  try {
    if (size > MAX_READ_BYTES) {
      const fd = fs.openSync(full, 'r');
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES);
        const read = fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0);
        return buf.subarray(0, read).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Returns the matching pattern (as a string) when `rel` is a file under
 * `exports/` or `artifacts/` whose name/path looks like this run's temp
 * output, otherwise null.
 */
export function isTempPatternPath(rel, tempPatterns = TEMP_PATH_PATTERNS) {
  const scope = rel.split('/')[0];
  if (!TEMP_PATTERN_DIRS.includes(scope)) return null;
  for (const pattern of tempPatterns) {
    if (pattern.test(rel)) return String(pattern);
  }
  return null;
}

/**
 * Compare a `before` snapshot with the current state of `home`.
 *
 * Fails on:
 *   1. entries that are new/changed AND carry the fixture marker, and
 *   2. new/changed files under `exports/` or `artifacts/` whose relative path
 *      matches `tempPatterns` (a leaked test artifact carries no marker).
 * Everything else stays a note — the live app writes there legitimately.
 */
export function runGuard({
  before,
  marker,
  home = realVidmyoHome(),
  tempPatterns = TEMP_PATH_PATTERNS,
}) {
  const after = scanHome(home);
  const violations = [];
  const notes = [];

  for (const [rel, meta] of after) {
    const prev = before.get(rel);
    const changed = !prev || prev.mtimeMs !== meta.mtimeMs || prev.size !== meta.size;
    if (!changed) continue;
    // Directory metadata alone is never proof of a test write (children are
    // scanned separately); only file contents carry the marker.
    if (meta.dir) {
      notes.push({ path: rel, change: prev ? 'dir-modified' : 'dir-created' });
      continue;
    }
    const change = prev ? 'modified' : 'created';
    const tempHit = isTempPatternPath(rel, tempPatterns);
    if (tempHit) {
      violations.push({ path: rel, change, reason: 'temp-pattern', pattern: tempHit });
      continue;
    }
    const text = readForMarker(path.join(home, rel), meta.size);
    const hit = Boolean(marker && text && text.includes(marker));
    if (hit) violations.push({ path: rel, change, marker, reason: 'marker' });
    else notes.push({ path: rel, change });
  }

  for (const rel of before.keys()) {
    if (!after.has(rel)) notes.push({ path: rel, change: 'removed' });
  }

  return { ok: violations.length === 0, violations, notes, marker: marker || null, home };
}
