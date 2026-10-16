// Phase 2 Item 3 — Governor 3-surface multiprocess proof.
//
// Three separate OS processes (electron-main / cli / mcp faithful stand-ins
// using the same governor code) start simultaneously against ONE isolated
// mkdtemp governor directory. Proves:
//   1. heavy-lock exclusivity across processes (no overlapping holds),
//   2. light-job concurrency (barrier: 3 processes hold light leases together),
//   3. cancel kills a whole child-process tree including grandchildren (macOS),
//   4. timeout on a real spawn kills the tree and rejects ETIMEDOUT,
//   5. refusal when disk space is too low — spawnImpl is never invoked,
//   6. the default governor directory is never touched (runId leak scan).
//
// Commands and exit codes are recorded to
// .tmp/vidmyo-v2.6/governor_3surface_evidence.json.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ResourceGovernor, RESOURCE_CLASSES, defaultGovernorDir } from '../src/governor.js';
import { runGovernedProcess } from '../src/governedProcess.js';
import { JobStore } from '../src/jobs.js';

const RUN_ID = `m3s_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EVIDENCE_PATH = fileURLToPath(
  new URL('../../../.tmp/vidmyo-v2.6/governor_3surface_evidence.json', import.meta.url),
);

const evidence = {
  runId: RUN_ID,
  platform: process.platform,
  node: process.version,
  recordedAt: new Date().toISOString(),
  scenarios: [],
};

function record(scenario) {
  evidence.scenarios.push(scenario);
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
}

after(() => {
  record({ scenario: 'suite-finished', at: new Date().toISOString() });
});

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate, timeoutMs = 5000, stepMs = 40) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

function findRunIdInDir(dir, runId) {
  if (!fs.existsSync(dir)) return [];
  const hits = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        try {
          if (fs.readFileSync(p, 'utf8').includes(runId)) hits.push(p);
        } catch { /* binary or vanished */ }
      }
    }
  };
  walk(dir);
  return hits;
}

// ---------------------------------------------------------------------------
// Scenario 1 — three surfaces start together: heavy exclusivity + light barrier
// ---------------------------------------------------------------------------
test('3 separate processes: heavy-lock exclusivity, light-job concurrency, default governor dir untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-m3s-'));
  const govDir = path.join(root, 'governor');
  const logPath = path.join(root, 'heavy.jsonl');
  const goFile = path.join(root, 'go');
  const readyDir = path.join(root, 'ready');
  fs.mkdirSync(readyDir, { recursive: true });
  const defaultDir = defaultGovernorDir();

  const surfaces = ['electron_main', 'cli', 'mcp'];
  const commands = [];
  const exitCodes = {};
  const children = [];

  // Each surface is a faithful stand-in for its real entry point:
  //  - electron_main uses JobStore admission (same path as Electron main),
  //  - cli and mcp use the ResourceGovernor API directly (same code the
  //    CLI runner and MCP services call through JobStore/runJob).
  // All three are spawned FIRST and block on the shared go-file, so the
  // governor phases start simultaneously.
  for (const surface of surfaces) {
    const scriptPath = path.join(root, `${surface}.mjs`);
    const srcPath = pathToFileURL(fileURLToPath(new URL('../src/governor.js', import.meta.url))).href;
    const jobsPath = pathToFileURL(fileURLToPath(new URL('../src/jobs.js', import.meta.url))).href;
    const usesJobStore = surface === 'electron_main';
    fs.writeFileSync(scriptPath, `
      import fs from 'node:fs';
      import path from 'node:path';
      import { ResourceGovernor, RESOURCE_CLASSES } from ${JSON.stringify(srcPath)};
      import { JobStore } from ${JSON.stringify(jobsPath)};
      const [govDir, jobsDir, logPath, goFile, runId, surface, readyDir] = process.argv.slice(2);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const append = (obj) => fs.appendFileSync(logPath, JSON.stringify(obj) + '\\n');
      const goDeadline = Date.now() + 10000;
      while (!fs.existsSync(goFile)) {
        if (Date.now() > goDeadline) { append({ surface, event: 'go_timeout' }); process.exit(2); }
        await sleep(10);
      }
      const gov = new ResourceGovernor({ governorDir: govDir, heavyLimit: 1, lightLimit: 8 });
      const useJobStore = ${usesJobStore ? 'true' : 'false'};
      const store = useJobStore ? new JobStore(jobsDir, { governor: gov }) : null;
      const light1 = gov.acquire({ jobId: runId + '_' + surface + '_l1', resourceClass: RESOURCE_CLASSES.LIGHT });
      const light2 = gov.acquire({ jobId: runId + '_' + surface + '_l2', resourceClass: RESOURCE_CLASSES.LIGHT });
      fs.writeFileSync(path.join(readyDir, surface + '.ready'), '1');
      const barrierDeadline = Date.now() + 5000;
      let barrierOk = false;
      while (Date.now() < barrierDeadline) {
        const ready = fs.readdirSync(readyDir).filter((f) => f.endsWith('.ready'));
        if (ready.length === 3) { barrierOk = true; break; }
        await sleep(20);
      }
      if (!barrierOk) { append({ surface, event: 'light_barrier_timeout' }); process.exit(3); }
      append({ surface, event: 'light_barrier_ok', at: Date.now() });
      gov.release(light2.token);
      gov.release(light1.token);
      let admitted = false;
      const heavyDeadline = Date.now() + 8000;
      const heavyJobId = runId + '_' + surface + '_heavy';
      while (Date.now() < heavyDeadline) {
        try {
          if (useJobStore) {
            const job = store.create({ type: 'render_4k_' + runId, params: { surface, admit: false } });
            store.admit(job.id);
            store.setState(job.id, 'running', { admit: false });
            append({ surface, event: 'heavy_start', at: Date.now(), pid: process.pid });
            await sleep(150);
            append({ surface, event: 'heavy_end', at: Date.now(), pid: process.pid });
            store.setState(job.id, 'done');
            admitted = true;
          } else {
            gov.acquire({ jobId: heavyJobId, resourceClass: RESOURCE_CLASSES.HEAVY });
            append({ surface, event: 'heavy_start', at: Date.now(), pid: process.pid });
            await sleep(150);
            append({ surface, event: 'heavy_end', at: Date.now(), pid: process.pid });
            const lease = gov.getActiveLeases(RESOURCE_CLASSES.HEAVY).find((l) => l.jobId === heavyJobId);
            if (!lease) { append({ surface, event: 'heavy_release_missing' }); process.exit(5); }
            gov.release(lease.token);
            admitted = true;
          }
          break;
        } catch (err) {
          await sleep(25);
        }
      }
      if (!admitted) { append({ surface, event: 'heavy_timeout' }); process.exit(4); }
      append({ surface, event: 'done', at: Date.now() });
      process.exit(0);
    `);
    const cmd = process.execPath;
    const args = [
      scriptPath,
      govDir,
      path.join(root, `${surface}_jobs`),
      logPath,
      goFile,
      RUN_ID,
      surface,
      readyDir,
    ];
    commands.push([cmd, ...args].join(' '));
    children.push(new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('close', (code) => { exitCodes[surface] = code; resolve(); });
    }));
  }

  // All three processes are running and waiting on goFile — release them now.
  fs.writeFileSync(goFile, String(Date.now()));
  await Promise.all(children);

  record({
    scenario: 'three-surface-simultaneous',
    commands,
    exitCodes,
  });

  assert.deepEqual(exitCodes, { electron_main: 0, cli: 0, mcp: 0 },
    `all three surfaces must exit 0, got ${JSON.stringify(exitCodes)}`);

  // Parse heavy windows — exclusivity: no overlapping intervals.
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.event === 'light_barrier_ok'),
    'light barrier must have been passed by all three processes');
  assert.equal(lines.filter((l) => l.event === 'light_barrier_timeout').length, 0);

  const starts = lines.filter((l) => l.event === 'heavy_start').sort((a, b) => a.at - b.at);
  const ends = new Map(lines.filter((l) => l.event === 'heavy_end').map((l) => [l.surface, l.at]));
  assert.equal(starts.length, 3, 'each surface must have held heavy exactly once');
  for (let i = 0; i < starts.length - 1; i++) {
    const endI = ends.get(starts[i].surface);
    assert.ok(typeof endI === 'number', `heavy_end missing for ${starts[i].surface}`);
    assert.ok(starts[i + 1].at >= endI,
      `heavy overlap: ${starts[i + 1].surface} started at ${starts[i + 1].at} before ${starts[i].surface} ended at ${endI}`);
  }

  // Default governor directory must not contain any trace of this run.
  const leaks = findRunIdInDir(defaultDir, RUN_ID);
  assert.deepEqual(leaks, [], `default governor dir must be untouched, found runId in: ${leaks.join(', ')}`);
  assert.notEqual(path.resolve(govDir), path.resolve(defaultDir));
  assert.ok(fs.existsSync(path.join(govDir, 'leases')), 'isolated governor leases dir must exist');

  // Cleanup temp fixtures (tiny, but keep the host clean).
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 2 — cancel kills the whole tree, grandchildren included
// ---------------------------------------------------------------------------
test('cancelProcessTree kills grandchildren, not just the direct child (macOS)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-m3s-tree-'));
  const govDir = path.join(root, 'governor');
  const gov = new ResourceGovernor({ governorDir: govDir });
  const pidFile = path.join(root, 'pids.json');

  // Parent spawns a grandchild, writes both PIDs, then idles.
  const parentSrc = `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
  `;
  const parentPath = path.join(root, 'parent.mjs');
  fs.writeFileSync(parentPath, parentSrc);

  const command = [process.execPath, parentPath].join(' ');
  let runError = null;
  const runPromise = runGovernedProcess({
    jobId: `${RUN_ID}_tree`,
    resourceClass: RESOURCE_CLASSES.HEAVY,
    cmd: process.execPath,
    args: [parentPath],
    governor: gov,
    spawnImpl: spawn,
  }).catch((err) => { runError = err; });

  const gotPids = await waitFor(() => fs.existsSync(pidFile), 5000);
  assert.ok(gotPids, 'parent must publish pids.json');
  const { parent, child: grandchild } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(isAlive(parent), 'parent alive before cancel');
  assert.ok(isAlive(grandchild), 'grandchild alive before cancel');

  // ps snapshot before cancel (pgid proof — same group).
  const psLines = () => spawnSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' }).stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      const pidCol = parseInt(l.split(/\s+/)[0], 10);
      return pidCol === parent || pidCol === grandchild;
    });
  const psBefore = psLines();
  assert.equal(psBefore.length, 2, 'both parent and grandchild must be alive before cancel');

  const cancelled = gov.cancelProcessTree(parent);
  assert.equal(cancelled, true);

  const parentDead = await waitFor(() => !isAlive(parent), 5000);
  const childDead = await waitFor(() => !isAlive(grandchild), 5000);
  await runPromise;

  const psAfter = psLines();

  record({
    scenario: 'cancel-whole-tree',
    command,
    cancelTargetPid: parent,
    grandchildPid: grandchild,
    psBefore,
    psAfter,
    runGovernedProcessError: runError ? { code: runError.code, message: runError.message } : null,
    parentDead,
    grandchildDead: childDead,
  });

  assert.equal(parentDead, true, 'direct child must be dead after cancel');
  assert.equal(childDead, true, 'grandchild must be dead after cancel (whole tree)');
  assert.deepEqual(psAfter, [], 'ps must show no surviving processes from the tree');
  assert.equal(gov.getActiveLeases().length, 0, 'lease released after exit');

  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 3 — timeout on a real spawn kills the tree (incl. grandchild)
// ---------------------------------------------------------------------------
test('runGovernedProcess timeout on a real spawn rejects ETIMEDOUT and kills the tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-m3s-timeout-'));
  const govDir = path.join(root, 'governor');
  const gov = new ResourceGovernor({ governorDir: govDir });
  const pidFile = path.join(root, 'pids.json');

  const src = `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
  `;
  const scriptPath = path.join(root, 'slow.mjs');
  fs.writeFileSync(scriptPath, src);

  const command = [process.execPath, scriptPath].join(' ');
  const started = Date.now();
  const err = await runGovernedProcess({
    jobId: `${RUN_ID}_timeout`,
    resourceClass: RESOURCE_CLASSES.HEAVY,
    cmd: process.execPath,
    args: [scriptPath],
    governor: gov,
    timeoutMs: 600,
    spawnImpl: spawn,
  }).then(() => null, (e) => e);
  const elapsed = Date.now() - started;

  assert.ok(err, 'timed-out run must reject');
  assert.equal(err.code, 'ETIMEDOUT');
  assert.ok(elapsed >= 550, `must wait for the timeout (elapsed ${elapsed}ms)`);
  assert.ok(elapsed < 8000, `must not hang (elapsed ${elapsed}ms)`);

  let pids = { parent: null, child: null };
  if (fs.existsSync(pidFile)) pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  const parentDead = pids.parent ? await waitFor(() => !isAlive(pids.parent), 5000) : true;
  const childDead = pids.child ? await waitFor(() => !isAlive(pids.child), 5000) : true;

  record({
    scenario: 'timeout-real-spawn',
    command,
    timeoutMs: 600,
    elapsedMs: elapsed,
    errorCode: err.code,
    pids,
    parentDead,
    childDead,
    leaseCountAfter: gov.getActiveLeases().length,
  });

  assert.equal(parentDead, true, 'timed-out parent must be dead');
  assert.equal(childDead, true, 'timed-out grandchild must be dead');
  assert.equal(gov.getActiveLeases().length, 0, 'lease released after timeout exit');

  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 4 — disk-space refusal: spawnImpl must never run
// ---------------------------------------------------------------------------
test('runGovernedProcess refuses admission when disk space is too low (spawn never invoked)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-m3s-disk-'));
  const gov = new ResourceGovernor({
    governorDir: path.join(root, 'governor'),
    minFreeDiskBytes: 1000 * 1024 * 1024 * 1024 * 1024, // 1000 TB — impossible
  });

  let spawnInvoked = false;
  const command = `${process.execPath} -e <never-runs>`;
  const err = await runGovernedProcess({
    jobId: `${RUN_ID}_disk`,
    resourceClass: RESOURCE_CLASSES.HEAVY,
    cmd: process.execPath,
    args: ['-e', 'process.exit(0)'],
    governor: gov,
    spawnImpl: (...spawnArgs) => {
      spawnInvoked = true;
      return spawn(...spawnArgs);
    },
  }).then(() => null, (e) => e);

  assert.ok(err, 'admission must be refused');
  assert.match(err.message, /Insufficient disk space/);
  assert.equal(spawnInvoked, false, 'spawnImpl must NOT be invoked on refusal');
  assert.equal(gov.getActiveLeases().length, 0, 'no lease leaked on refusal');

  record({
    scenario: 'disk-refusal',
    command,
    errorCode: 'admission-denied',
    errorMessage: err.message,
    spawnInvoked,
  });

  fs.rmSync(root, { recursive: true, force: true });
});
