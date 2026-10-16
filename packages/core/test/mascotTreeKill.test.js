// Phase 3, item 2 — mascot cancel must kill the WHOLE process tree.
//
// The fake FFmpeg is a shell script that forks a `sleep 60` grandchild and
// publishes both PIDs. `promo:cancel-2d-mascot` must end up with ESRCH for
// BOTH processes, the job must finish as `cancelled`, and the governor slot
// must be free again immediately afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as core from '../index.js';

const require = createRequire(import.meta.url);
const { createPromoBridge } = require('../../../electron/lib/promoBridge.js');

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate, timeoutMs = 5000, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

// A fake FFmpeg that forks a grandchild and idles until it is signalled.
function writeFakeFfmpeg(root, { pidFile, mode = 'idle' }) {
  const script = path.join(root, mode === 'idle' ? 'fake-ffmpeg-idle.sh' : 'fake-ffmpeg-fail.sh');
  const body = mode === 'idle'
    ? `#!/bin/sh
sleep 60 &
grandchild=$!
printf '%s %s\\n' "$$" "$grandchild" > "${pidFile}"
wait
`
    : `#!/bin/sh
echo "fake-ffmpeg exploding on purpose" >&2
exit 3
`;
  fs.writeFileSync(script, body, { mode: 0o755 });
  fs.chmodSync(script, 0o755);
  return script;
}

function harness() {
  const handlers = new Map();
  const home = tempDir('vidmyo-mascot-tree-');
  const userDataDir = path.join(home, 'user-data');
  const jobsDir = path.join(userDataDir, 'jobs');
  const exportsDir = path.join(userDataDir, 'exports');
  const governorDir = path.join(home, 'governor');
  const isolatedCore = { ...core, defaultGovernorDir: () => governorDir };
  const bridge = createPromoBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    core: async () => isolatedCore,
    userDataDir,
    jobsDir,
    exportsDir,
    governorDir,
  });
  bridge.register();
  const store = new core.JobStore(jobsDir, { governorDir });
  return { handlers, store, jobsDir, exportsDir, governorDir, userDataDir, root: home };
}

test('promo:cancel-2d-mascot tree-kills grandchildren, ends the job cancelled and frees the governor slot', async () => {
  const h = harness();
  const pidFile = path.join(h.root, 'pids.txt');
  const fakeFfmpeg = writeFakeFfmpeg(h.root, { pidFile });

  const renderMascot = h.handlers.get('promo:render-2d-mascot');
  const cancelMascot = h.handlers.get('promo:cancel-2d-mascot');
  assert.ok(renderMascot);
  assert.ok(cancelMascot);

  const jobId = `job_treekill_${Date.now()}`;
  const renderPromise = renderMascot(null, {
    jobId,
    characterName: 'TreeKillBot',
    audioDurationSec: 60,
    width: 320,
    height: 320,
    ffmpegBinary: fakeFfmpeg,
  });

  const published = await waitFor(() => fs.existsSync(pidFile), 5000);
  assert.ok(published, 'fake FFmpeg must publish both PIDs');
  const [shellPid, grandchildPid] = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
  assert.ok(Number.isInteger(shellPid) && Number.isInteger(grandchildPid), 'both PIDs must be published');
  assert.ok(alive(shellPid), 'direct child alive before cancel');
  assert.ok(alive(grandchildPid), 'grandchild alive before cancel');
  assert.equal(h.store.get(jobId)?.state, 'running', 'job must be running before cancel');

  const cancelRes = await cancelMascot(null, jobId);
  assert.equal(cancelRes.ok, true, cancelRes.error);
  assert.equal(cancelRes.cancelled, true);

  const renderRes = await renderPromise;
  assert.equal(renderRes.ok, false, renderRes.error);
  assert.equal(renderRes.cancelled, true, 'the render must report a cancellation, not an error');

  const bothDead = await waitFor(() => !alive(shellPid) && !alive(grandchildPid), 5000);
  assert.equal(alive(shellPid), false, `direct child ${shellPid} must be ESRCH within 5s`);
  assert.equal(alive(grandchildPid), false, `grandchild ${grandchildPid} must be ESRCH within 5s (whole tree)`);
  assert.ok(bothDead);

  const finalJob = h.store.get(jobId);
  assert.equal(finalJob.state, 'cancelled', 'job must end in the cancelled state');
  assert.equal(finalJob.checkpoints?.leaseToken, null, 'governor lease token must be cleared');
  assert.equal(h.store.governor.getActiveLeases().length, 0, 'governor must hold no lease');
  assert.equal(fs.readdirSync(path.join(h.governorDir, 'leases')).length, 0,
    'leases directory must be empty after cancel');

  // The heavy slot must be free RIGHT NOW — a second render is admitted.
  const beforeSecond = Date.now();
  const second = await renderMascot(null, {
    characterName: 'SecondBot',
    audioDurationSec: 0.2,
    width: 320,
    height: 320,
  });
  const admissionMs = Date.now() - beforeSecond;
  assert.equal(second.ok, true, second.error);
  assert.ok(admissionMs < 5000, `second render must be admitted immediately, took ${admissionMs}ms`);
  assert.equal(h.store.governor.getActiveLeases().length, 0, 'slot released again after the second render');
  if (second.outputPath) fs.rmSync(second.outputPath, { force: true });

  fs.rmSync(h.root, { recursive: true, force: true });
});

