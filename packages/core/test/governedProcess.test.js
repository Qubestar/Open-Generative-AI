// Phase 4, step 1 — governedProcess primitives:
//   1. a pre-aborted AbortSignal must never reach spawnImpl (0 calls);
//   2. stdout under captureStdout's cap is returned intact as a Buffer;
//   3. stdout over the cap raises ESTDOUT_LIMIT, kills the whole process
//      group (no survivors) and frees the governor slot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runGovernedProcess } from '../src/governedProcess.js';
import { ResourceGovernor } from '../src/governor.js';

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function freshGovernor() {
  return new ResourceGovernor({ governorDir: tempDir('vidmyo-gp-gov-') });
}

function pgrepGroup(pgid) {
  const res = spawnSync('/usr/bin/pgrep', ['-g', String(pgid)], { encoding: 'utf8' });
  return { code: res.status, out: (res.stdout || '').trim() };
}

test('pre-aborted signal: spawnImpl is never called', async () => {
  let spawnCalls = 0;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => runGovernedProcess({
      jobId: 'job_preabort',
      cmd: '/definitely/not/real',
      spawnImpl: () => { spawnCalls += 1; throw new Error('must not spawn'); },
      signal: controller.signal,
    }),
    (err) => err.code === 'ECANCELLED',
  );
  assert.equal(spawnCalls, 0, 'spawnImpl must not be invoked for a pre-aborted signal');
});

test('pre-aborted signal with a governor: no spawn and no leaked lease', async () => {
  const governor = freshGovernor();
  let spawnCalls = 0;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => runGovernedProcess({
      jobId: 'job_preabort_leased',
      governor,
      cmd: '/definitely/not/real',
      spawnImpl: () => { spawnCalls += 1; throw new Error('must not spawn'); },
      signal: controller.signal,
    }),
    (err) => err.code === 'ECANCELLED',
  );
  assert.equal(spawnCalls, 0);
  // The heavy slot must be free afterwards.
  const lease = governor.acquire({ jobId: 'job_other', resourceClass: 'heavy', waitForSlotMs: 0 });
  assert.ok(lease?.token, 'heavy slot must be free after a pre-aborted run');
  governor.release(lease.token);
});

test('captureStdout returns stdout intact when under the cap', async () => {
  const payload = 'x'.repeat(64 * 1024); // 64 KiB, cap is 1 MiB
  const result = await runGovernedProcess({
    cmd: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(payload)})`],
    stdio: ['ignore', 'ignore', 'ignore'],
    captureStdout: { maxBytes: 1024 * 1024 },
  });
  assert.equal(result.exitCode, 0);
  assert.ok(Buffer.isBuffer(result.stdout), 'stdout must be a Buffer');
  assert.equal(result.stdout.toString('utf8'), payload);
  assert.equal(result.stdout.length, payload.length);
});

test('captureStdout over the cap raises ESTDOUT_LIMIT and leaves no survivors in the process group', async () => {
  const governor = freshGovernor();
  const root = tempDir('vidmyo-gp-overflow-');
  const pidFile = path.join(root, 'pids.txt');
  // Spawns a grandchild, then floods stdout well past the cap and idles.
  const script = path.join(root, 'flood.sh');
  fs.writeFileSync(script, `#!/bin/sh
sleep 60 &
grandchild=$!
printf '%s %s\\n' "$$" "$grandchild" > "${pidFile}"
i=0
while [ $i -lt 400 ]; do
  printf '0123456789012345678901234567890123456789012345678901234567890123'
  i=$((i+1))
done
wait
`, { mode: 0o755 });
  fs.chmodSync(script, 0o755);

  let pgid = null;
  let err = null;
  try {
    await runGovernedProcess({
      jobId: 'job_stdout_overflow',
      governor,
      cmd: script,
      resourceClass: 'heavy',
      captureStdout: { maxBytes: 8 * 1024 },
      onSpawn: (child) => { pgid = child.pid; },
      timeoutMs: 20000,
    });
  } catch (e) {
    err = e;
  }

  assert.ok(err, 'run must reject');
  assert.equal(err.code, 'ESTDOUT_LIMIT');
  assert.ok(pgid, 'child pid must be known');

  // No survivors in the process group (direct child + grandchild).
  const deadline = Date.now() + 6000;
  let alive = pgrepGroup(pgid);
  while (alive.code !== 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    alive = pgrepGroup(pgid);
  }
  assert.equal(alive.code, 1, `process group ${pgid} must be empty, got: ${alive.out}`);

  // Grandchild pid recorded by the script must also be gone.
  if (fs.existsSync(pidFile)) {
    const [parent, grandchild] = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
    const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    assert.ok(gone(parent), 'direct child must be gone');
    assert.ok(gone(grandchild), 'grandchild must be gone');
  }

  // Heavy slot free for a second jobId.
  const lease = governor.acquire({ jobId: 'job_after_overflow', resourceClass: 'heavy', waitForSlotMs: 0 });
  assert.ok(lease?.token, 'heavy lease must be free after ESTDOUT_LIMIT');
  governor.release(lease.token);
});
