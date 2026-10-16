import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fromTest = (...parts) => path.resolve(testDir, ...parts);
const shellSource = fs.readFileSync(fromTest('..', '..', '..', 'components', 'StandaloneShell.js'), 'utf8');
const clipperSource = fs.readFileSync(fromTest('..', '..', 'studio', 'src', 'components', 'RepurposeStudio.jsx'), 'utf8');
const cleanerSource = fs.readFileSync(fromTest('..', '..', 'studio', 'src', 'components', 'CleanerStudio.jsx'), 'utf8');
const vfxSource = fs.readFileSync(fromTest('..', '..', 'studio', 'src', 'components', 'VfxStudio.jsx'), 'utf8');

test('appearance control lives only in Settings across themes', () => {
  const settings = fs.readFileSync(fromTest('..', '..', 'studio', 'src', 'components', 'SettingsModal.jsx'), 'utf8');
  assert.doesNotMatch(shellSource, /<select/);
  assert.match(shellSource, /onAppearanceChange=\{changeAppearance\}/);
  assert.match(settings, /id="vidmyo-appearance"/);
  assert.match(settings, /APPEARANCES\.map/);
});

test('Agents workspace separates subscription claims and recovers detection/connection errors', () => {
  const agents = fs.readFileSync(fromTest('..', '..', 'studio', 'src', 'components', 'LocalAgentsStudio.jsx'), 'utf8');
  assert.match(agents, /Refresh agents/);
  assert.match(agents, /does not purchase credits or confirm subscription access/);
  assert.match(agents, /finally \{ setBusyId\(null\); \}/);
  assert.doesNotMatch(agents, /\/Volumes\/My Lexar/);
});

test('main navigation exposes Clipper and keeps the stable repurpose route', () => {
  assert.match(shellSource, /\{ id: 'repurpose', label: 'Clipper' \}/);
  assert.match(shellSource, /activeTab === 'repurpose'/);
  assert.doesNotMatch(shellSource, /label: 'Repurpose'/);
  assert.match(clipperSource, />Clipper \/ local beta</);
});

test('main navigation exposes a dedicated Cleaner route and setup studio', () => {
  assert.match(shellSource, /\{ id: 'cleaner', label: 'Cleaner' \}/);
  assert.match(shellSource, /activeTab === 'cleaner'.*<CleanerStudio/s);
  assert.match(cleanerSource, /Did you film from a script\?/);
  assert.match(cleanerSource, /Installed agent subscription/);
  assert.match(cleanerSource, /API provider/);
  assert.match(cleanerSource, /ANALYZE RECORDING/);
  assert.match(cleanerSource, /EXPORT CLEANED VIDEO/);
  assert.match(cleanerSource, /<CleanerReview/);
  assert.match(cleanerSource, /Changing the agent keeps the completed local transcript/);
  assert.match(cleanerSource, /subscription not recognized by Claude Code/);
  assert.match(cleanerSource, /if \(operationRef\.current\) return false/);
  assert.match(cleanerSource, /Cleaner stopped before analysis completed/);
  assert.match(cleanerSource, /finally \{ endOperation\(\); setProgress\(null\); \}/);
});

test('VFX lets each project use an automatic or explicit local-agent model', () => {
  assert.match(vfxSource, /Agent model/);
  assert.match(vfxSource, /Automatic \(recommended\)/);
  assert.match(vfxSource, /agentModel\.trim\(\)\|\|null/);
});

test('VFX announces completion and moves back to the rendered preview', () => {
  const css = fs.readFileSync(fromTest('..', '..', 'studio', 'src', 'components', 'VfxStudio.css'), 'utf8');
  assert.match(vfxSource, /Render finished/);
  assert.match(vfxSource, /Watch render/);
  assert.match(vfxSource, /scrollIntoView\(\{behavior:'smooth',block:'center'\}\)/);
  assert.match(vfxSource, /vfx-progress-toast/);
  assert.match(vfxSource, /onClick=\{renderPlan\}/);
  assert.match(css, /\.vfx-progress-toast,\.vfx-finished-toast\{position:fixed/);
});

test('inherited Explore Apps and Workflows are hidden from the main navigation', () => {
  assert.doesNotMatch(shellSource, /Explore Apps/);
  assert.doesNotMatch(shellSource, /<AppsStudio/);
  assert.doesNotMatch(shellSource, /slug\.includes\('apps'\)/);
  assert.doesNotMatch(shellSource, /\{ id: 'workflows', label: 'Workflows' \}/);
  assert.match(shellSource, /<WorkflowStudio/);
});

test('studio shell provides a named responsive navigation and current-page state', () => {
  assert.match(shellSource, /aria-label="Studios"/);
  assert.match(shellSource, /aria-current=\{activeTab === tab.id \? 'page' : undefined\}/);
  assert.match(shellSource, /<main className=\{styles.content\}/);
  const css = fs.readFileSync(fromTest('..', '..', '..', 'components', 'StandaloneShell.module.css'), 'utf8');
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('main navigation exposes dedicated Screen Studio and Marketing tabs', () => {
  const screenStudioSource = fs.readFileSync(fromTest('..', '..', 'studio', 'src', 'components', 'ScreenStudio.jsx'), 'utf8');
  assert.match(shellSource, /\{ id: 'marketing', label: 'Marketing' \}/);
  assert.match(shellSource, /\{ id: 'screen-studio', label: 'Screen Studio' \}/);
  assert.match(shellSource, /activeTab === 'screen-studio'.*<ScreenStudio/s);
  assert.match(screenStudioSource, /Screen Studio/);
  assert.match(screenStudioSource, /data-testid="screen-studio-panel"/);
  assert.match(screenStudioSource, /Syntetyczna Sesja Screen Studio/);
});

