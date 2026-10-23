// The Editor brain: prompt building, answer validation, plan application and the
// graceful fallback. No agent is ever spawned here — `run` is injected.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITOR_AGENT_ADAPTERS,
  applyBrainPicks,
  buildBrainBrief,
  detectEditorAgents,
  extractJsonBlock,
  parseBrainPicks,
  runBrainPass,
} from '../src/editorAgents.js';
import { normalizeEditorOptions } from '../src/editor.js';

const assets = {
  stills: [
    { asset: 'assets/media/still_001.png', path: '/p/still_001.png' },
    { asset: 'assets/media/still_002.png', path: '/p/still_002.png' },
  ],
  clips: [{ asset: 'assets/media/clip_001.mp4', path: '/p/clip_001.mp4' }],
};

const plan = {
  duration: 6,
  beats: [
    { id: 'b1', t0: 0, t1: 1, device: 'still', asset: 'assets/media/still_001.png', caption: [['the', 0.1], ['harbour', 0.4]] },
    { id: 'b2', t0: 1, t1: 2, device: 'face', caption: [['we', 1.1]] },
    { id: 'b3', t0: 2, t1: 3, device: 'still', asset: 'assets/media/still_002.png', caption: [['the', 2.1], ['crane', 2.4]] },
  ],
};

test('the shipped adapters cover the CLIs Vidmyo knows about', () => {
  const ids = EDITOR_AGENT_ADAPTERS.map(adapter => adapter.id);
  assert.deepEqual(ids.sort(), ['claude_code', 'codex', 'gemini', 'hermes', 'opencode']);
  for (const adapter of EDITOR_AGENT_ADAPTERS) {
    assert.ok(Array.isArray(adapter.args('hi')) && adapter.args('hi').length > 0, `${adapter.id} needs args`);
    assert.ok(adapter.args('hi').includes('hi'), `${adapter.id} must pass the prompt through`);
  }
});

test('detection reports only the CLIs actually on PATH', () => {
  const detected = detectEditorAgents({
    resolve: cli => (cli === 'opencode' ? '/usr/local/bin/opencode' : null),
  });
  const byId = Object.fromEntries(detected.map(entry => [entry.id, entry]));
  assert.equal(byId.opencode.available, true);
  assert.equal(byId.opencode.path, '/usr/local/bin/opencode');
  assert.equal(byId.codex.available, false);
  assert.equal(byId.hermes.available, false);
});

test('the brief lists every beat and only real inventory files', () => {
  const brief = buildBrainBrief({ plan, assets, options: { face_share: 0.3 }, style: { cut_median_s: 1.2 } });
  assert.match(brief.prompt, /BEATS \(3\)/);
  assert.match(brief.prompt, /INVENTORY \(3\)/);
  assert.match(brief.prompt, /clip_001\.mp4/);
  assert.match(brief.prompt, /the harbour/);
  assert.match(brief.prompt, /1\.2s per picture/);
  assert.equal(brief.beats.length, 3);
});

test('a JSON answer survives the banner text a CLI prints', () => {
  const raw = '> build · deepseek\n\nsome preamble\n{"picks":[{"beat":0,"asset":"still_002.png"}]}\ntrailing note';
  assert.deepEqual(extractJsonBlock(raw), { picks: [{ beat: 0, asset: 'still_002.png' }] });
  assert.equal(extractJsonBlock('no json here'), null);
});

test('picks are validated against the footage folder and the beat list', () => {
  const parsed = parseBrainPicks({
    picks: [
      { beat: 0, asset: 'still_002.png' },
      { beat: 1, asset: 'clip_001.mp4' },        // face beat: refused
      { beat: 9, asset: 'still_001.png' },       // out of range
      { beat: 2, asset: 'no_such_file.png' },    // not in the folder
    ],
    face: [2, 0, 1],
    keywords: [
      { beat: 0, text: 'HARBOUR', kind: 'shock' },
      { beat: 2, text: 'BANANA', kind: 'key' },  // never said
    ],
  }, { plan, assets });

  assert.deepEqual(parsed.picks, [{ beat: 0, asset: 'assets/media/still_002.png', name: 'still_002.png' }]);
  // Beat 1 is already the speaker and beat 0 follows it, so the face list settles
  // on beat 2 — the accepted, non-adjacent one.
  assert.deepEqual(parsed.face, [0, 2], 'adjacency is judged in beat order');
  assert.deepEqual(parsed.keywords, [{ beat: 0, text: 'HARBOUR', kind: 'shock' }]);
  assert.ok(parsed.rejected.length >= 3);
  assert.equal(parsed.answered, true);
});

test('applying picks swaps the picture without touching timing', () => {
  const copy = structuredClone(plan);
  const applied = applyBrainPicks(copy, {
    picks: [{ beat: 0, asset: 'assets/media/clip_001.mp4' }],
    face: [2],
    keywords: [{ beat: 0, text: 'HARBOUR', kind: 'shock' }],
  });
  assert.deepEqual(applied, { assets: 1, face: 1, keywords: 1 });
  assert.equal(copy.beats[0].device, 'broll');
  assert.equal(copy.beats[0].asset, 'assets/media/clip_001.mp4');
  assert.equal(copy.beats[0].t1, 1, 'timing is not the agent’s business');
  assert.equal(copy.beats[2].device, 'face');
  assert.equal(copy.beats[2].asset, undefined);
  assert.equal(copy.beats[0].keyword.kind, 'shock');
});

test('runBrainPass applies a good answer and reports what changed', async () => {
  const copy = structuredClone(plan);
  const result = await runBrainPass({
    agentId: 'opencode',
    plan: copy,
    assets,
    run: async () => '{"picks":[{"beat":2,"asset":"still_001.png"}]}',
  });
  assert.equal(result.answered, true);
  assert.deepEqual(result.applied, { assets: 1, face: 0, keywords: 0 });
  assert.equal(copy.beats[2].asset, 'assets/media/still_001.png');
  assert.ok(result.duration_ms >= 0);
});

test('a useless answer leaves the plan untouched and says so', async () => {
  const copy = structuredClone(plan);
  const result = await runBrainPass({
    agentId: 'opencode',
    plan: copy,
    assets,
    run: async () => 'I would rather talk about the weather.',
  });
  assert.equal(result.answered, false);
  assert.deepEqual(result.applied, { assets: 0, face: 0, keywords: 0 });
  assert.equal(copy.beats[0].asset, 'assets/media/still_001.png');
  assert.equal(result.rejected.length, 1);
});

test('an unknown agent id is refused before anything runs', async () => {
  await assert.rejects(
    runBrainPass({ agentId: 'nope', plan, assets, run: async () => '{}' }),
    /Unknown editor agent/,
  );
});

test('brain options default to off and reject an unknown agent', () => {
  assert.deepEqual(normalizeEditorOptions({}).brain, { mode: 'none', agent_id: null, timeout_s: 180 });
  assert.deepEqual(normalizeEditorOptions({ brain_agent: 'hermes' }).brain,
    { mode: 'local', agent_id: 'hermes', timeout_s: 180 });
  assert.deepEqual(normalizeEditorOptions({ brain: { mode: 'local', agent_id: 'codex', timeout_s: 60 } }).brain,
    { mode: 'local', agent_id: 'codex', timeout_s: 60 });
  assert.throws(() => normalizeEditorOptions({ brain: { mode: 'local' } }), /Choose a local agent/);
  assert.throws(() => normalizeEditorOptions({ brain_agent: 'nope' }), /Unknown editor agent/);
  assert.throws(() => normalizeEditorOptions({ brain: { mode: 'api' } }), /"none" or "local"/);
});
