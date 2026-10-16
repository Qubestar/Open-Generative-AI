import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RendererAdapter, resolveFfmpegBinary } from '../src/rendererAdapter.js';
import {
  generateType1ReviewScript,
  generateType2GoalProblemScript,
  verifyUgcClaims,
  createResponsiveUgcEdg,
  UGC_FUNNEL_TYPES,
  DISCLOSURE_TAGS,
} from '../src/reviewUgc.js';

test('verifyUgcClaims rejects unverified 30-day claims and anonymous customer quotes', () => {
  const unverified = [
    { text: 'Testowałem przez 30 dni ten produkt.', userExplicitlyConfirmedExperience: false },
    { text: 'To najlepszy sprzęt.', type: 'customer_quote' }, // missing author/source
  ];

  const result = verifyUgcClaims(unverified);
  assert.equal(result.valid, false);
  assert.equal(result.violations.length, 2);

  // When explicitly confirmed and sourced
  const verified = [
    { text: 'Testowałem przez 30 dni ten produkt.', userExplicitlyConfirmedExperience: true },
    { text: 'Świetny gabinet.', type: 'customer_quote', author: 'Jan K.', source: 'Google Review' },
  ];
  const validResult = verifyUgcClaims(verified);
  assert.equal(validResult.valid, true);
});

test('generateType1ReviewScript produces structured review with disclosures', () => {
  const script = generateType1ReviewScript({
    productName: 'Aparat Sony',
    verdict: 'Świetny autofokus, ale menu jest skomplikowane.',
    pros: ['ostry obraz', 'mała waga'],
    cons: ['słaba bateria'],
    targetAudience: 'vlogerów',
    avoidAudience: 'początkujących bez budżetu',
    bonusOffer: 'zestaw presetów kolorów',
    claims: [],
  });

  assert.equal(script.type, UGC_FUNNEL_TYPES.TYPE_1_REVIEW_SEARCH);
  assert.equal(script.sections.length, 6);
  assert.ok(script.disclosures.includes(DISCLOSURE_TAGS.AFFILIATE));
  assert.match(script.fullScript, /Aparat Sony/);
  assert.match(script.fullScript, /Dla vlogerów/);
});

test('generateType2GoalProblemScript produces educational problem-solving script', () => {
  const script = generateType2GoalProblemScript({
    goalOrProblem: 'pozyskiwanie klientów na montaż',
    mythsBusted: 'wysyłanie 100 cold maili dziennie',
    hiddenMechanism: 'tworzenie portfolio wideo wideo-as-code',
    solutionProduct: 'Vidmyo Studio',
    socialProof: 'Ponad 200 montażystów skróciło czas pracy o połowę.',
  });

  assert.equal(script.type, UGC_FUNNEL_TYPES.TYPE_2_GOAL_PROBLEM);
  assert.equal(script.sections.length, 6);
  assert.match(script.fullScript, /Vidmyo Studio/);
});

test('createResponsiveUgcEdg builds valid EDG with disclosures and captions for all 3 layouts', () => {
  const script = generateType1ReviewScript({
    productName: 'Vidmyo Studio',
    verdict: 'Świetny generator, ale wymaga nauki skrótów.',
    pros: ['szybki render'],
    cons: ['dużo opcji'],
    claims: [],
  });

  for (const layoutKey of ['VERTICAL_9_16', 'SQUARE_1_1', 'LANDSCAPE_16_9']) {
    const edg = createResponsiveUgcEdg(script, layoutKey, { fps: 30 });
    assert.ok(edg);
    assert.ok(edg.totalTimelineFrames > 0);
    assert.ok(edg.canvas.width > 0);
    assert.ok(edg.canvas.height > 0);

    const headlineTrack = edg.tracks.find(t => t.id === 'captions-headline');
    const disclosureTrack = edg.tracks.find(t => t.id === 'disclosures');

    assert.ok(headlineTrack && headlineTrack.clips.length > 0);
    assert.ok(disclosureTrack && disclosureTrack.clips.length > 0);
    assert.match(disclosureTrack.clips[0].text, /#afiliacja/);
  }
});

test('RendererAdapter renders real UGC Review MP4 export', async () => {
  let ffmpegPath;
  try {
    ffmpegPath = resolveFfmpegBinary();
  } catch {
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo_ugc_render_test_'));
  const adapter = new RendererAdapter({ ffmpegPath });

  const script = {
    sections: [
      { step: '1_hook', text: 'Czy warto kupić ten mikrofon?' },
      { step: '6_cta', text: 'Sprawdź link pod filmem!' },
    ],
    disclosures: [DISCLOSURE_TAGS.AFFILIATE, DISCLOSURE_TAGS.SYNTHETIC],
  };

  const edg = createResponsiveUgcEdg(script, 'VERTICAL_9_16', { fps: 30 });
  // Shrink duration to 30 frames (1s) for test speed
  edg.totalTimelineFrames = 30;
  edg.tracks.forEach(t => t.clips.forEach(c => {
    if (c.timelineStartFrame >= 30) c.timelineStartFrame = 15;
    if (c.timelineEndFrame > 30) c.timelineEndFrame = 30;
  }));

  const exportFile = path.join(tmpDir, 'ugc_review.mp4');

  const result = await adapter.renderExport(edg, exportFile, {
    renderer: 'ffmpeg',
    execute: true,
  });

  assert.equal(result.status, 'done');
  assert.ok(fs.existsSync(exportFile));
  assert.ok(fs.statSync(exportFile).size > 1000);

  const probe = adapter.probeMedia(exportFile);
  assert.ok(probe.streams && probe.streams.length >= 1);
  const videoStream = probe.streams.find(s => s.codec_type === 'video');
  assert.ok(videoStream);
  assert.equal(videoStream.width, 1080);
  assert.equal(videoStream.height, 1920);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

