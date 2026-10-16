// Durable job store with multi-process governor admission control.
//
// Every long-running media operation gets a job record that survives app
// restarts: one JSON file per job, written atomically (tmp + rename). The
// desktop UI, CLI, and MCP server all read the same directory, which is what
// lets a job started in one interface be inspected or continued in another.
//
// States: queued → running → done | error | cancelled
// (`cancelled` is reachable from queued/running only.)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ResourceGovernor, RESOURCE_CLASSES, defaultGovernorDir } from './governor.js';
import { vidmyoHome, testRunMarker } from './paths.js';

export const JOB_STATES = ['queued', 'running', 'done', 'error', 'cancelled'];

const TRANSITIONS = {
  queued: ['running', 'cancelled', 'error'],
  running: ['done', 'error', 'cancelled'],
  done: [],
  error: [],
  cancelled: [],
};

export function defaultJobsDir() {
  return path.join(vidmyoHome(), 'jobs');
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function isHeavyJobType(type) {
  const str = String(type || '').toLowerCase();
  return ['render', 'repurpose', 'asr', 'whisper', 'cleaner', 'avatar', 'cartoon', 'wan2gp'].some(k => str.includes(k));
}

export class JobStore {
  constructor(dir = defaultJobsDir(), { governor = null, governorDir = null } = {}) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    const govDir = governorDir || (dir === defaultJobsDir()
      ? defaultGovernorDir()
      : path.join(dir, '.governor'));
    this.governor = governor || new ResourceGovernor({
      governorDir: govDir,
      jobStore: this,
    });
    if (!this.governor.jobStore) {
      this.governor.jobStore = this;
    }
  }

  _file(id) {
    if (!/^job_[\w-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  create({ id = null, type, provider = null, params = {}, project = null }) {
    if (!type) throw new Error('Job type is required');
    const now = new Date().toISOString();
    const job = {
      id: id || `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      type,                 // e.g. 'image', 'video', 'story', 'story-scene'
      provider,             // provider id, or null for multi-provider jobs
      project,              // project id, when the job belongs to a project
      params,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
      logs: [],
      artifacts: [],        // [{ path, kind, sceneId?, createdAt }]
      checkpoints: {},      // resumable progress, e.g. { lastCompletedScene: 's004' }
      error: null,
    };
    // Test-run provenance (Phase 3 item 1): only present when the isolated
    // test wrapper set VIDMYO_TEST_RUN; production records are unchanged.
    const marker = testRunMarker();
    if (marker) job.testRun = marker;
    atomicWriteJson(this._file(job.id), job);
    return job;
  }

  get(id) {
    try {
      return JSON.parse(fs.readFileSync(this._file(id), 'utf8'));
    } catch {
      return null;
    }
  }

  list({ state = null, type = null } = {}) {
    const jobs = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.startsWith('job_') || !f.endsWith('.json')) continue;
      try {
        jobs.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')));
      } catch {
        // Skip unreadable/corrupt records rather than failing the listing.
      }
    }
    return jobs
      .filter(j => (state ? j.state === state : true))
      .filter(j => (type ? j.type === type : true))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  _save(job) {
    job.updatedAt = new Date().toISOString();
    atomicWriteJson(this._file(job.id), job);
    return job;
  }

  /**
   * Explicit governor admission for a job.
   */
  admit(jobId, { resourceClass = null, parentReservationToken = null, pid = process.pid } = {}) {
    const job = this.get(jobId);
    if (!job) throw new Error(`No such job: ${jobId}`);
    const determinedClass = resourceClass
      || job.params?.resourceClass
      || (isHeavyJobType(job.type) ? RESOURCE_CLASSES.HEAVY : RESOURCE_CLASSES.LIGHT);

    const lease = this.governor.acquire({
      jobId,
      resourceClass: determinedClass,
      parentReservationToken: parentReservationToken || job.params?.parentReservationToken,
      pid,
    });
    this.checkpoint(jobId, 'leaseToken', lease.token);
    return lease;
  }

  /**
   * Async admission — waits up to `waitForSlotMs` for a free slot instead of
   * failing immediately when the resource class is at capacity. Uses
   * governor.acquireAsync so it yields to the event loop while queued
   * (does not block other IPC/CLI/MCP activity in the same process).
   */
  async admitAsync(jobId, { resourceClass = null, parentReservationToken = null, pid = process.pid, waitForSlotMs = 0 } = {}) {
    const job = this.get(jobId);
    if (!job) throw new Error(`No such job: ${jobId}`);
    const determinedClass = resourceClass
      || job.params?.resourceClass
      || (isHeavyJobType(job.type) ? RESOURCE_CLASSES.HEAVY : RESOURCE_CLASSES.LIGHT);

    const lease = await this.governor.acquireAsync({
      jobId,
      resourceClass: determinedClass,
      parentReservationToken: parentReservationToken || job.params?.parentReservationToken,
      pid,
      waitForSlotMs,
    });
    this.checkpoint(jobId, 'leaseToken', lease.token);
    return lease;
  }

  /**
   * Release governor lease for a job.
   */
  releaseLease(jobId) {
    const job = this.get(jobId);
    if (!job) return false;
    const token = job.checkpoints?.leaseToken;
    if (token) {
      this.governor.release(token);
      this.checkpoint(jobId, 'leaseToken', null);
      return true;
    }
    return false;
  }

  setState(id, state, extra = {}) {
    if (!JOB_STATES.includes(state)) throw new Error(`Unknown job state: ${state}`);
    const job = this.get(id);
    if (!job) throw new Error(`No such job: ${id}`);
    if (!TRANSITIONS[job.state].includes(state)) {
      throw new Error(`Illegal transition ${job.state} → ${state} for ${id}`);
    }
    job.state = state;
    if (state === 'running' && !job.startedAt) {
      job.startedAt = new Date().toISOString();
      if (extra.leaseToken) {
        job.checkpoints.leaseToken = extra.leaseToken;
      } else if (!job.checkpoints?.leaseToken && extra.admit !== false && job.params?.admit !== false) {
        try {
          const lease = this.admit(id, {
            resourceClass: extra.resourceClass,
            parentReservationToken: extra.parentReservationToken,
          });
          job.checkpoints.leaseToken = lease.token;
        } catch (err) {
          job.error = `Governor admission denied: ${err.message}`;
          job.state = 'error';
          job.endedAt = new Date().toISOString();
          return this._save(job);
        }
      }
    }
    if (['done', 'error', 'cancelled'].includes(state)) {
      job.endedAt = new Date().toISOString();
      // Release governor lease if job held one
      if (job.checkpoints?.leaseToken) {
        try {
          this.governor.release(job.checkpoints.leaseToken);
          job.checkpoints.leaseToken = null;
        } catch {
          // ignore release errors
        }
      }
    }
    if (extra.error) job.error = String(extra.error);
    return this._save(job);
  }

  log(id, message) {
    const job = this.get(id);
    if (!job) throw new Error(`No such job: ${id}`);
    job.logs.push({ at: new Date().toISOString(), message: String(message) });
    return this._save(job);
  }

  addArtifact(id, { path: artifactPath, kind = 'file', sceneId = null }) {
    const job = this.get(id);
    if (!job) throw new Error(`No such job: ${id}`);
    job.artifacts.push({
      path: artifactPath,
      kind,
      ...(sceneId ? { sceneId } : {}),
      createdAt: new Date().toISOString(),
    });
    return this._save(job);
  }

  artifact(id, opts) {
    return this.addArtifact(id, opts);
  }

  checkpoint(id, key, value) {
    const job = this.get(id);
    if (!job) throw new Error(`No such job: ${id}`);
    job.checkpoints[key] = value;
    return this._save(job);
  }

  cancel(id) {
    const job = this.get(id);
    if (job) {
      const pid = job.checkpoints?.childProcess?.pid;
      if (pid) {
        // Step 1: Send SIGTERM to process tree
        try {
          this.governor.cancelProcessTree(pid);
        } catch {
          // ignore
        }
        // Step 2: Verify process exit before releasing slot (up to 3s)
        let processExited = false;
        for (let i = 0; i < 30; i++) {
          try {
            process.kill(pid, 0);
            // still alive, wait 100ms
            const start = Date.now();
            while (Date.now() - start < 100) { /* busy wait */ }
          } catch {
            processExited = true;
            break;
          }
        }
        if (!processExited) {
          // Escalate to SIGKILL
          try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
          try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
          // Final wait for SIGKILL (up to 1s)
          for (let i = 0; i < 10; i++) {
            try {
              process.kill(pid, 0);
              const start = Date.now();
              while (Date.now() - start < 100) { /* busy wait */ }
            } catch {
              break;
            }
          }
        }
      }
      // Step 3: Release governor slot only after process confirmed dead
      if (job.checkpoints?.leaseToken) {
        try {
          this.governor.release(job.checkpoints.leaseToken);
          job.checkpoints.leaseToken = null;
        } catch {
          // ignore
        }
      }
    }
    return this.setState(id, 'cancelled');
  }

  resume(id) {
    const job = this.get(id);
    if (!job) throw new Error(`No such job: ${id}`);
    if (job.state !== 'error' || !job.checkpoints?.handle) {
      throw new Error(`Job ${id} cannot resume safely from ${job.state}`);
    }
    job.state = 'running';
    job.endedAt = null;
    job.error = null;
    return this._save(job);
  }

  /**
   * Recovers jobs that were left in 'running' state after a process crash,
   * daemon restart, or unexpected interruption across Electron, CLI, or MCP.
   * If the associated PID is dead, transitions the job to 'error' with an
   * explanatory message, releases any leaked governor slot, and flags it
   * as eligible for resume if a handle exists.
   */
  recoverInterruptedJobs({ surface = null } = {}) {
    const runningJobs = this.list({ state: 'running' });
    const recovered = [];

    for (const job of runningJobs) {
      if (surface && job.params?.surface && job.params.surface !== surface) {
        continue;
      }

      const pid = job.checkpoints?.childProcess?.pid || job.pid;
      let isAlive = false;
      if (pid) {
        try {
          process.kill(pid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
      }

      if (!isAlive) {
        // Process is dead: release lease
        if (job.checkpoints?.leaseToken) {
          try {
            this.governor.release(job.checkpoints.leaseToken);
            job.checkpoints.leaseToken = null;
          } catch {
            // ignore
          }
        }

        job.state = 'error';
        job.error = `Interrupted: process ${pid || 'unknown'} died unexpectedly while running`;
        job.endedAt = new Date().toISOString();
        this._save(job);
        recovered.push(job);
      }
    }

    return recovered;
  }
}

