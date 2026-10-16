// Static guard: the Screen Studio UI may only call methods that preload.js
// actually exposes, and preload must not expose unhandled IPC channels.
// Phase 5 review feedback (items 1 and 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const preloadPath = path.join(repoRoot, 'electron', 'preload.js');
const bridgePath = path.join(repoRoot, 'electron', 'lib', 'screenStudioBridge.js');
const uiPath = path.join(repoRoot, 'packages', 'studio', 'src', 'components', 'ScreenStudio.jsx');

function extractScreenStudioBlock(source) {
  const start = source.indexOf('exposeInMainWorld(\'screenStudio\'');
  assert.ok(start >= 0, 'preload must expose window.screenStudio');
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error('unterminated screenStudio block');
}

test('preload exposes buildEdg and does not expose the unhandled cursorSample channel', () => {
  const preload = fs.readFileSync(preloadPath, 'utf8');
  const block = extractScreenStudioBlock(preload);

  assert.match(block, /buildEdg:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\('screen:build-edg'/, 'preload must expose buildEdg -> screen:build-edg');
  assert.doesNotMatch(block, /cursorSample/, 'preload must not expose cursorSample (no handler in the bridge)');

  const bridge = fs.readFileSync(bridgePath, 'utf8');
  assert.doesNotMatch(bridge, /'screen:cursor-sample'/, 'bridge must not register an unhandled screen:cursor-sample channel');
});

test('every window.screenStudio method used by the ScreenStudio UI is exposed by preload', () => {
  const preload = fs.readFileSync(preloadPath, 'utf8');
  const block = extractScreenStudioBlock(preload);
  const ui = fs.readFileSync(uiPath, 'utf8');

  const used = new Set();
  const regex = /window\.screenStudio(?:\?)?\.([A-Za-z0-9_]+)/g;
  let match;
  while ((match = regex.exec(ui)) !== null) used.add(match[1]);

  assert.ok(used.size >= 8, `expected the UI to reference several bridge methods, saw ${[...used].join(', ')}`);
  for (const method of used) {
    if (method === 'isElectron') continue;
    assert.match(
      block,
      new RegExp(`\\b${method}\\s*:`),
      `preload must expose window.screenStudio.${method} (used by ScreenStudio.jsx)`,
    );
  }

  // The export flow must build an EDG before rendering (review item 1).
  assert.match(ui, /buildEdg\(/, 'ScreenStudio.jsx must call buildEdg before renderExport');
});

test('bridge -> UI list-sources contract: audioDevices, native system audio, no BlackHole/window list', () => {
  const bridge = fs.readFileSync(bridgePath, 'utf8');
  const ui = fs.readFileSync(uiPath, 'utf8');

  // 1. The bridge returns microphone/audio list under `audioDevices`.
  assert.match(bridge, /audioDevices:/, 'bridge screen:list-sources must return the audio list as `audioDevices`');
  // 2. The UI must consume `audioDevices` (reading only `audio` left the mic
  //    select permanently empty in the real app).
  assert.match(ui, /sourcesRes\.audioDevices/, 'ScreenStudio.jsx must read sourcesRes.audioDevices');

  // 3. System audio comes from ScreenCaptureKit: the bridge reports support and
  //    the UI sends a boolean — no loopback driver (BlackHole) and no disabled
  //    window list confusing the user.
  assert.match(bridge, /systemAudioSupported:\s*true/, 'bridge must report native system audio support');
  assert.match(ui, /systemAudio:\s*state\.sources\.systemAudioSupported/, 'UI must send a systemAudio boolean');
  assert.match(ui, /data-testid="system-audio-toggle"/, 'UI must render the system audio toggle');
  assert.doesNotMatch(bridge + ui, /blackhole/i, 'BlackHole must not be mentioned to users');
  assert.doesNotMatch(ui, /data-testid="window-list"/, 'the disabled window list must be gone');
});
