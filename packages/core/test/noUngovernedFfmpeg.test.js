// Phase 4 Static Guard: Ensures no ungoverned FFmpeg spawns exist in export paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CORE_SRC = path.resolve(import.meta.dirname, '../src');
const ELECTRON_LIB = path.resolve(import.meta.dirname, '../../../electron/lib');

/**
 * Strict allowlist matching INVENTORY §3.
 * Every direct child_process execution call across in-scope modules must match
 * an explicit entry here. Any unknown call immediately fails the guard test.
 */
export const ALLOWLIST_EXCEPTIONS = [
  {
    file: 'governedProcess.js',
    fn: 'spawnImpl',
    pattern: /child\s*=\s*spawnImpl\(cmd,\s*args,/,
    reason: 'Core runner implementation runGovernedProcess / runGovernedFfmpeg',
  },
  {
    file: 'ffmpegCapabilities.js',
    fn: 'spawnSyncImpl',
    pattern: /spawnSyncImpl\(resolved,\s*\['-version'\]/,
    reason: 'Probing FFmpeg version (-version)',
  },
  {
    file: 'ffmpegCapabilities.js',
    fn: 'spawnSyncImpl',
    pattern: /spawnSyncImpl\(resolved,\s*\['-filters'\]/,
    reason: 'Probing FFmpeg filters (-filters)',
  },
  {
    file: 'ffmpegCapabilities.js',
    fn: 'spawnSyncImpl',
    pattern: /spawnSyncImpl\(resolved,\s*\['-hide_banner',\s*'-encoders'\]/,
    reason: 'Probing FFmpeg encoders (-encoders)',
  },
  {
    file: 'screenStudio.js',
    fn: 'spawnImpl',
    pattern: /proc\s*=\s*spawnImpl\(binary,\s*\['-f',\s*'avfoundation',\s*'-list_devices'/,
    reason: 'AVFoundation device enumeration (listAvfoundationCaptureDevices)',
  },
  {
    file: 'screenStudio.js',
    fn: 'spawnImpl',
    pattern: /const\s+proc\s*=\s*spawnImpl\(binary,\s*args\)/,
    reason: 'AVFoundation active capture session (startAvfoundationCapture)',
  },
  {
    file: 'avatarStudio.js',
    fn: 'spawnSync',
    pattern: /const\s+proc\s*=\s*spawnSync\(binary,\s*\[/,
    reason: 'Synchronous audio envelope fallback (extractAudioEnvelope)',
  },
  {
    file: 'rendererAdapter.js',
    fn: 'spawnSync',
    pattern: /const\s+probe\s*=\s*spawnSync\(process\.platform\s*===\s*'win32'\s*\?\s*'where'\s*:\s*'which',\s*\['ffmpeg'\]/,
    reason: 'System binary discovery which/where ffmpeg',
  },
  {
    file: 'rendererAdapter.js',
    fn: 'spawnSync',
    pattern: /const\s+probe\s*=\s*spawnSync\(process\.platform\s*===\s*'win32'\s*\?\s*'where'\s*:\s*'which',\s*\['ffprobe'\]/,
    reason: 'System binary discovery which/where ffprobe',
  },
  {
    file: 'rendererAdapter.js',
    fn: 'spawnSync',
    pattern: /const\s+result\s*=\s*spawnSync\(chrome,\s*\[/,
    reason: 'Chrome subtitle rasterizer overlay fallback (rasterizeCaptionPng)',
  },
  {
    file: 'rendererAdapter.js',
    fn: 'spawnSync',
    pattern: /const\s+proc\s*=\s*spawnSync\(this\.ffprobePath,\s*\[/,
    reason: 'FFprobe metadata probe (probeMedia)',
  },
  {
    file: 'rendererAdapter.js',
    fn: 'spawnSync',
    pattern: /const\s+proc\s*=\s*spawnSync\(this\.ffmpegPath,\s*\['-filters'\]/,
    reason: 'FFmpeg filter probe (hasFilter)',
  },
  {
    file: 'screenCapture.js',
    fn: 'spawnImpl',
    pattern: /child\s*=\s*spawnImpl\(binary,\s*args,/,
    reason: 'Governed active screen capture session in screenCapture.js',
  },
];

const SCAN_TARGETS = [
  { dir: CORE_SRC, file: 'governedProcess.js' },
  { dir: CORE_SRC, file: 'ffmpegCapabilities.js' },
  { dir: CORE_SRC, file: 'screenStudio.js' },
  { dir: CORE_SRC, file: 'screenCapture.js' },
  { dir: CORE_SRC, file: 'avatarStudio.js' },
  { dir: CORE_SRC, file: 'rendererAdapter.js' },
  { dir: ELECTRON_LIB, file: 'promoBridge.js' },
  { dir: ELECTRON_LIB, file: 'autoEditorBridge.js' },
  { dir: ELECTRON_LIB, file: 'screenStudioBridge.js' },
  { dir: ELECTRON_LIB, file: 'enginesBridge.js' },
];

test('static guard scans all process spawn/exec calls against INVENTORY allowlist', () => {
  const callRegex = /(?:^|[^a-zA-Z0-9_$])(spawn|spawnSync|execFile|execFileSync|exec|execSync|spawnImpl|spawnSyncImpl)\s*\(/g;
  const matchedExceptions = new Set();
  const violations = [];

  for (const target of SCAN_TARGETS) {
    const fullPath = path.join(target.dir, target.file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      // Skip imports/destructuring like `import { spawn } from 'node:child_process';`
      // or `spawnImpl = spawn`
      if (/import\s+.*from\s+['"]node:child_process['"]/.test(line)) continue;
      if (/require\(['"]child_process['"]\)/.test(line)) continue;
      if (/spawnImpl\s*=\s*spawn/.test(line) || /spawnSyncImpl\s*=\s*spawnSync/.test(line)) continue;

      callRegex.lastIndex = 0;
      let match;
      while ((match = callRegex.exec(line)) !== null) {
        const fnName = match[1];
        // Grab context (current line + next 3 lines) to match multi-line invocations
        const context = lines.slice(lineIdx, lineIdx + 4).join('\n');

        // Look for matching entry in ALLOWLIST_EXCEPTIONS
        const found = ALLOWLIST_EXCEPTIONS.find(
          (ex) => ex.file === target.file && ex.fn === fnName && ex.pattern.test(context)
        );

        if (found) {
          matchedExceptions.add(found);
        } else {
          violations.push({
            file: target.file,
            line: lineIdx + 1,
            fn: fnName,
            text: line.trim(),
          });
        }
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `Ungoverned child_process calls detected outside allowlist: ${JSON.stringify(violations, null, 2)}`
  );

  // Ensure every allowlist exception is actually used (no stale or dead allowlist entries)
  assert.equal(
    matchedExceptions.size,
    ALLOWLIST_EXCEPTIONS.length,
    `Some ALLOWLIST_EXCEPTIONS were not found in source code: ${
      ALLOWLIST_EXCEPTIONS.filter((e) => !matchedExceptions.has(e)).map((e) => `${e.file}:${e.fn}`).join(', ')
    }`
  );
});

test('rendererAdapter uses runGovernedFfmpeg and no raw spawn for exports', () => {
  const content = fs.readFileSync(path.join(CORE_SRC, 'rendererAdapter.js'), 'utf8');

  // Must import and invoke runGovernedFfmpeg
  assert.ok(content.includes('runGovernedFfmpeg'), 'rendererAdapter must use runGovernedFfmpeg');
  assert.ok(content.includes('selectH264Encoder'), 'rendererAdapter must use selectH264Encoder');

  // Must not have raw child_process spawn() calls
  const rawSpawnCalls = content.match(/\bspawn\s*\(/g);
  assert.equal(rawSpawnCalls, null, 'rendererAdapter must not have raw spawn() calls');

  // _runFfmpeg must route through runGovernedFfmpeg
  assert.ok(
    content.includes('runGovernedFfmpeg({'),
    '_runFfmpeg must invoke runGovernedFfmpeg'
  );
});

test('screenStudio uses runGovernedFfmpeg for renderScreenStudioExport and selectH264Encoder', () => {
  const content = fs.readFileSync(path.join(CORE_SRC, 'screenStudio.js'), 'utf8');

  assert.ok(content.includes('runGovernedFfmpeg'), 'screenStudio must import runGovernedFfmpeg');
  assert.ok(content.includes('selectH264Encoder'), 'screenStudio must use selectH264Encoder');

  const fnIndex = content.indexOf('function renderScreenStudioExport');
  assert.ok(fnIndex !== -1, 'renderScreenStudioExport must exist');
  const fnBody = content.slice(fnIndex);

  assert.ok(
    fnBody.includes('runGovernedFfmpeg('),
    'renderScreenStudioExport must use runGovernedFfmpeg'
  );
  assert.ok(
    !fnBody.includes('spawn('),
    'renderScreenStudioExport must not use raw spawn'
  );
});

test('avatarStudio uses runGovernedFfmpeg for render2dMascotVideo and selectH264Encoder', () => {
  const content = fs.readFileSync(path.join(CORE_SRC, 'avatarStudio.js'), 'utf8');

  assert.ok(content.includes('runGovernedFfmpeg'), 'avatarStudio must import runGovernedFfmpeg');
  assert.ok(content.includes('selectH264Encoder'), 'avatarStudio must use selectH264Encoder');

  const fnIndex = content.indexOf('function render2dMascotVideo');
  assert.ok(fnIndex !== -1, 'render2dMascotVideo must exist');
  const fnBody = content.slice(fnIndex);

  assert.ok(
    fnBody.includes('runGovernedFfmpeg('),
    'render2dMascotVideo must use runGovernedFfmpeg'
  );
  assert.ok(
    !fnBody.includes('spawn('),
    'render2dMascotVideo must not use raw spawn'
  );
});

test('electron bridges (promoBridge, autoEditorBridge) contain no direct child_process calls', () => {
  const promoContent = fs.readFileSync(path.join(ELECTRON_LIB, 'promoBridge.js'), 'utf8');
  assert.ok(
    !promoContent.includes('child_process'),
    'promoBridge must not import or require child_process'
  );

  const autoEditorContent = fs.readFileSync(path.join(ELECTRON_LIB, 'autoEditorBridge.js'), 'utf8');
  assert.ok(
    !autoEditorContent.includes('child_process'),
    'autoEditorBridge must not import or require child_process'
  );
});

test('bridges pass governor and signal to export calls', () => {
  const promoContent = fs.readFileSync(path.join(ELECTRON_LIB, 'promoBridge.js'), 'utf8');
  assert.ok(
    promoContent.includes('governor: store.governor') && promoContent.includes('signal: controller.signal'),
    'promoBridge must pass governor and signal to renderExport'
  );
  assert.ok(
    promoContent.includes('promo:render-screen-studio-export') && promoContent.includes('renderScreenStudioExport'),
    'promoBridge must wire renderScreenStudioExport'
  );

  const autoEditorContent = fs.readFileSync(path.join(ELECTRON_LIB, 'autoEditorBridge.js'), 'utf8');
  assert.ok(
    autoEditorContent.includes('autoEditor:render-preview') && autoEditorContent.includes('autoEditor:cancel-preview'),
    'autoEditorBridge must have render-preview and cancel-preview handlers'
  );
  assert.ok(
    autoEditorContent.includes('signal: controller.signal'),
    'autoEditorBridge must pass signal to preview render'
  );
});
