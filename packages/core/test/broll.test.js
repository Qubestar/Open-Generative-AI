import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractVisualIntent,
  MediaLicenseRegistry,
  matchBrollClip,
  loadBrollRegistry,
  validateBrollLicenseFields,
  DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
} from '../src/broll.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeManifest(dir, entries) {
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(entries));
}

const VALID_CLIP = {
  id: 'user_clip_ok',
  tags: ['code', 'software', 'developer'],
  shot: 'medium',
  emotion: 'neutral',
  durationSec: 4.0,
  license: 'pexels',
  author: 'Test Provider',
  fileHash: 'user_hash_0001',
  redistributionRight: true,
  source: 'https://www.pexels.com/license/',
  licenseProofUrl: 'https://www.pexels.com/license/',
};

test('extractVisualIntent correctly identifies subject, emotion, and shot type', () => {
  const intent = extractVisualIntent('Przedsiębiorca analizuje nagły spadek na giełdzie, czując silny stres i strach.');
  assert.equal(intent.emotion, 'stressed');
  assert.ok(intent.keywords.length > 0);

  const closeUpIntent = extractVisualIntent('Spójrz na to zbliżenie na wykres.');
  assert.equal(closeUpIntent.shot, 'close_up');
});

test('MediaLicenseRegistry enforces approved licences plus redistributionRight, source and proof of licence', () => {
  const registry = new MediaLicenseRegistry();

  // Unapproved licence code rejected
  assert.throws(() => {
    registry.register({
      id: 'bad_lic',
      license: 'all_rights_reserved',
      fileHash: '12345678',
      redistributionRight: true,
      source: 'somewhere',
      licenseProofUrl: 'https://example.com/licence',
    });
  }, /not approved for commercial redistribution/);

  // Free-text licence that merely contains an approved word is rejected
  assert.throws(() => {
    registry.register({
      id: 'freetext_lic',
      license: 'custom pexels-like deal',
      fileHash: '12345678',
      redistributionRight: true,
      source: 'somewhere',
      licenseProofUrl: 'https://example.com/licence',
    });
  }, /not approved for commercial redistribution/);

  // MRR/PLR stays blocked (no redistribution licence document)
  assert.throws(() => {
    registry.register({
      id: 'mrr_lic',
      license: 'commercial_mrr_plr',
      fileHash: '12345678',
      redistributionRight: true,
      source: 'mrr_pack',
      licenseProofUrl: 'https://example.com/licence',
    });
  }, /MRR\/PLR pack has no redistribution licence document/);

  // Missing redistributionRight rejected
  assert.throws(() => {
    registry.register({
      id: 'no_redist',
      license: 'cc0',
      fileHash: '12345678',
      source: 'somewhere',
      licenseProofUrl: 'https://example.com/licence',
    });
  }, /redistributionRight/);

  // Missing source rejected
  assert.throws(() => {
    registry.register({
      id: 'no_source',
      license: 'cc0',
      fileHash: '12345678',
      redistributionRight: true,
      licenseProofUrl: 'https://example.com/licence',
    });
  }, /source/);

  // Missing proof of licence rejected
  assert.throws(() => {
    registry.register({
      id: 'no_proof',
      license: 'cc0',
      fileHash: '12345678',
      redistributionRight: true,
      source: 'somewhere',
    });
  }, /proof of licence/);

  // Fully documented entry accepted
  const ok = registry.register({
    id: 'pexels_01',
    author: 'John Doe',
    source: 'https://www.pexels.com/license/',
    license: 'pexels',
    fileHash: 'abcdef0123456789',
    redistributionRight: true,
    licenseProofUrl: 'https://www.pexels.com/license/',
  });

  const check = registry.verifyCommercialEligibility('pexels_01');
  assert.ok(check.eligible);
  assert.equal(check.record.author, 'John Doe');
  assert.equal(check.record.redistributionRight, true);
  assert.equal(ok.license, 'pexels');
});

test('validateBrollLicenseFields accepts a complete entry and rejects each missing field with an exact reason', () => {
  assert.deepEqual(validateBrollLicenseFields(VALID_CLIP), { ok: true, reasons: [] });

  const noRedist = validateBrollLicenseFields({ ...VALID_CLIP, redistributionRight: false });
  assert.equal(noRedist.ok, false);
  assert.ok(noRedist.reasons.some(r => /redistributionRight/.test(r)));

  const noSource = validateBrollLicenseFields({ ...VALID_CLIP, source: '' });
  assert.equal(noSource.ok, false);
  assert.ok(noSource.reasons.some(r => /source/.test(r)));

  const noProof = validateBrollLicenseFields({
    ...VALID_CLIP,
    licenseProofUrl: undefined,
    licenseProofDoc: undefined,
  });
  assert.equal(noProof.ok, false);
  assert.ok(noProof.reasons.some(r => /proof of licence/.test(r)));

  // Document path counts as proof of licence
  const docProof = validateBrollLicenseFields({
    ...VALID_CLIP,
    licenseProofUrl: undefined,
    licenseProofDoc: 'docs/licences/pexels.txt',
  });
  assert.deepEqual(docProof, { ok: true, reasons: [] });
});

