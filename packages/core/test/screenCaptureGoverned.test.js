// Phase 5 review fix (blockers 1 + 2) — `startGovernedCapture` must be proven
// with REAL child processes, never with fake PIDs on the host:
//
//   1. cancel: `pgrep -g <pgid>` has no survivors, the partial file is deleted
//      and the governor lease is released;
//   2. timeout: a small `timeoutMs` kills the whole tree, releases the lease
//      and the exit is reported truthfully (killed, not a fake success);
//   3. stop via SIGINT: a real child exits, the file is produced and the lease
//      is released only after the process is actually gone.
//
// The fake FFmpeg is a shell script that forks a `sleep 60` grandchild and
// publishes both PIDs, so killing only the direct child would leave a survivor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startGovernedCapture } from '../src/screenCapture.js';
import { ResourceGovernor } from '../src/governor.js';

const CAPS = { availableEncoders: ['libx264', 'aac'], encoders: { libx264: true } };
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pgrepGroup(pgid) {
  if (!pgid) return { code: 1, out: '' };
  const res = spawnSync('/usr/bin/pgrep', ['-g', String(pgid)], { encoding: 'utf8' });
  return { code: res.status, out: (res.stdout || '').trim() };
}

async function waitFor(predicate, timeoutMs = 6000, stepMs = 50) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

