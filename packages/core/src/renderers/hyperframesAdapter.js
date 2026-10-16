// Real HyperFrames adapter for Vidmyo V2.6 (Phase 2, item 6).
//
// Renders an HTML composition project to a real MP4 through the pinned
// `hyperframes` CLI (npm package `hyperframes`, Apache-2.0). Fail-closed:
//   - the package must be installed at exactly HYPERFRAMES_PINNED,
//   - the CLI must resolve, otherwise an exact error is thrown,
//   - renders run through runGovernedProcess (governor lease + tree cancel
//     + optional timeout) — never a bare unmanaged spawn.
//
// No production host is contacted: renders use local Chrome + local FFmpeg
// (verified by `hyperframes doctor`). Telemetry and update checks are disabled
// via environment for deterministic offline runs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGovernedProcess } from '../governedProcess.js';

export const HYPERFRAMES_PINNED = '0.8.72';
export const HYPERFRAMES_LICENSE = 'Apache-2.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function candidateRoots(explicitRoot = null) {
  // An explicit root is authoritative (test seam) — do not fall back to the
  // real node_modules, or a "missing package" test would silently resolve.
  if (explicitRoot) return [path.resolve(explicitRoot)];
  // repo root relative to packages/core/src/renderers (4 levels up)
  return [path.resolve(HERE, '../../../..'), process.cwd()];
}

/**
 * Locates the pinned hyperframes package and verifies the exact version.
 * Returns { cliPath, packageRoot, version, license }.
 * Throws an exact, actionable error when missing or version-mismatched.
 */
export function resolveHyperframesPackage({ packageRoot = null } = {}) {
  let lastErr = 'package not found in any candidate node_modules';
  for (const root of candidateRoots(packageRoot)) {
    const pkgDir = path.join(root, 'node_modules', 'hyperframes');
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      lastErr = `no hyperframes package at ${pkgDir}`;
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    } catch (err) {
      lastErr = `unreadable package.json at ${pkgJsonPath}: ${err.message}`;
      continue;
    }
    if (pkg.version !== HYPERFRAMES_PINNED) {
      throw new Error(
        `HyperFrames version mismatch: package.json pins hyperframes@${HYPERFRAMES_PINNED} but node_modules has ${pkg.version}. `
        + `Run npm install to restore the pinned version (never render with an unpinned engine).`,
      );
    }
    const cliPath = path.join(pkgDir, pkg.bin?.hyperframes || 'bin/hyperframes.mjs');
    if (!fs.existsSync(cliPath)) {
      lastErr = `CLI entry missing at ${cliPath}`;
      continue;
    }
    return {
      cliPath,
      packageRoot: pkgDir,
      version: pkg.version,
      license: pkg.license || HYPERFRAMES_LICENSE,
      // Spawned as `node <cliPath>` so no .bin symlink resolution is needed.
      command: process.execPath,
    };
  }
  throw new Error(
    `HyperFrames package 'hyperframes@${HYPERFRAMES_PINNED}' is not installed (${lastErr}). `
    + 'Install the pinned dependency before rendering; there is no fallback renderer impersonating HyperFrames.',
  );
}

/**
 * Renders an HTML composition project directory to a real MP4 via the pinned
 * HyperFrames CLI. Returns { outputPath, bytes, exitCode, version, command }.
 *
 * @param {object} opts
 * @param {string} opts.projectDir  HyperFrames project directory (contains index.html)
 * @param {string} opts.outputPath  Absolute .mp4 output path
 * @param {number} [opts.fps=30]
 * @param {string} [opts.quality='looks'] draft|looks|delivery|standard|high
 * @param {object|null} [opts.governor] ResourceGovernor — when set, a heavy
 *   lease is held for the whole render (admission before spawn, release on exit)
 * @param {string} [opts.jobId] required when governor is set
 * @param {number} [opts.timeoutMs=240000] kill the render tree after this long
 * @param {AbortSignal|null} [opts.signal] cancel the whole render process tree
 *   (HyperFrames/Chrome children included) when aborted
 * @param {string|null} [opts.packageRoot] explicit node_modules root (tests)
 */
export async function renderComposition({
  projectDir,
  outputPath,
  fps = 30,
  quality = 'looks',
  governor = null,
  jobId = null,
  timeoutMs = 240000,
  packageRoot = null,
  spawnImpl = undefined,
  signal = null,
} = {}) {
  if (!projectDir || !fs.existsSync(path.join(projectDir, 'index.html'))) {
    throw new Error(`HyperFrames render requires a project directory with index.html: ${projectDir}`);
  }
  if (!outputPath) throw new Error('HyperFrames render requires an outputPath');

  const pkg = resolveHyperframesPackage({ packageRoot });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const args = [
    pkg.cliPath,
    'render',
    path.resolve(projectDir),
    '-o', path.resolve(outputPath),
    '-f', String(fps),
    '-q', quality,
    '--quiet',
  ];

  const env = {
    ...process.env,
    HYPERFRAMES_NO_TELEMETRY: '1',
    HYPERFRAMES_NO_UPDATE_CHECK: '1',
    HYPERFRAMES_SKIP_SKILLS: '1',
  };

  // Admission-first, detached process group, timeout/tree-kill, lease released
  // only after the child's exit event (see governedProcess.js).
  await runGovernedProcess({
    jobId: jobId || `hf_render_${Date.now()}`,
    resourceClass: 'heavy',
    cmd: pkg.command,
    args,
    env,
    cwd: path.resolve(projectDir),
    governor,
    timeoutMs,
    spawnImpl,
    signal,
  });

  if (!fs.existsSync(outputPath)) {
    throw new Error(`HyperFrames render exited 0 but produced no output at ${outputPath}`);
  }
  const bytes = fs.statSync(outputPath).size;
  if (bytes <= 0) {
    throw new Error(`HyperFrames render produced an empty file at ${outputPath}`);
  }

  return {
    outputPath,
    bytes,
    exitCode: 0,
    version: pkg.version,
    command: `${pkg.command} ${args.slice(1).join(' ')}`,
    license: pkg.license,
  };
}
