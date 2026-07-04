import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DoodlePipeline, DEFAULT_SCRIPTS_DIR } from '../src/pipeline.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-pipe-'));

// Records commands; optionally writes the expected output file so the
// post-run existence checks pass.
function fakeExec(writes = {}) {
  const calls = [];
  const impl = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    for (const [flagIndexKey, content] of Object.entries(writes)) {
      const idx = Number(flagIndexKey);
      if (args[idx]) fs.writeFileSync(args[idx], content);
    }
    return { stdout: '', stderr: '' };
  };
  impl.calls = calls;
  return impl;
}

test('vendored scripts are present at the default location', () => {
  const p = new DoodlePipeline();
  const r = p.readiness();
  // venv is machine-specific, but the scripts themselves must all resolve
  assert.ok(!r.missing.some(m => m.includes('pipeline script')), r.missing.join('; '));
  assert.ok(fs.existsSync(path.join(DEFAULT_SCRIPTS_DIR, 'assemble.py')));
});

test('tts builds the right command and verifies output exists', async () => {
  const dir = tmp();
  const out = path.join(dir, 'voiceover.wav');
  const exec = fakeExec({ 2: 'WAV' }); // args[2] = out wav
  const p = new DoodlePipeline({ scriptsDir: '/S', venvPython: '/S/.venv/bin/python', execImpl: exec });

  await p.tts('/proj/script.txt', out, { speed: 0.95 });
  const c = exec.calls[0];
  assert.equal(c.cmd, '/S/.venv/bin/python');
  assert.deepEqual(c.args, ['/S/tts_kokoro.py', '/proj/script.txt', out, '--voice', 'am_onyx', '--speed', '0.95']);
});

test('tts throws when the script exits ok but wrote nothing', async () => {
  const p = new DoodlePipeline({ scriptsDir: '/S', execImpl: fakeExec() });
  await assert.rejects(p.tts('/x.txt', path.join(tmp(), 'missing.wav')), /produced no file/);
});

test('detectBeats parses and returns the beats doc', async () => {
  const dir = tmp();
  const out = path.join(dir, 'beats.json');
  const doc = { audio: 'v.wav', beats: [{ id: 's001', start: 0, end: 2, text: 'hi' }] };
  const exec = fakeExec({ 2: JSON.stringify(doc) });
  const p = new DoodlePipeline({ scriptsDir: '/S', execImpl: exec });

  const parsed = await p.detectBeats('v.wav', out, { pauseGap: 0.4 });
  assert.deepEqual(parsed.beats[0].id, 's001');
  assert.ok(exec.calls[0].args.includes('--pause-gap'));
});

test('finalize passes NO4K through the environment', async () => {
  const dir = tmp();
  const out = path.join(dir, 'final.mp4');
  const exec = fakeExec({ 2: 'MP4' });
  const p = new DoodlePipeline({ scriptsDir: '/S', execImpl: exec });

  await p.finalize('/in.mp4', out, { no4k: true });
  assert.equal(exec.calls[0].cmd, 'bash');
  assert.equal(exec.calls[0].opts.env.NO4K, '1');
});

test('real subprocess path works end to end (node standing in for python)', async () => {
  // Exercises the default exec implementation with a real child process.
  const dir = tmp();
  const out = path.join(dir, 'voiceover.wav');
  const stub = path.join(dir, 'tts_kokoro.py');
  fs.writeFileSync(stub, 'require("fs").writeFileSync(process.argv[3], "WAV")');
  const p = new DoodlePipeline({ scriptsDir: dir, venvPython: process.execPath });

  await p.tts('ignored.txt', out);
  assert.equal(fs.readFileSync(out, 'utf8'), 'WAV');
});

test('real subprocess failures surface stderr', async () => {
  const dir = tmp();
  const stub = path.join(dir, 'tts_kokoro.py');
  fs.writeFileSync(stub, 'console.error("kokoro exploded"); process.exit(3)');
  const p = new DoodlePipeline({ scriptsDir: dir, venvPython: process.execPath });

  await assert.rejects(p.tts('x', path.join(dir, 'o.wav')), /kokoro exploded/);
});