// Idles forever in its own process group; creates the output file immediately
// so the cancel path has a real partial file to delete.
function writeIdleFakeFfmpeg(root, { pidFile }) {
  const script = path.join(root, `fake-ffmpeg-idle-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(script, `#!/bin/sh
for last; do :; done
: > "$last"
sleep 60 &
grandchild=$!
printf '%s %s\\n' "$$" "$grandchild" > "${pidFile}"
wait
`, { mode: 0o755 });
  fs.chmodSync(script, 0o755);
  return script;
}

// Announces an avfoundation input, forks a grandchild, then idles. On SIGINT it
// writes a non-empty output file and exits 0 (simulating FFmpeg's muxer finish).
function writeIntFakeFfmpeg(root, { pidFile }) {
  const script = path.join(root, `fake-ffmpeg-int-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(script, `#!/bin/sh
for last; do :; done
printf '%s\\n' "Input #0, avfoundation, from '0:none':" >&2
sleep 60 &
grandchild=$!
printf '%s %s\\n' "$$" "$grandchild" > "${pidFile}"
trap 'kill "$grandchild" 2>/dev/null; printf fake > "$last"; exit 0' INT
while true; do sleep 1; done
`, { mode: 0o755 });
  fs.chmodSync(script, 0o755);
  return script;
}

test('startGovernedCapture cancel kills the whole process tree, deletes the partial file and frees the lease', async () => {
  const root = tempDir('vidmyo-cap-cancel-');
  const governor = new ResourceGovernor({ governorDir: path.join(root, 'gov') });
  const pidFile = path.join(root, 'pids.txt');
  const script = writeIdleFakeFfmpeg(root, { pidFile });
  const outputPath = path.join(root, 'rec.mp4');

  try {
    const session = await startGovernedCapture({
      videoDeviceIndex: 0,
      fps: 30,
      maxDurationSec: 60,
      outputPath,
      governor,
      jobId: 'job_cap_cancel',
      ffmpegBinary: script,
      caps: CAPS,
    });

    const published = await waitFor(() => fs.existsSync(pidFile));
    assert.ok(published, 'fake ffmpeg must publish its PIDs');
    const [shellPid, grandchildPid] = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
    assert.equal(session.pid, shellPid, 'session pid must be the real spawned child');
    assert.ok(alive(shellPid) && alive(grandchildPid), 'both tree members alive before cancel');
    assert.ok(fs.existsSync(outputPath), 'partial output must exist before cancel');
    assert.equal(governor.getActiveLeases().length, 1, 'heavy lease held while recording');

    const result = await session.cancel();
    assert.equal(result.cancelled, true);
    assert.equal(fs.existsSync(outputPath), false, 'cancel must delete the partial file');

    const emptied = await waitFor(() => pgrepGroup(shellPid).code === 1);
    assert.ok(emptied, `process group ${shellPid} must have no survivors`);
    assert.equal(pgrepGroup(shellPid).out, '', 'pgrep -g must return nothing after cancel');
    assert.equal(alive(grandchildPid), false, 'grandchild must be gone (whole tree)');

    await waitFor(() => governor.getActiveLeases().length === 0);
    assert.equal(governor.getActiveLeases().length, 0, 'lease must be released after cancel');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startGovernedCapture timeoutMs kills the whole tree, frees the lease and reports the kill truthfully', async () => {
  const root = tempDir('vidmyo-cap-timeout-');
  const governor = new ResourceGovernor({ governorDir: path.join(root, 'gov') });
  const pidFile = path.join(root, 'pids.txt');
  const script = writeIdleFakeFfmpeg(root, { pidFile });
  const outputPath = path.join(root, 'rec.mp4');

  try {
    const exitInfo = await new Promise((resolve, reject) => {
      startGovernedCapture({
        videoDeviceIndex: 0,
        fps: 30,
        maxDurationSec: 60,
        outputPath,
        governor,
        jobId: 'job_cap_timeout',
        ffmpegBinary: script,
        caps: CAPS,
        timeoutMs: 800,
        cancelEscalationMs: 300,
      }).then((session) => session.onExit((info) => resolve(info))).catch(reject);
    });

    const published = await waitFor(() => fs.existsSync(pidFile));
    assert.ok(published, 'fake ffmpeg must publish its PIDs');
    const [shellPid, grandchildPid] = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);

    const emptied = await waitFor(() => pgrepGroup(shellPid).code === 1);
    assert.ok(emptied, `timeout must end the process group ${shellPid}`);
    assert.equal(pgrepGroup(shellPid).out, '', 'pgrep -g must return nothing after timeout');
    assert.equal(alive(grandchildPid), false, 'grandchild must be gone after timeout');

    // Truthful reporting: the watchdog kill must surface as a non-zero code or
    // a signal — never a fabricated success.
    assert.ok(
      exitInfo.code !== 0 || Boolean(exitInfo.signal),
      `timeout exit must be reported truthfully, got ${JSON.stringify(exitInfo)}`,
    );

    await waitFor(() => governor.getActiveLeases().length === 0);
    assert.equal(governor.getActiveLeases().length, 0, 'lease must be released after timeout');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startGovernedCapture stop sends SIGINT to a real child, produces the file and releases the lease on exit', async () => {
  const root = tempDir('vidmyo-cap-stop-');
  const governor = new ResourceGovernor({ governorDir: path.join(root, 'gov') });
  const pidFile = path.join(root, 'pids.txt');
  const script = writeIntFakeFfmpeg(root, { pidFile });
  const outputPath = path.join(root, 'rec.mp4');

  try {
    const session = await startGovernedCapture({
      videoDeviceIndex: 0,
      fps: 30,
      maxDurationSec: 60,
      outputPath,
      governor,
      jobId: 'job_cap_stop',
      ffmpegBinary: script,
      caps: CAPS,
    });

    const published = await waitFor(() => fs.existsSync(pidFile));
    assert.ok(published, 'fake ffmpeg must publish its PIDs');
    const [shellPid] = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
    assert.ok(alive(shellPid), 'real child must be alive before stop');
    assert.equal(governor.getActiveLeases().length, 1, 'lease held while the child runs');

    const result = await session.stop();
    assert.equal(result.ok, true, result.error);
    assert.ok(fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0, 'stop must leave a non-empty file');

    assert.equal(alive(shellPid), false, 'stop must end the real child');
    await waitFor(() => governor.getActiveLeases().length === 0);
    assert.equal(governor.getActiveLeases().length, 0, 'lease released only after the child exited');
    await waitFor(() => pgrepGroup(shellPid).code === 1);
    assert.equal(pgrepGroup(shellPid).out, '', 'no survivors in the captured process group');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
