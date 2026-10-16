import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanerBriefSummary, cleanerSetupError, sourceTimeForPlayback } from '../../studio/src/cleanerModel.mjs';

test('edited preview highlight maps across removed intervals on the source clock', () => {
  const ranges = [[2, 5], [8, 10], [29.146, 30.966]];
  assert.equal(sourceTimeForPlayback('source', 4, ranges), 4);
  assert.equal(sourceTimeForPlayback('edited', 0, ranges), 2);
  assert.equal(sourceTimeForPlayback('edited', 3, ranges), 8);
  assert.equal(sourceTimeForPlayback('edited', 5, ranges), 29.146);
  assert.equal(sourceTimeForPlayback('edited', 100, ranges), 30.966);
  assert.equal(sourceTimeForPlayback('edited', -1, ranges), 2);
});

test('Cleaner summary turns the intake into one compact edit brief', () => {
  assert.equal(cleanerBriefSummary({
    scriptMode: 'freestyle', includeMp4: true, saveMode: 'downloads',
    providerMode: 'agent', providerName: 'OpenAI Codex',
  }), 'Freestyle · Clean MP4 + review plan · Downloads · OpenAI Codex');
});

test('Cleaner setup validation requires conditional script and provider answers', () => {
  const base = {
    sourcePath: '/tmp/take.mp4', scriptMode: 'exact', scriptText: '', includeMp4: true,
    saveMode: 'downloads', customOutputDir: '', providerMode: 'agent', providerId: 'codex', model: '',
  };
  assert.match(cleanerSetupError(base), /Paste the script/);
  assert.equal(cleanerSetupError({ ...base, scriptText: 'Hello world' }), null);
  assert.match(cleanerSetupError({ ...base, scriptText: 'Hello', providerMode: 'api', providerId: 'openrouter', model: '' }), /model id/);
});