test('governor refusal during a mascot render is a clear error and never spawns a process', async () => {
  const root = tempDir('vidmyo-mascot-refuse-');
  const governorDir = path.join(root, 'governor');
  const pidFile = path.join(root, 'unused-pids.txt');
  const fakeFfmpeg = writeFakeFfmpeg(root, { pidFile });
  const gov = new core.ResourceGovernor({ governorDir, heavyLimit: 1, lightLimit: 1 });

  const blocker = gov.acquire({ jobId: 'job_blocker_other', resourceClass: core.RESOURCE_CLASSES.HEAVY });
  let spawned = false;
  const spawnImpl = (...spawnArgs) => { spawned = true; return spawn(...spawnArgs); };

  try {
    await assert.rejects(
      () => core.render2dMascotVideo(
        core.generate2dMascotAvatar({ characterName: 'RefusedBot', audioDurationSec: 1 }),
        path.join(root, 'never.mp4'),
        {
          governor: gov,
          jobId: 'job_refused_mascot',
          ffmpegBinary: fakeFfmpeg,
          waitForSlotMs: 0,
          spawnImpl,
        },
      ),
      /Resource limit reached for class 'heavy'/,
    );
    assert.equal(spawned, false, 'spawnImpl must never be invoked when admission is refused');
    assert.ok(!fs.existsSync(path.join(root, 'never.mp4')));
  } finally {
    gov.release(blocker.token);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failing mascot render keeps the FFmpeg stderr tail in the error message', async () => {
  const root = tempDir('vidmyo-mascot-stderr-');
  const fakeFfmpeg = writeFakeFfmpeg(root, { pidFile: path.join(root, 'pids.txt'), mode: 'fail' });
  try {
    await assert.rejects(
      () => core.render2dMascotVideo(
        core.generate2dMascotAvatar({ characterName: 'StderrBot', audioDurationSec: 1 }),
        path.join(root, 'never.mp4'),
        { ffmpegBinary: fakeFfmpeg },
      ),
      (err) => {
        assert.match(err.message, /FFmpeg 2D mascot render failed with code 3/);
        assert.match(err.stderr, /fake-ffmpeg exploding on purpose/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancelProcessTree escalates SIGTERM to SIGKILL after the 3s grace period', async () => {
  const root = tempDir('vidmyo-cancel-escalate-');
  const gov = new core.ResourceGovernor({ governorDir: path.join(root, 'governor') });
  const pidFile = path.join(root, 'pids.txt');
  const script = path.join(root, 'stubborn.sh');
  // Ignores SIGTERM so only the SIGKILL escalation can end it.
  fs.writeFileSync(script, `#!/bin/sh
trap '' TERM
sleep 60 &
grandchild=$!
trap '' TERM
printf '%s %s\\n' "$$" "$grandchild" > "${pidFile}"
while true; do sleep 1; done
`, { mode: 0o755 });
  fs.chmodSync(script, 0o755);

  const started = Date.now();
  const run = core.runGovernedProcess({
    jobId: `job_stubborn_${Date.now()}`,
    cmd: script,
    args: [],
    governor: gov,
  }).catch((err) => err);

  const published = await waitFor(() => fs.existsSync(pidFile), 5000);
  assert.ok(published, 'stubborn script must publish PIDs');
  const [shellPid, grandchildPid] = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);

  // SIGTERM alone must NOT kill it (the trap swallows it).
  gov.cancelProcessTree(shellPid);
  await sleep(500);
  assert.ok(alive(shellPid), 'SIGTERM must be ignored before escalation');

  const dead = await waitFor(() => !alive(shellPid) && !alive(grandchildPid), 8000);
  const elapsed = Date.now() - started;
  assert.equal(dead, true, 'SIGKILL escalation must end the whole tree');
  assert.ok(elapsed >= 2500, `escalation must wait for the grace period (elapsed ${elapsed}ms)`);

  const err = await run;
  assert.ok(err, 'the governed run must reject once the tree is killed');
  await waitFor(() => gov.getActiveLeases().length === 0, 5000);
  assert.equal(gov.getActiveLeases().length, 0, 'governor lease released after the tree died');

  // ps-level proof: no surviving PID from this tree.
  const psPids = spawnSync('ps', ['-axo', 'pid='], { encoding: 'utf8' }).stdout
    .split('\n').map((line) => parseInt(line.trim(), 10)).filter(Number.isInteger);
  assert.ok(!psPids.includes(shellPid), 'no surviving direct child');
  assert.ok(!psPids.includes(grandchildPid), 'no surviving grandchild');

  fs.rmSync(root, { recursive: true, force: true });
});
