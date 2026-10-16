// Phase 3 review fix 1: unsupported EDG features must be visible in the
// Promo/Review export outcome — success AND error — the same way
// CartoonStudio already reports them.
//
// Covers:
//   * the pure message builder (promoExportModel.mjs)
//   * the PromoReviewStudio wiring (source assertions, same pattern as the
//     AutoEditorPanel source test in autoEditorBridge.test.js)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  promoRenderOutcome,
  promoUnsupportedList,
  promoUnsupportedNote,
  unsupportedFeatureNames,
} from '../../studio/src/promoExportModel.mjs';

test('unsupportedFeatureNames normalises strings, {feature}, {name}, holes and non-arrays', () => {
  assert.deepEqual(unsupportedFeatureNames(undefined), []);
  assert.deepEqual(unsupportedFeatureNames(null), []);
  assert.deepEqual(unsupportedFeatureNames('zoom'), []);
  assert.deepEqual(unsupportedFeatureNames([]), []);
  assert.deepEqual(
    unsupportedFeatureNames([
      'speedlines',
      { feature: 'crossfade' },
      { name: 'kenBurns' },
      { id: 'mouthSamples' },
      null,
      '',
      { other: 'ignored' },
      '  zoom  ',
    ]),
    ['speedlines', 'crossfade', 'kenBurns', 'mouthSamples', 'zoom'],
  );
});

test('promoUnsupportedList reports the count and stays null when nothing is unsupported', () => {
  assert.equal(promoUnsupportedList(undefined), null);
  assert.equal(promoUnsupportedList([]), null);
  assert.deepEqual(promoUnsupportedList([{ feature: 'a' }, { feature: 'b' }]), {
    count: 2,
    features: ['a', 'b'],
  });
});

test('promoUnsupportedNote is empty without features and lists count + names otherwise', () => {
  assert.equal(promoUnsupportedNote(null), '');
  assert.equal(promoUnsupportedNote([]), '');
  const note = promoUnsupportedNote(['crossfade', 'zoom']);
  assert.match(note, /\(2\)/);
  assert.match(note, /crossfade/);
  assert.match(note, /zoom/);
});

test('successful outcome keeps the base message and appends every skipped feature', () => {
  const outcome = promoRenderOutcome({
    ok: true,
    successMessage: 'Sukces! Wyeksportowano wideo: /tmp/out.mp4 · napisy: overlay-png',
    errorMessage: 'Błąd renderu: unused',
    unsupported: [{ feature: 'crossfade' }, { feature: 'zoom' }],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.hasUnsupported, true);
  assert.equal(outcome.unsupportedCount, 2);
  assert.deepEqual(outcome.unsupported, ['crossfade', 'zoom']);
  assert.ok(outcome.message.startsWith('Sukces! Wyeksportowano wideo: /tmp/out.mp4'));
  assert.match(outcome.message, /nieobsługiwane cechy EDG \(2\): crossfade, zoom/);
});

test('failed outcome reports the skipped features instead of a bare error', () => {
  const outcome = promoRenderOutcome({
    ok: false,
    successMessage: 'unused',
    errorMessage: 'Błąd renderu: FFmpeg export failed with code 1',
    unsupported: ['audioTrackClip'],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.unsupportedCount, 1);
  assert.ok(outcome.message.startsWith('Błąd renderu: FFmpeg export failed with code 1'));
  assert.match(outcome.message, /nieobsługiwane cechy EDG \(1\): audioTrackClip/);
});

test('outcome without unsupported features is unchanged from the previous behaviour', () => {
  const ok = promoRenderOutcome({
    ok: true,
    successMessage: 'Sukces! Wyeksportowano wideo: /tmp/out.mp4',
    errorMessage: 'Błąd renderu: x',
  });
  assert.equal(ok.message, 'Sukces! Wyeksportowano wideo: /tmp/out.mp4');
  assert.equal(ok.hasUnsupported, false);
  assert.deepEqual(ok.unsupported, []);

  const fail = promoRenderOutcome({
    ok: false,
    successMessage: 'unused',
    errorMessage: 'Błąd renderu: nope',
    unsupported: [],
  });
  assert.equal(fail.message, 'Błąd renderu: nope');
});

test('PromoReviewStudio reports unsupported features on success and on error', () => {
  const panelPath = fileURLToPath(
    new URL('../../../packages/studio/src/components/PromoReviewStudio.jsx', import.meta.url),
  );
  const source = fs.readFileSync(panelPath, 'utf8');

  assert.match(
    source,
    /import \{ promoRenderOutcome \} from "\.\.\/promoExportModel\.mjs";/,
    'panel must import the shared outcome builder',
  );

  const outcomeCalls = source.match(/promoRenderOutcome\(\{/g) || [];
  assert.ok(
    outcomeCalls.length >= 4,
    `expected success + error handling in both export handlers, found ${outcomeCalls.length} promoRenderOutcome calls`,
  );

  // Both payload shapes the bridge can return must be read.
  assert.match(source, /res\.unsupported \?\? res\.result\?\.unsupported/);
  assert.match(source, /err\.unsupported/);

  // The features are surfaced in the message and as a dedicated warning block.
  assert.match(source, /setRenderUnsupported\(outcome\.unsupported\)/);
  assert.match(source, /data-testid="render-unsupported"/);
  assert.ok(
    source.includes('Sukces! Wyeksportowano wideo:'),
    'success message must be preserved',
  );

  // Silence is not an option on the error path either.
  const errorBranch = source.slice(source.indexOf('errorMessage: `Błąd renderu:'));
  assert.ok(errorBranch.length > 0, 'error branch must build its message through promoRenderOutcome');
});

test('PromoReviewStudio can cancel a running export through the existing IPC', () => {
  const panelPath = fileURLToPath(
    new URL('../../../packages/studio/src/components/PromoReviewStudio.jsx', import.meta.url),
  );
  const source = fs.readFileSync(panelPath, 'utf8');
  assert.match(source, /window\.promo\?\.cancelRenderExport/);
  assert.match(source, /data-testid="cancel-render-export"/);
  // The client supplies the job id up front so cancel has something to target.
  assert.match(source, /jobId,\n\s+}\);/, 'renderExport must receive the client-generated jobId');
});
