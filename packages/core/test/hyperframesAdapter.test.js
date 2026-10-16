// Phase 2 Item 6 — HyperFrames adapter unit tests (pinned package, fail-closed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HYPERFRAMES_PINNED,
  HYPERFRAMES_LICENSE,
  resolveHyperframesPackage,
  renderComposition,
} from '../src/renderers/hyperframesAdapter.js';

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('resolveHyperframesPackage finds the pinned package in the repo node_modules', () => {
  const pkg = resolveHyperframesPackage();
  assert.equal(pkg.version, HYPERFRAMES_PINNED);
  assert.equal(pkg.version, '0.8.72');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(HYPERFRAMES_LICENSE, 'Apache-2.0');
  assert.ok(fs.existsSync(pkg.cliPath), `CLI must exist at ${pkg.cliPath}`);
  assert.ok(fs.existsSync(pkg.packageRoot));
});

test('resolveHyperframesPackage fails closed on a version mismatch', () => {
  const root = tempDir('vidmyo-hf-mismatch-');
  const pkgDir = path.join(root, 'node_modules', 'hyperframes');
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: 'hyperframes',
    version: '9.9.9',
    bin: { hyperframes: 'bin/hyperframes.mjs' },
  }));
  fs.writeFileSync(path.join(pkgDir, 'bin', 'hyperframes.mjs'), '// fake');

  assert.throws(
    () => resolveHyperframesPackage({ packageRoot: root }),
    /version mismatch: package\.json pins hyperframes@0\.8\.72 but node_modules has 9\.9\.9/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveHyperframesPackage fails closed when the package is missing (explicit root is authoritative)', () => {
  const root = tempDir('vidmyo-hf-missing-');
  assert.throws(
    () => resolveHyperframesPackage({ packageRoot: root }),
    /HyperFrames package 'hyperframes@0\.8\.72' is not installed/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('renderComposition refuses a project directory without index.html', async () => {
  const root = tempDir('vidmyo-hf-nohtml-');
  await assert.rejects(
    renderComposition({ projectDir: root, outputPath: path.join(root, 'out.mp4') }),
    /requires a project directory with index\.html/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('renderComposition refuses a missing outputPath', async () => {
  const root = tempDir('vidmyo-hf-noout-');
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  await assert.rejects(
    renderComposition({ projectDir: root }),
    /requires an outputPath/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});
