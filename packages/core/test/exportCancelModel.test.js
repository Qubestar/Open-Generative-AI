import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  newExportJobId,
  isJobCancelled,
  exportOutcome,
} from '../../studio/src/exportCancelModel.mjs';

test('newExportJobId generates valid JobStore job identifiers matching /^job_[\\w-]+$/', () => {
  const pattern = /^job_[\w-]+$/;

  for (let i = 0; i < 20; i++) {
    const defaultId = newExportJobId();
    assert.match(defaultId, pattern, `Default ID ${defaultId} must match pattern`);

    const customId = newExportJobId('cartoon');
    assert.match(customId, pattern, `Custom ID ${customId} must match pattern`);
    assert.ok(customId.startsWith('job_cartoon_'));

    const alreadyPrefixed = newExportJobId('job_screen');
    assert.match(alreadyPrefixed, pattern, `Already-prefixed ID ${alreadyPrefixed} must match pattern`);
    assert.ok(!alreadyPrefixed.startsWith('job_job_'));
  }
});

test('isJobCancelled correctly identifies cancelled payloads', () => {
  assert.equal(isJobCancelled(null), false);
  assert.equal(isJobCancelled(undefined), false);
  assert.equal(isJobCancelled({ ok: true }), false);
  assert.equal(isJobCancelled({ ok: false, error: 'FFmpeg failed with code 1' }), false);

  assert.equal(isJobCancelled({ cancelled: true }), true);
  assert.equal(isJobCancelled({ canceled: true }), true);
  assert.equal(isJobCancelled({ state: 'cancelled' }), true);
  assert.equal(isJobCancelled({ ok: false, error: 'Job was cancelled' }), true);
  assert.equal(isJobCancelled({ ok: false, message: 'Process cancelled' }), true);
  assert.equal(isJobCancelled({ ok: false, error: 'Anulowano przez użytkownika' }), true);
});

test('exportOutcome formats done, cancelled and error states with uniform labels', () => {
  // 1. Success / Done
  const doneRes = {
    ok: true,
    outputPath: '/path/to/export.mp4',
    jobId: 'job_123',
    encoder: { name: 'h264_videotoolbox' },
  };
  const doneOutcome = exportOutcome(doneRes);
  assert.equal(doneOutcome.state, 'done');
  assert.equal(doneOutcome.label, 'Gotowe');
  assert.equal(doneOutcome.ok, true);
  assert.equal(doneOutcome.cancelled, false);
  assert.equal(doneOutcome.outputPath, '/path/to/export.mp4');

  // 2. Cancelled
  const cancelRes = {
    ok: false,
    cancelled: true,
    jobId: 'job_cancel_456',
  };
  const cancelOutcome = exportOutcome(cancelRes);
  assert.equal(cancelOutcome.state, 'cancelled');
  assert.equal(cancelOutcome.label, 'Anulowano');
  assert.equal(cancelOutcome.ok, false);
  assert.equal(cancelOutcome.cancelled, true);

  // 3. Error
  const errRes = {
    ok: false,
    error: 'Brak kodeka h264',
    jobId: 'job_err_789',
  };
  const errOutcome = exportOutcome(errRes);
  assert.equal(errOutcome.state, 'error');
  assert.equal(errOutcome.label, 'Błąd: Brak kodeka h264');
  assert.equal(errOutcome.ok, false);
  assert.equal(errOutcome.cancelled, false);

  // 4. Missing / null response
  const nullOutcome = exportOutcome(null);
  assert.equal(nullOutcome.state, 'error');
  assert.match(nullOutcome.label, /^Błąd:/);
});

test('CartoonStudio source wires newExportJobId, cancel button, and Anulowano status', () => {
  const panelPath = fileURLToPath(
    new URL('../../../packages/studio/src/components/CartoonStudio.jsx', import.meta.url),
  );
  const source = fs.readFileSync(panelPath, 'utf8');

  assert.match(
    source,
    /import \{ newExportJobId, exportOutcome \} from "\.\.\/exportCancelModel\.mjs";/,
    'CartoonStudio must import exportCancelModel'
  );
  assert.match(source, /const jobId = newExportJobId\("cartoon"\);/);
  assert.match(source, /promo\.renderCartoonExport\(\{ edg, renderer, jobId \}\)/);
  assert.match(source, /data-testid="cancel-cartoon-export"/);
  assert.match(source, /data-testid="export-status"/);
  assert.match(source, /setExportStatus\("Anulowano"\)/);
});

test('PromoReviewStudio source wires cancel and Anulowano status for promo', () => {
  const panelPath = fileURLToPath(
    new URL('../../../packages/studio/src/components/PromoReviewStudio.jsx', import.meta.url),
  );
  const source = fs.readFileSync(panelPath, 'utf8');

  assert.match(
    source,
    /import \{ newExportJobId, isJobCancelled, exportOutcome \} from "\.\.\/exportCancelModel\.mjs";/,
    'PromoReviewStudio must import exportCancelModel'
  );
  assert.match(source, /const jobId = newExportJobId\("promo"\);/);
  assert.match(source, /setRenderMessage\("Anulowano"\)/);
});

test('ScreenStudio source wires cancel and Anulowano status for screen studio', () => {
  const panelPath = fileURLToPath(
    new URL('../../../packages/studio/src/components/ScreenStudio.jsx', import.meta.url),
  );
  const source = fs.readFileSync(panelPath, 'utf8');

  assert.match(source, /const jobId = newExportJobId\("screen_studio"\);/);
  assert.match(source, /data-testid="cancel-screen-studio-export"/);
  assert.match(source, /setDemoStatus\("Anulowano"\)/);
  // Real-capture branch builds the EDG in main, then renders with the same jobId
  // used for cancel, and reports cancellation through exportOutcome ("Anulowano").
  assert.match(source, /window\.screenStudio\.buildEdg\(\{/);
  assert.match(source, /edgId: edgRes\.edgId/);
  assert.match(source, /exportOutcome\(\{ \.\.\.res, jobId \}\)/);
});
