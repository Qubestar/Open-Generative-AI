// V2.6 Phase 5, Step 6 — navigation reachability.
//
// Fails if any top-level V2.6 feature (or any of the nine INVENTORY target
// areas) has no reachable path from the real sidebar. Dev-only `?panel=`
// routes do not count: only StandaloneShell TABS branches and SettingsModal
// entry points are accepted.
//
// The registry lives in packages/studio/src/v26Features.mjs so the audit is
// data, not prose — a feature that loses its tab or its entry marker breaks
// this test instead of silently drifting out of reach.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  V26_FEATURES,
  V26_AREA_IDS,
  SIDEBAR_TAB_IDS,
  SIDEBAR_SHELL_FILE,
  SETTINGS_FILE,
} from '../../studio/src/v26Features.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const shellSource = read(SIDEBAR_SHELL_FILE);
const settingsSource = read(SETTINGS_FILE);

// TABS entries are `{ id: 'x', label: 'y' }`.
function parseTabs(source) {
  const block = source.match(/const TABS = \[([\s\S]*?)\];/);
  assert.ok(block, 'StandaloneShell must declare a TABS array');
  return [...block[1].matchAll(/\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)]
    .map((m) => ({ id: m[1], label: m[2] }));
}
const tabs = parseTabs(shellSource);
const tabIds = tabs.map((t) => t.id);

test('the nine INVENTORY target areas are all represented in the registry', () => {
  assert.deepEqual(V26_AREA_IDS, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'areas 1..9 must each appear exactly once');
});

test('every sidebar-backed feature has a real TABS entry and a render branch (no ?panel= routes)', () => {
  for (const feature of V26_FEATURES) {
    if (!feature.sidebarTab) continue;
    assert.ok(
      tabIds.includes(feature.sidebarTab),
      `feature '${feature.id}' expects sidebar tab '${feature.sidebarTab}' in TABS (${tabIds.join(', ')})`,
    );
    const branch = new RegExp(`activeTab === '${feature.sidebarTab}'\\s*&&\\s*<`);
    assert.match(shellSource, branch, `feature '${feature.id}' tab '${feature.sidebarTab}' has no render branch`);
  }
});

test('every feature with a Settings entry point is reachable without a sidebar tab', () => {
  const settingsFeatures = V26_FEATURES.filter((f) => f.viaSettings);
  assert.ok(settingsFeatures.length > 0, 'at least model packages / FFmpeg report / HyperFrames live in Settings');
  // The shell renders SettingsModal from the header gear button.
  assert.match(shellSource, /<SettingsModal/, 'the shell must render SettingsModal');
  assert.match(shellSource, /setShowSettings\(true\)/, 'Settings must be openable from the shell');
  for (const feature of settingsFeatures) {
    assert.equal(feature.sidebarTab, null, `feature '${feature.id}' is Settings-only and must not claim a sidebar tab`);
    assert.ok(feature.clickPath.includes('Settings'), `feature '${feature.id}' click path must start in Settings`);
  }
});

test('every declared reachability marker is literally present in the code', () => {
  for (const feature of V26_FEATURES) {
    assert.ok(Array.isArray(feature.markers) && feature.markers.length > 0, `feature '${feature.id}' must declare markers`);
    for (const m of feature.markers) {
      const src = read(m.file);
      assert.ok(
        src.includes(m.pattern),
        `feature '${feature.id}': marker '${m.pattern}' missing from ${m.file} (${m.note})`,
      );
    }
  }
});

test('Engines & models surfaces the FFmpeg report, model packages, and HyperFrames pin read-only', () => {
  assert.match(settingsSource, /Engines & models/, 'Settings must label the section "Engines & models"');
  assert.match(settingsSource, /window\.promo\.ffmpegCapabilities/, 'must read the real FFmpeg capability report');
  assert.match(settingsSource, /modelPackagesStatus/, 'must read managed model package status');
  assert.match(settingsSource, /hyperframesStatus/, 'must read the HyperFrames pin status');
  // Read-only: no install/download calls are made from the section.
  assert.doesNotMatch(settingsSource, /modelPackageInstall|packageInstall|download\(/i, 'Engines section must not install or download');
});

test('Screen Studio is a first-class top-level tab, not buried in Promo', () => {
  assert.ok(tabIds.includes('screen-studio'), 'TABS must include screen-studio');
  assert.match(shellSource, /activeTab === 'screen-studio'\s*&&\s*<ScreenStudio\s*\/>/, 'Screen Studio must render its own component');
  // and the Marketing/Promo tab still exists as the Promo & UGC home.
  assert.ok(tabIds.includes('marketing'), 'TABS must include marketing');
});
