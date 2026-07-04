// Durable job store.
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
import os from 'node:os';
import crypto from 'node:crypto';

export const JOB_STATES = ['queued', 'running', 'done', 'error', 'cancelled'];

const TRANSITIONS = {
  queued: ['running', 'cancelled', 'error'],
  running: ['done', 'error', 'cancelled'],
  done: [],
  error: [],
  cancelled: [],
};

export function defaultJobsDir() {
  return path.join(os.homedir(), '.vidmyo', 'jobs');
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export class JobStore {
  constructor(dir = defaultJobsDir()) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  _file(id) {
    if (!/^job_[\w-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  create({ type, provider = null, params = {}, project = null }) {
    if (!type) throw new Error('Job type is required');
    const now = new Date().toISOString();
    const job = {
      id: `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
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

  setState(id, state, extra = {}) {
    if (!JOB_STATES.includes(state)) throw new Error(`Unknown job state: ${state}`);
    const job = this.get(id);
    if (!job) throw new Error(`No such job: ${id}`);
    if (!TRANSITIONS[job.state].includes(state)) {
      throw new Error(`Illegal transition ${job.state} → ${state} for ${id}`);
    }
    job.state = state;
    if (state === 'running' && !job.startedAt) job.startedAt = new Date().toISOString();
    if (['done', 'error', 'cancelled'].includes(state)) job.endedAt = new Date().toISOString();
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

  checkpoint(id, key, value) {
    const job = this.get(id);
    if (!job) throw new Error(`No such job: ${id}`);
    job.checkpoints[key] = value;
    return this._save(job);
  }

  cancel(id) {
    return this.setState(id, 'cancelled');
  }
}
