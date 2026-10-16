// Phase 3, item 4 (unit) — EDG → HyperFrames composition conversion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { createEdgTimeline, createEmptyEdg } from '../src/edg.js';
import { frameToSeconds, parseFps } from '../src/timebase.js';
import { convertEdgToComposition, EdgUnsupportedError, EDG_UNSUPPORTED } from '../src/renderers/edgToHyperframes.js';
import { resolveFfmpegBinary } from '../src/rendererAdapter.js';

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function makePng(dir, name) {
  const out = path.join(dir, name);
  const r = spawnSync(resolveFfmpegBinary(), ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc=duration=1:size=320x240:rate=1', '-frames:v', '1', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return out;
}

function attrValues(html, attr) {
  const out = [];
  const re = new RegExp(`${attr}="([^"]*)"`, 'g');
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

test('timing comes from absolute frame boundaries — a long 60 fps timeline has no drift', () => {
  const root = tempDir('vidmyo-hf-timing-');
  try {
    const fps = 60;
    const totalFrames = 6000; // 100 s
    const clipFrames = 10;
    const clips = [];
    for (let i = 0; i * clipFrames < totalFrames; i++) {
      clips.push({
        id: `clip_${i}`,
        assetId: 'img',
        timelineStartFrame: i * clipFrames,
        timelineEndFrame: (i + 1) * clipFrames,
      });
    }
    const img = makePng(root, 'src.png');
    const edg = createEdgTimeline({
      title: 'long 60fps timeline',
      aspect: '16:9',
      fps,
      canvas: { width: 1920, height: 1080, aspect: '16:9' },
      assets: { img: { id: 'img', path: img, hash: sha256(img), type: 'image' } },
      tracks: [{ id: 'video-primary', type: 'video', name: 'Video', clips }],
    });
    edg.totalTimelineFrames = totalFrames;

    const projectDir = path.join(root, 'proj');
    const res = convertEdgToComposition(edg, { projectDir, strict: true });
    const html = fs.readFileSync(res.indexPath, 'utf8');

    const starts = attrValues(html, 'data-start').map(Number);
    const durations = attrValues(html, 'data-duration').map(Number);

    // The root element carries data-start="0"; every remaining start must be
    // the ABSOLUTE frame boundary, not a running sum of rounded durations.
    const clipStarts = starts.slice(1);
    assert.equal(clipStarts.length, clips.length);
    const fpsObj = parseFps(edg.timebase.fps);
    for (let i = 0; i < clips.length; i++) {
      const expected = frameToSeconds(clips[i].timelineStartFrame, fpsObj);
      assert.ok(Math.abs(clipStarts[i] - expected) < 1e-9,
        `clip ${i} start ${clipStarts[i]} !== absolute ${expected}`);
      const expectedDur = frameToSeconds(clipFrames, fpsObj);
      assert.ok(Math.abs(durations[i + 1] - expectedDur) < 1e-9,
        `clip ${i} duration ${durations[i + 1]} !== ${expectedDur}`);
    }

    // Root duration = absolute total, and the sum of rounded durations is NOT
    // used as the composition length (that is where drift would come from).
    assert.equal(res.totalFrames, totalFrames);
    assert.ok(Math.abs(res.durationSec - frameToSeconds(totalFrames, fpsObj)) < 1e-9);
    const sumOfDurations = durations.slice(1).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sumOfDurations - res.durationSec) < 1e-6,
      `durations must add up to the absolute total (${sumOfDurations} vs ${res.durationSec})`);
    assert.ok(/data-composition-id="main"/.test(html));
    assert.ok(/data-width="1920"/.test(html));
    assert.equal(res.unsupported.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('media is copied into assets/ keyed by its EDG hash', () => {
  const root = tempDir('vidmyo-hf-assets-');
  try {
    const img = makePng(root, 'scene.png');
    const hash = sha256(img);
    const edg = createEdgTimeline({
      title: 'asset copy',
      aspect: '16:9',
      fps: 30,
      canvas: { width: 1920, height: 1080, aspect: '16:9' },
      assets: { img: { id: 'img', path: img, hash, type: 'image' } },
      tracks: [{
        id: 'video-primary', type: 'video', name: 'Video',
        clips: [{ id: 'c1', assetId: 'img', timelineStartFrame: 0, timelineEndFrame: 30 }],
      }],
    });
    edg.totalTimelineFrames = 30;

    const projectDir = path.join(root, 'proj');
    const res = convertEdgToComposition(edg, { projectDir });
    const expectedName = `${hash.slice(0, 16)}.png`;
    const copied = path.join(projectDir, 'assets', expectedName);
    assert.ok(fs.existsSync(copied), `expected ${copied}`);
    assert.equal(sha256(copied), hash, 'copied bytes must match the source hash');
    assert.deepEqual(res.assets, [{ assetId: 'img', rel: `assets/${expectedName}` }]);
    assert.ok(fs.existsSync(path.join(projectDir, 'hyperframes.json')));
    assert.ok(fs.existsSync(path.join(projectDir, 'meta.json')));
    const html = fs.readFileSync(res.indexPath, 'utf8');
    assert.ok(html.includes(`src="assets/${expectedName}"`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported EDG features are listed; strict mode throws EDG_UNSUPPORTED', () => {
  const root = tempDir('vidmyo-hf-unsupported-');
  try {
    const img = makePng(root, 'scene.png');
    const buildEdg = () => {
      const edg = createEdgTimeline({
        title: 'unsupported mix',
        aspect: '16:9',
        fps: 30,
        canvas: { width: 1920, height: 1080, aspect: '16:9' },
        assets: { img: { id: 'img', path: img, hash: sha256(img), type: 'image' } },
        tracks: [
          { id: 'video-primary', type: 'video', name: 'Video', clips: [
            { id: 'c1', assetId: 'img', timelineStartFrame: 0, timelineEndFrame: 60 },
            { id: 'c2', assetId: 'img', timelineStartFrame: 60, timelineEndFrame: 90, transform: { rotate: 0.5, zoom: 1.2 } },
          ] },
          { id: 'overlay-broll', type: 'overlay', name: 'FX', clips: [
            { id: 'fx1', type: 'speedlines', timelineStartFrame: 0, timelineEndFrame: 30 },
          ] },
          { id: 'captions-main', type: 'caption', name: 'Captions', clips: [
            { id: 'cap1', text: 'Hello', timelineStartFrame: 0, timelineEndFrame: 30, transform: { x: 10, y: 20 } },
          ] },
          { id: 'audio-voice', type: 'audio', name: 'Voice', clips: [
            { id: 'a1', assetId: 'img', timelineStartFrame: 0, timelineEndFrame: 30, volume: 0.5 },
          ] },
        ],
        transitions: [
          { id: 't1', type: 'wipe_left', afterClipId: 'c1', durationFrames: 10 },
        ],
      });
      edg.totalTimelineFrames = 90;
      return edg;
    };

    const permissiveDir = path.join(root, 'permissive');
    const res = convertEdgToComposition(buildEdg(), { projectDir: permissiveDir, strict: false });
    const features = res.unsupported.map((u) => u.feature).sort();
    assert.ok(features.includes('overlay-effect:speedlines'), JSON.stringify(features));
    assert.ok(features.includes('transform:rotate'), JSON.stringify(features));
    assert.ok(features.includes('caption-transform-x'), JSON.stringify(features));
    assert.ok(features.includes('audio-asset-type:image'), JSON.stringify(features));
    assert.ok(features.includes('transition:wipe_left'), JSON.stringify(features));
    assert.ok(res.html.length > 0, 'permissive mode still writes a composition');
    // The supported parts are still emitted.
    assert.ok(res.html.includes('class="hf-media clip"'));

    const strictDir = path.join(root, 'strict');
    assert.throws(
      () => convertEdgToComposition(buildEdg(), { projectDir: strictDir, strict: true }),
      (err) => {
        assert.ok(err instanceof EdgUnsupportedError);
        assert.equal(err.code, EDG_UNSUPPORTED);
        assert.ok(err.unsupported.length >= 5);
        assert.match(err.message, /overlay-effect:speedlines/);
        assert.match(err.message, /renderer 'ffmpeg'/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('caption text is HTML-escaped — captions are data, never markup', () => {
  const root = tempDir('vidmyo-hf-escape-');
  try {
    const nasty = `<script>alert("x")</script> & 'quote'`;
    const edg = createEdgTimeline({
      title: 'escape',
      aspect: '9:16',
      fps: 30,
      canvas: { width: 1080, height: 1920, aspect: '9:16' },
      assets: {},
      tracks: [{ id: 'captions-main', type: 'caption', name: 'Captions', clips: [
        { id: 'cap1', text: nasty, timelineStartFrame: 0, timelineEndFrame: 30 },
      ] }],
    });
    edg.totalTimelineFrames = 30;
    const res = convertEdgToComposition(edg, { projectDir: path.join(root, 'proj') });
    assert.ok(!res.html.includes('<script>alert'), 'raw script tag must not survive');
    assert.ok(res.html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
    assert.ok(res.html.includes('&amp; &#39;quote&#39;'));
    // The inline timeline shim must not be terminable by data either.
    assert.equal((res.html.match(/<\/script>/g) || []).length, 1, 'only the real closing script tag');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a mismatched aspect request is rejected instead of silently re-cropping', () => {
  const root = tempDir('vidmyo-hf-aspect-');
  try {
    const edg = createEmptyEdg({ aspect: '16:9' });
    edg.totalTimelineFrames = 30;
    assert.throws(
      () => convertEdgToComposition(edg, { projectDir: path.join(root, 'p'), aspect: '9:16' }),
      /does not match EDG canvas aspect/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
