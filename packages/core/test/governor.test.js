import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { ResourceGovernor, RESOURCE_CLASSES } from '../src/governor.js';
import { JobStore } from '../src/jobs.js';
import { runJob } from '../src/run.js';

function createTestGovernor(options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-gov-test-'));
  const jobsDir = path.join(rootDir, 'jobs');
  const govDir = path.join(rootDir, 'governor');
  const governor = new ResourceGovernor({
    governorDir: govDir,
    heavyLimit: 1,
    lightLimit: 3,
    minFreeMemoryBytes: 10 * 1024 * 1024,
    ...options,
  });
  const jobStore = new JobStore(jobsDir, { governor });
  governor.jobStore = jobStore;
  return { governor, jobStore, rootDir, govDir, jobsDir };
}

test('ResourceGovernor enforces heavyLimit = 1 and permits release', () => {
  const { governor } = createTestGovernor();

  const lease1 = governor.acquire({
    jobId: 'job_heavy_1',
    resourceClass: RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(lease1.token);
  assert.equal(lease1.inherited, false);

  // Attempting second heavy operation without inheritance must throw
  assert.throws(() => {
    governor.acquire({
      jobId: 'job_heavy_2',
      resourceClass: RESOURCE_CLASSES.HEAVY,
    });
  }, /Resource limit reached for class 'heavy'/);

  // After releasing lease1, second heavy operation succeeds
  governor.release(lease1.token);
  const lease2 = governor.acquire({
    jobId: 'job_heavy_2',
    resourceClass: RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(lease2.token);
  governor.release(lease2.token);
});

test('subtasks inherit parent reservation token directly without deadlock or token stripping', () => {
  const { governor } = createTestGovernor();

  const parentLease = governor.acquire({
    jobId: 'job_parent_orchestrator',
    resourceClass: RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(parentLease.token.startsWith('lease_'));

  // Subtask inherits parent reservation using the exact token (no .replace('lease_', '') workaround)
  const subLease = governor.acquire({
    jobId: 'job_subtask_asr',
    resourceClass: RESOURCE_CLASSES.HEAVY,
    parentReservationToken: parentLease.token,
  });

  assert.ok(subLease.token);
  assert.equal(subLease.inherited, true);
  assert.equal(subLease.parentToken, parentLease.token);

  governor.release(subLease.token);
  governor.release(parentLease.token);
});

test('recoverInterruptedJobs detects abandoned running jobs and marks them interrupted', () => {
  const { governor, jobStore } = createTestGovernor();

  // Create a job and manually transition to running without governor lease (abandoned)
  const job = jobStore.create({ type: 'render_4k', params: {} });
  jobStore.setState(job.id, 'running', { admit: false });

  // Since no active process/lease exists for this job, recovery must detect and mark it
  const recovered = governor.recoverInterruptedJobs();
  assert.ok(recovered.includes(job.id));

  const updatedJob = jobStore.get(job.id);
  assert.equal(updatedJob.state, 'error');
  assert.match(updatedJob.error, /Interrupted by application restart/);
  assert.ok(updatedJob.checkpoints.interruptedAt);
});

test('cancelProcessTree terminates child processes cleanly', async () => {
  const { governor } = createTestGovernor();

  // Spawn a real sleeping child process
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  assert.ok(child.pid);

  // Check it is alive
  let isAlive = true;
  try { process.kill(child.pid, 0); } catch { isAlive = false; }
  assert.equal(isAlive, true);

  // Cancel via governor
  const cancelled = governor.cancelProcessTree(child.pid);
  assert.equal(cancelled, true);

  // Give OS up to 200ms to terminate
  await new Promise(r => setTimeout(r, 100));

  let stillAlive = true;
  try { process.kill(child.pid, 0); } catch { stillAlive = false; }
  assert.equal(stillAlive, false);
});

test('exclusive lock prevents concurrent heavy lease acquisition across 3 processes', async () => {
  const { govDir } = createTestGovernor();
  const governorModuleUrl = new URL('../src/governor.js', import.meta.url).href;

  // Worker script that attempts to acquire heavy lease, holds for 50ms, and records timestamps
  const workerScript = `
    import { ResourceGovernor, RESOURCE_CLASSES } from '${governorModuleUrl}';
    import fs from 'node:fs';
    const gov = new ResourceGovernor({ governorDir: '${govDir}', heavyLimit: 1, lockTimeoutMs: 5000 });
    const logFile = '${path.join(govDir, 'concurrency_log.txt')}';
    
    let acquired = false;
    const start = Date.now();
    while (!acquired && (Date.now() - start < 5000)) {
      try {
        const lease = gov.acquire({ jobId: 'job_' + process.pid, resourceClass: RESOURCE_CLASSES.HEAVY });
        acquired = true;
        fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, event: 'acquired', at: Date.now() }) + '\\n');
        // hold lease briefly
        const holdStart = Date.now();
        while (Date.now() - holdStart < 50) {}
        fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, event: 'releasing', at: Date.now() }) + '\\n');
        gov.release(lease.token);
      } catch (err) {
        // limit reached or lock wait, backoff and retry
        const spin = Date.now();
        while (Date.now() - spin < 15) {}
      }
    }
    if (!acquired) {
      process.exit(1);
    }
    process.exit(0);
  `;

  const scriptPath = path.join(govDir, 'worker.mjs');
  fs.writeFileSync(scriptPath, workerScript);

  // Spawn 3 worker processes simultaneously
  const p1 = spawn(process.execPath, [scriptPath], { stdio: 'inherit' });
  const p2 = spawn(process.execPath, [scriptPath], { stdio: 'inherit' });
  const p3 = spawn(process.execPath, [scriptPath], { stdio: 'inherit' });

  const exitCodes = await Promise.all([
    new Promise(res => p1.on('close', res)),
    new Promise(res => p2.on('close', res)),
    new Promise(res => p3.on('close', res)),
  ]);

  assert.deepEqual(exitCodes, [0, 0, 0]);

  // Read log and verify no overlapping acquired intervals
  const logFile = path.join(govDir, 'concurrency_log.txt');
  assert.ok(fs.existsSync(logFile));
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));

  let currentHolder = null;
  for (const entry of lines) {
    if (entry.event === 'acquired') {
      assert.equal(currentHolder, null, `PID ${entry.pid} acquired while PID ${currentHolder} held lease!`);
      currentHolder = entry.pid;
    } else if (entry.event === 'releasing') {
      assert.equal(currentHolder, entry.pid);
      currentHolder = null;
    }
  }
});

test('checkDiskSpace refuses admission when free disk space is insufficient', () => {
  // Set minFreeDiskBytes to an impossibly large value (1000 TB)
  const { governor } = createTestGovernor({ minFreeDiskBytes: 1000 * 1024 * 1024 * 1024 * 1024 });

  assert.throws(() => {
    governor.acquire({
      jobId: 'job_too_big',
      resourceClass: RESOURCE_CLASSES.HEAVY,
    });
  }, /Insufficient disk space/);
});

test('caching operations are versioned and idempotent', () => {
  const { governor } = createTestGovernor();

  const op = 'vfx_storyboard';
  const ver = '1.0.0';
  const inputHash = 'abcdef0123456789';

  assert.equal(governor.getCache(op, ver, inputHash), null);

  governor.setCache(op, ver, inputHash, { cuts: [10, 50, 100] });

  const cached = governor.getCache(op, ver, inputHash);
  assert.ok(cached);
  assert.deepEqual(cached.data.cuts, [10, 50, 100]);

  // Different version gives cache miss
  assert.equal(governor.getCache(op, '1.0.1', inputHash), null);
});

test('cancelProcessTree invokes taskkill on Windows platform', () => {
  const { governor } = createTestGovernor();
  let taskkillInvoked = null;

  const mockSpawnSync = (cmd, args) => {
    taskkillInvoked = { cmd, args };
    return { status: 0 };
  };

  const ok = governor.cancelProcessTree(12345, {
    platform: 'win32',
    spawnSyncImpl: mockSpawnSync,
  });

  assert.equal(ok, true);
  assert.deepEqual(taskkillInvoked, {
    cmd: 'taskkill',
    args: ['/pid', '12345', '/T', '/F'],
  });
});

test('three-surface governor coordination across Electron, CLI, and MCP surfaces', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-three-surface-'));
  const sharedGovDir = path.join(rootDir, 'shared_governor');
  const sharedGov = new ResourceGovernor({ governorDir: sharedGovDir, heavyLimit: 1 });

  // Surface 1: Electron main-process JobStore
  const electronStore = new JobStore(path.join(rootDir, 'electron_jobs'), { governor: sharedGov });
  // Surface 2: CLI runner JobStore
  const cliStore = new JobStore(path.join(rootDir, 'cli_jobs'), { governor: sharedGov });
  // Surface 3: MCP service JobStore
  const mcpStore = new JobStore(path.join(rootDir, 'mcp_jobs'), { governor: sharedGov });

  // 1. Electron starts heavy job
  const electronJob = electronStore.create({ type: 'render_4k', params: {} });
  electronStore.setState(electronJob.id, 'running'); // Admits heavy lease
  assert.ok(electronStore.get(electronJob.id).checkpoints.leaseToken);

  // 2. CLI attempts to start heavy job -> admission denied
  const cliJob = cliStore.create({ type: 'whisper_asr', params: {} });
  assert.throws(() => cliStore.admit(cliJob.id), /Resource limit reached/);
  cliStore.setState(cliJob.id, 'running');
  assert.equal(cliStore.get(cliJob.id).state, 'error');
  assert.match(cliStore.get(cliJob.id).error, /Governor admission denied: Resource limit reached/);

  // 3. MCP attempts to start heavy job -> admission denied
  const mcpJob = mcpStore.create({ type: 'repurpose_analysis', params: {} });
  assert.throws(() => mcpStore.admit(mcpJob.id), /Resource limit reached/);
  mcpStore.setState(mcpJob.id, 'running');
  assert.equal(mcpStore.get(mcpJob.id).state, 'error');
  assert.match(mcpStore.get(mcpJob.id).error, /Governor admission denied: Resource limit reached/);

  // 4. MCP subtask inheriting Electron reservation -> permitted without blocking
  const electronToken = electronStore.get(electronJob.id).checkpoints.leaseToken;
  const mcpSubtask = mcpStore.create({
    type: 'repurpose_subtask',
    params: { parentReservationToken: electronToken },
  });
  mcpStore.setState(mcpSubtask.id, 'running', { parentReservationToken: electronToken });
  assert.ok(mcpStore.get(mcpSubtask.id).checkpoints.leaseToken);

  // 5. Electron finishes, freeing heavy capacity
  mcpStore.setState(mcpSubtask.id, 'done');
  electronStore.setState(electronJob.id, 'done');

  // 6. Now CLI job can be admitted and run to completion
  const cliJob2 = cliStore.create({ type: 'whisper_asr', params: {} });
  cliStore.setState(cliJob2.id, 'running');
  assert.ok(cliStore.get(cliJob2.id).checkpoints.leaseToken);
  cliStore.setState(cliJob2.id, 'done');
});

test('runJob drives heavy job type to completion without double-admission or slot leaks', async () => {
  const { governor, jobStore, rootDir } = createTestGovernor({ heavyLimit: 1 });
  const outDir = path.join(rootDir, 'artifacts');

  let submitted = false;
  const mockAdapter = {
    async submit(params, ctx) {
      submitted = true;
      return { id: 'mock_heavy_handle_1' };
    },
    async poll(handle, ctx) {
      return { status: 'done', result: { ok: true } };
    },
    async fetchArtifact(result, ctx) {
      return { bytes: Buffer.from('mock video render artifact'), ext: '.mp4' };
    },
  };

  const job = jobStore.create({ type: 'render_4k', params: { resolution: '3840x2160' } });
  const finalJob = await runJob(jobStore, job.id, mockAdapter, { outDir });

  assert.equal(submitted, true);
  assert.equal(finalJob.state, 'done');
  assert.equal(finalJob.artifacts.length, 1);
  // Verify slot is completely freed
  const activeHeavy = governor.getActiveLeases(RESOURCE_CLASSES.HEAVY);
  assert.equal(activeHeavy.length, 0);
});

test('slot leak prevention: consecutive jobs in single session do not leak slots or fail admission', async () => {
  const { governor, jobStore, rootDir } = createTestGovernor({ lightLimit: 4, heavyLimit: 1 });
  const outDir = path.join(rootDir, 'artifacts_leak');

  const mockAdapter = {
    async submit() { return { id: 'mock_h' }; },
    async poll() { return { status: 'done', result: {} }; },
    async fetchArtifact() { return { bytes: Buffer.from('data'), ext: '.txt' }; },
  };

  // Run 10 consecutive light jobs
  for (let i = 0; i < 10; i++) {
    const job = jobStore.create({ type: 'light_metadata_task', params: { idx: i } });
    const res = await runJob(jobStore, job.id, mockAdapter, { outDir });
    assert.equal(res.state, 'done');
  }

  // All light slots must be released
  assert.equal(governor.getActiveLeases(RESOURCE_CLASSES.LIGHT).length, 0);

  // Run 5 consecutive heavy jobs
  for (let i = 0; i < 5; i++) {
    const job = jobStore.create({ type: 'render_4k', params: { idx: i } });
    const res = await runJob(jobStore, job.id, mockAdapter, { outDir });
    assert.equal(res.state, 'done');
  }

  // All heavy slots must be released
  assert.equal(governor.getActiveLeases(RESOURCE_CLASSES.HEAVY).length, 0);
});

test('runJob with heavy job aborts before submit if heavy capacity is already saturated', async () => {
  const { governor, jobStore, rootDir } = createTestGovernor({ heavyLimit: 1 });
  const outDir = path.join(rootDir, 'artifacts_busy');

  // Saturate the only heavy slot
  const blockerLease = governor.acquire({ jobId: 'blocker_job', resourceClass: RESOURCE_CLASSES.HEAVY });
  assert.ok(blockerLease.token);

  let submitCalled = false;
  const mockAdapter = {
    async submit() {
      submitCalled = true;
      return { id: 'should_not_be_called' };
    },
    async poll() { return { status: 'pending' }; },
    async fetchArtifact() { return { bytes: Buffer.from(''), ext: '.tmp' }; },
  };

  const job = jobStore.create({ type: 'render_4k', params: {} });
  await assert.rejects(async () => {
    await runJob(jobStore, job.id, mockAdapter, { outDir, pollMs: 10, maxPolls: 5 });
  }, /Resource limit reached/);

  assert.equal(submitCalled, false, 'Adapter.submit must NEVER be called when admission fails');
  const storedJob = jobStore.get(job.id);
  assert.equal(storedJob.state, 'error');

  governor.release(blockerLease.token);
});

test('runJob with heavy job type succeeds when governor has capacity', async () => {
  const { governor, jobStore, rootDir, govDir } = createTestGovernor();
  const outDir = path.join(rootDir, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  let submitCalled = false;
  const mockAdapter = {
    async submit(params, ctx) { submitCalled = true; return { mockId: 'heavy_ok' }; },
    async poll(handle, ctx) { return { status: 'done', result: { url: 'mock' } }; },
    async fetchArtifact(result, ctx) { return { bytes: Buffer.from('heavy-video'), ext: '.mp4' }; },
  };

  const job = jobStore.create({ type: 'render_4k', params: {} });
  const result = await runJob(jobStore, job.id, mockAdapter, { outDir, pollMs: 10, maxPolls: 5 });

  assert.equal(submitCalled, true, 'Adapter.submit MUST be called when governor allows');
  assert.equal(result.state, 'done');
  // Verify lease was released
  const activeLeases = governor.getActiveLeases(RESOURCE_CLASSES.HEAVY);
  assert.equal(activeLeases.length, 0, 'Lease must be freed after job completes');
});

test('no slot leak: running 8 sequential light jobs does not exhaust governor', async () => {
  const { governor, jobStore, rootDir } = createTestGovernor({ lightLimit: 3 });
  const outDir = path.join(rootDir, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const mockAdapter = {
    async submit() { return { id: 'ok' }; },
    async poll() { return { status: 'done', result: { url: 'mock' } }; },
    async fetchArtifact() { return { bytes: Buffer.from('data'), ext: '.json' }; },
  };

  for (let i = 0; i < 8; i++) {
    const job = jobStore.create({ type: 'metadata', params: {} });
    const result = await runJob(jobStore, job.id, mockAdapter, { outDir, pollMs: 10, maxPolls: 3 });
    assert.equal(result.state, 'done', `Job ${i} must succeed`);
  }

  const activeLeases = governor.getActiveLeases();
  assert.equal(activeLeases.length, 0, 'All 8 jobs completed without leaking slots');
});

test('idempotent acquire for same jobId returns existing lease', () => {
  const { governor } = createTestGovernor();

  const lease1 = governor.acquire({
    jobId: 'job_idempotent_1',
    resourceClass: RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(lease1.token);

  // Second acquire with same jobId should return the same lease
  const lease2 = governor.acquire({
    jobId: 'job_idempotent_1',
    resourceClass: RESOURCE_CLASSES.HEAVY,
  });
  assert.equal(lease2.token, lease1.token, 'Must return existing lease for same jobId');

  // Third different job should be blocked
  assert.throws(() => {
    governor.acquire({
      jobId: 'job_idempotent_different',
      resourceClass: RESOURCE_CLASSES.HEAVY,
    });
  }, /Resource limit reached/);

  governor.release(lease1.token);
});

test('acquireAsync queues behind a held heavy slot and resolves once it frees, instead of failing immediately', async () => {
  const { governor } = createTestGovernor();

  const lease1 = governor.acquire({ jobId: 'job_queue_holder', resourceClass: RESOURCE_CLASSES.HEAVY });
  assert.ok(lease1.token);

  const start = Date.now();
  const waiterPromise = governor.acquireAsync({
    jobId: 'job_queue_waiter',
    resourceClass: RESOURCE_CLASSES.HEAVY,
    waitForSlotMs: 2000,
  });

  // Release the holder after a delay long enough that an immediate-fail
  // implementation would already have rejected the waiter.
  await new Promise((r) => setTimeout(r, 200));
  governor.release(lease1.token);

  const lease2 = await waiterPromise;
  assert.ok(lease2.token, 'waiter must eventually acquire the freed slot');
  assert.ok(Date.now() - start >= 150, 'waiter must have actually queued, not raced in immediately');
  governor.release(lease2.token);
});

test('acquireAsync gives up and throws once waitForSlotMs elapses with no free slot', async () => {
  const { governor } = createTestGovernor();

  const lease1 = governor.acquire({ jobId: 'job_queue_holder_2', resourceClass: RESOURCE_CLASSES.HEAVY });
  await assert.rejects(
    governor.acquireAsync({
      jobId: 'job_queue_waiter_2',
      resourceClass: RESOURCE_CLASSES.HEAVY,
      waitForSlotMs: 150,
    }),
    /Resource limit reached/,
  );
  governor.release(lease1.token);
});

test('JobStore.recoverInterruptedJobs detects dead PIDs, transitions to error, and releases slots', async () => {
  const { governor, jobStore } = createTestGovernor();

  // Create a job that holds a lease and simulates having a dead child PID
  const job = jobStore.create({
    type: 'render_export',
    params: { surface: 'cli', input: 'sample.mp4' },
  });
  const lease = governor.acquire({ jobId: job.id, resourceClass: RESOURCE_CLASSES.HEAVY });
  jobStore.setState(job.id, 'running', { leaseToken: lease.token });
  jobStore.checkpoint(job.id, 'childProcess', { pid: 99999999 }); // definitely dead PID

  assert.equal(jobStore.get(job.id).state, 'running');
  assert.equal(governor.getActiveLeases(RESOURCE_CLASSES.HEAVY).length, 1);

  // Run crash recovery
  const recovered = jobStore.recoverInterruptedJobs();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, job.id);

  const updatedJob = jobStore.get(job.id);
  assert.equal(updatedJob.state, 'error');
  assert.match(updatedJob.error, /Interrupted: process 99999999 died unexpectedly/);

  // Governor heavy slot must now be freed
  assert.equal(governor.getActiveLeases(RESOURCE_CLASSES.HEAVY).length, 0);
});