test('loadBrollRegistry accepts a fully documented manifest and rejects incomplete entries with exact reasons', () => {
  const dir = tempDir('vidmyo-broll-manifest-ok-');
  writeManifest(dir, [VALID_CLIP]);

  const accepted = loadBrollRegistry({ registryDir: dir });
  assert.equal(accepted.source, 'user_registry');
  assert.equal(accepted.clips.length, 1);
  assert.deepEqual(accepted.rejected, []);

  const mixedDir = tempDir('vidmyo-broll-manifest-mixed-');
  writeManifest(mixedDir, [
    VALID_CLIP,
    { id: 'missing_redist', fileHash: 'abcdefgh', license: 'cc0', source: 'x', licenseProofDoc: 'a/b.txt' },
    { id: 'missing_source', fileHash: 'abcdefgh', license: 'cc0', redistributionRight: true, licenseProofDoc: 'a/b.txt' },
    { id: 'missing_proof', fileHash: 'abcdefgh', license: 'cc0', redistributionRight: true, source: 'x' },
    { id: 'mrr_entry', fileHash: 'abcdefgh', license: 'commercial_mrr_plr', redistributionRight: true, source: 'x', licenseProofDoc: 'a/b.txt' },
    { id: 'freetext_entry', fileHash: 'abcdefgh', license: 'royalty-free anything', redistributionRight: true, source: 'x', licenseProofDoc: 'a/b.txt' },
  ]);

  const mixed = loadBrollRegistry({ registryDir: mixedDir });
  assert.equal(mixed.clips.length, 1);
  assert.equal(mixed.clips[0].id, 'user_clip_ok');
  assert.equal(mixed.rejected.length, 5);

  const byId = Object.fromEntries(mixed.rejected.map(r => [r.id, r.reasons]));
  assert.ok(byId.missing_redist.some(x => /redistributionRight/.test(x)));
  assert.ok(byId.missing_source.some(x => /source/.test(x)));
  assert.ok(byId.missing_proof.some(x => /proof of licence/.test(x)));
  assert.ok(byId.mrr_entry.some(x => /MRR\/PLR/.test(x)));
  assert.ok(byId.freetext_entry.some(x => /not approved for commercial redistribution/.test(x)));
});

test('loadBrollRegistry builtin CC0 sample passes its own licence validation', () => {
  const res = loadBrollRegistry();
  assert.equal(res.source, 'builtin_cc0_sample');
  assert.equal(res.rejected.length, 0);
  for (const clip of res.clips) {
    const v = validateBrollLicenseFields(clip);
    assert.equal(v.ok, true, `${clip.id}: ${v.reasons.join('; ')}`);
  }
});

test('matchBrollClip preserves original footage when score is below threshold', () => {
  const intent = {
    subject: 'astronomy',
    action: 'rocket_launch',
    emotion: 'triumphant',
    shot: 'wide',
    keywords: ['rocket', 'space', 'galaxy'],
  };

  // Weak candidates that do not match
  const weakCandidates = [
    { id: 'c1', tags: ['cooking', 'kitchen'], emotion: 'neutral', shot: 'close_up' },
    { id: 'c2', tags: ['office', 'desk'], emotion: 'neutral', shot: 'medium' },
  ];

  const result = matchBrollClip(intent, weakCandidates, { threshold: DEFAULT_MATCH_CONFIDENCE_THRESHOLD });
  assert.equal(result.action, 'preserve_original');
  assert.ok(result.confidence < DEFAULT_MATCH_CONFIDENCE_THRESHOLD);
  assert.equal(result.chosenClip, null);
  assert.ok(result.alternatives.length > 0); // alternatives available for 1-click manual swap
});

test('matchBrollClip selects top clip when confidence exceeds threshold', () => {
  const intent = {
    subject: 'space',
    action: 'launch',
    emotion: 'triumphant',
    shot: 'wide',
    keywords: ['rocket', 'space', 'galaxy'],
  };

  const goodCandidates = [
    { id: 'good_1', tags: ['rocket', 'space', 'galaxy'], emotion: 'triumphant', shot: 'wide' },
    { id: 'ok_2', tags: ['space'], emotion: 'neutral', shot: 'medium' },
  ];

  const result = matchBrollClip(intent, goodCandidates, { threshold: DEFAULT_MATCH_CONFIDENCE_THRESHOLD });
  assert.equal(result.action, 'insert_broll');
  assert.equal(result.chosenClip.id, 'good_1');
  assert.ok(result.confidence >= DEFAULT_MATCH_CONFIDENCE_THRESHOLD);
});
