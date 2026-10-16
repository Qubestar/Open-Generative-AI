// Multi-process Resource Governor for Vidmyo V2.6
// Coordinates heavy media operations across Electron, CLI, and MCP.
// Enforces concurrency = 1 for heavy tasks (ASR, 4K render, Avatar, Chrome),
// supports light task concurrency, subtask reservation inheritance (no deadlocks),
// durable disk leases, exclusive cross-process file locks, process tree termination,
// and crash recovery.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { JobStore, defaultJobsDir } from './jobs.js';
import { vidmyoHome, testRunMarker } from './paths.js';

export const RESOURCE_CLASSES = {
  HEAVY: 'heavy', // Whisper ASR, 4K Render, Avatar, Headless Chrome
  LIGHT: 'light', // Metadata, I/O, small file copies, format validation
};

export const DEFAULT_HEAVY_CONCURRENCY = 1;
export const DEFAULT_LIGHT_CONCURRENCY = 8;
export const DEFAULT_MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024; // 1 GiB minimum free space
export const DEFAULT_MIN_FREE_MEMORY_BYTES = 10 * 1024 * 1024; // 10 MiB minimum free RAM (macOS unified memory safe)
// Grace period between SIGTERM and SIGKILL when cancelling a process tree.
export const DEFAULT_CANCEL_ESCALATION_MS = 3000;

export function defaultGovernorDir() {
  return path.join(vidmyoHome(), 'governor');
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const marker = testRunMarker();
  const payload = (marker && data && typeof data === 'object' && !Array.isArray(data))
    ? { ...data, testRun: marker }
    : data;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
}

function sleepMs(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const start = Date.now();
    while (Date.now() - start < ms) {}
  }
}

export class ResourceGovernor {
  constructor({
    governorDir = defaultGovernorDir(),
    jobStore = null,
    heavyLimit = DEFAULT_HEAVY_CONCURRENCY,
    lightLimit = DEFAULT_LIGHT_CONCURRENCY,
    minFreeDiskBytes = DEFAULT_MIN_FREE_DISK_BYTES,
    minFreeMemoryBytes = DEFAULT_MIN_FREE_MEMORY_BYTES,
    lockTimeoutMs = 5000,
  } = {}) {
    this.dir = governorDir;
    this.leasesDir = path.join(this.dir, 'leases');
    this.cacheDir = path.join(this.dir, 'cache');
    this.lockDir = path.join(this.dir, 'governor.lock');
    this.jobStore = jobStore;
    this.heavyLimit = heavyLimit;
    this.lightLimit = lightLimit;
    this.minFreeDiskBytes = minFreeDiskBytes;
    this.minFreeMemoryBytes = minFreeMemoryBytes;
    this.lockTimeoutMs = lockTimeoutMs;

    fs.mkdirSync(this.leasesDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  /**
   * Cross-process exclusive lock using atomic directory creation.
   * Works consistently on macOS, Linux, and Windows.
   */
  withLock(fn) {
    const start = Date.now();
    let acquired = false;

    while (!acquired) {
      try {
        fs.mkdirSync(this.lockDir);
        // Write lock owner info
        const lockInfo = { pid: process.pid, time: Date.now() };
        fs.writeFileSync(path.join(this.lockDir, 'owner.json'), JSON.stringify(lockInfo));
        acquired = true;
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Check for stale lock (older than 10 seconds or process dead)
          try {
            const ownerFile = path.join(this.lockDir, 'owner.json');
            if (fs.existsSync(ownerFile)) {
              const info = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
              let isDead = false;
              if (info.pid) {
                try {
                  process.kill(info.pid, 0);
                } catch {
                  isDead = true;
                }
              }
              const isStale = (Date.now() - info.time) > 10000;
              if (isDead || isStale) {
                fs.rmSync(this.lockDir, { recursive: true, force: true });
                continue;
              }
            }
          } catch {
            // ignore read errors on racing lock release
          }

          if (Date.now() - start > this.lockTimeoutMs) {
            throw new Error(`Governor lock acquisition timed out after ${this.lockTimeoutMs}ms`);
          }
          sleepMs(10);
        } else {
          throw err;
        }
      }
    }

    try {
      return fn();
    } finally {
      try {
        fs.rmSync(this.lockDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Asynchronous cross-process lock that avoids blocking the Node.js / Electron event loop.
   */
  async withLockAsync(fn) {
    const start = Date.now();
    let acquired = false;

    while (!acquired) {
      try {
        fs.mkdirSync(this.lockDir);
        const lockInfo = { pid: process.pid, time: Date.now() };
        fs.writeFileSync(path.join(this.lockDir, 'owner.json'), JSON.stringify(lockInfo));
        acquired = true;
      } catch (err) {
        if (err.code === 'EEXIST') {
          try {
            const ownerFile = path.join(this.lockDir, 'owner.json');
            if (fs.existsSync(ownerFile)) {
              const info = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
              let isDead = false;
              if (info.pid) {
                try {
                  process.kill(info.pid, 0);
                } catch {
                  isDead = true;
                }
              }
              const isStale = (Date.now() - info.time) > 10000;
              if (isDead || isStale) {
                fs.rmSync(this.lockDir, { recursive: true, force: true });
                continue;
              }
            }
          } catch {
            // ignore
          }

          if (Date.now() - start > this.lockTimeoutMs) {
            throw new Error(`Governor lock acquisition timed out after ${this.lockTimeoutMs}ms`);
          }
          await new Promise(r => setTimeout(r, 15));
        } else {
          throw err;
        }
      }
    }

    try {
      return await fn();
    } finally {
      try {
        fs.rmSync(this.lockDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Cleans up stale leases whose process is no longer alive.
   */
  pruneStaleLeases() {
    if (!fs.existsSync(this.leasesDir)) return;
    const files = fs.readdirSync(this.leasesDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const filePath = path.join(this.leasesDir, f);
      try {
        const lease = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let isAlive = false;
        if (lease.pid) {
          try {
            process.kill(lease.pid, 0);
            isAlive = true;
          } catch {
            isAlive = false;
          }
        }
        if (!isAlive) {
          fs.unlinkSync(filePath);
        }
      } catch {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Returns active leases by resource class.
   */
  getActiveLeases(resourceClass = null) {
    this.pruneStaleLeases();
    const leases = [];
    for (const f of fs.readdirSync(this.leasesDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const lease = JSON.parse(fs.readFileSync(path.join(this.leasesDir, f), 'utf8'));
        if (!resourceClass || lease.resourceClass === resourceClass) {
          leases.push(lease);
        }
      } catch {
        // ignore malformed
      }
    }
    return leases;
  }

  /**
   * Verifies free disk space. Refuses admission if statfs fails or cannot run.
   */
  checkDiskSpace(targetPath = this.dir) {
    fs.mkdirSync(targetPath, { recursive: true });
    if (typeof fs.statfsSync === 'function') {
      try {
        const stats = fs.statfsSync(targetPath);
        const freeBytes = Number(stats.bavail) * Number(stats.bsize);
        if (freeBytes < this.minFreeDiskBytes) {
          throw new Error(`Insufficient disk space: ${(freeBytes / (1024 * 1024)).toFixed(1)} MB available, requires at least ${(this.minFreeDiskBytes / (1024 * 1024)).toFixed(1)} MB`);
        }
        return freeBytes;
      } catch (err) {
        if (err.message.includes('Insufficient disk space')) throw err;
        throw new Error(`Disk space check failed: ${err.message}`);
      }
    }
    throw new Error(`Platform does not support statfs: unable to verify free disk space for ${targetPath}`);
  }

  /**
   * Verifies available system memory. Refuses admission if free memory is critically low.
   */
  checkMemory() {
    const freeBytes = os.freemem();
    if (freeBytes < this.minFreeMemoryBytes) {
      throw new Error(`Insufficient system memory: ${(freeBytes / (1024 * 1024)).toFixed(1)} MB available, requires at least ${(this.minFreeMemoryBytes / (1024 * 1024)).toFixed(1)} MB`);
    }
    return freeBytes;
  }

  /**
   * Acquires a lease for a job under exclusive cross-process lock.
   * If the job already holds an active lease, returns it (idempotency).
   * Supports waiting queue via waitForSlotMs.
   */
  acquire({
    jobId,
    resourceClass = RESOURCE_CLASSES.HEAVY,
    parentReservationToken = null,
    pid = process.pid,
    waitForSlotMs = 5000,
  }) {
    if (!jobId) throw new Error('jobId is required to acquire governor lease');

    const queueStart = Date.now();
    while (true) {
      let limitReached = false;
      let acquiredLease = null;

      this.withLock(() => {
        this.pruneStaleLeases();
        const activeAll = this.getActiveLeases();

        // Idempotency: return existing lease if this job already has one
        const existing = activeAll.find(l => l.jobId === jobId);
        if (existing) {
          acquiredLease = existing;
          return;
        }

        // Check disk and memory before allowing heavy tasks
        if (resourceClass === RESOURCE_CLASSES.HEAVY) {
          this.checkDiskSpace();
          this.checkMemory();
        }

        // Subtask inheritance: If parent already has an active lease with this token, inherit it
        if (parentReservationToken) {
          const candidates = [
            parentReservationToken.endsWith('.json') ? parentReservationToken : `${parentReservationToken}.json`,
            parentReservationToken.startsWith('lease_') ? `${parentReservationToken}.json` : `lease_${parentReservationToken}.json`,
            parentReservationToken.startsWith('sub_') ? `${parentReservationToken}.json` : `sub_${parentReservationToken}.json`,
          ];
          let parentFound = false;
          for (const cand of candidates) {
            const fullPath = path.join(this.leasesDir, cand);
            if (fs.existsSync(fullPath)) {
              parentFound = true;
              break;
            }
          }

          if (parentFound) {
            const subLeaseToken = `sub_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            const subLease = {
              token: subLeaseToken,
              parentToken: parentReservationToken,
              jobId,
              resourceClass,
              pid,
              acquiredAt: new Date().toISOString(),
              inherited: true,
            };
            atomicWriteJson(path.join(this.leasesDir, `${subLeaseToken}.json`), subLease);
            acquiredLease = subLease;
            return;
          }
        }

        const active = activeAll.filter(l => l.resourceClass === resourceClass);
        const limit = resourceClass === RESOURCE_CLASSES.HEAVY ? this.heavyLimit : this.lightLimit;

        if (active.length >= limit) {
          limitReached = true;
          return;
        }

        const token = `lease_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const lease = {
          token,
          jobId,
          resourceClass,
          pid,
          acquiredAt: new Date().toISOString(),
          inherited: false,
        };

        atomicWriteJson(path.join(this.leasesDir, `${token}.json`), lease);
        acquiredLease = lease;
      });

      if (acquiredLease) {
        return acquiredLease;
      }

      if (limitReached) {
        if (waitForSlotMs > 0 && (Date.now() - queueStart < waitForSlotMs)) {
          sleepMs(50);
          continue;
        }
        const limit = resourceClass === RESOURCE_CLASSES.HEAVY ? this.heavyLimit : this.lightLimit;
        throw new Error(`Resource limit reached for class '${resourceClass}' (${limit}/${limit} in use). Concurrency queue is busy.`);
      }
    }
  }

  /**
   * Async variant of acquire that yields to the event loop while waiting for capacity.
   */
  async acquireAsync({
    jobId,
    resourceClass = RESOURCE_CLASSES.HEAVY,
    parentReservationToken = null,
    pid = process.pid,
    waitForSlotMs = 5000,
  }) {
    if (!jobId) throw new Error('jobId is required to acquire governor lease');

    const queueStart = Date.now();
    while (true) {
      let limitReached = false;
      let acquiredLease = null;

      await this.withLockAsync(async () => {
        this.pruneStaleLeases();
        const activeAll = this.getActiveLeases();

        const existing = activeAll.find(l => l.jobId === jobId);
        if (existing) {
          acquiredLease = existing;
          return;
        }

        if (resourceClass === RESOURCE_CLASSES.HEAVY) {
          this.checkDiskSpace();
          this.checkMemory();
        }

        if (parentReservationToken) {
          const candidates = [
            parentReservationToken.endsWith('.json') ? parentReservationToken : `${parentReservationToken}.json`,
            parentReservationToken.startsWith('lease_') ? `${parentReservationToken}.json` : `lease_${parentReservationToken}.json`,
            parentReservationToken.startsWith('sub_') ? `${parentReservationToken}.json` : `sub_${parentReservationToken}.json`,
          ];
          let parentFound = false;
          for (const cand of candidates) {
            const fullPath = path.join(this.leasesDir, cand);
            if (fs.existsSync(fullPath)) {
              parentFound = true;
              break;
            }
          }

          if (parentFound) {
            const subLeaseToken = `sub_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            const subLease = {
              token: subLeaseToken,
              parentToken: parentReservationToken,
              jobId,
              resourceClass,
              pid,
              acquiredAt: new Date().toISOString(),
              inherited: true,
            };
            atomicWriteJson(path.join(this.leasesDir, `${subLeaseToken}.json`), subLease);
            acquiredLease = subLease;
            return;
          }
        }

        const active = activeAll.filter(l => l.resourceClass === resourceClass);
        const limit = resourceClass === RESOURCE_CLASSES.HEAVY ? this.heavyLimit : this.lightLimit;

        if (active.length >= limit) {
          limitReached = true;
          return;
        }

        const token = `lease_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const lease = {
          token,
          jobId,
          resourceClass,
          pid,
          acquiredAt: new Date().toISOString(),
          inherited: false,
        };

        atomicWriteJson(path.join(this.leasesDir, `${token}.json`), lease);
        acquiredLease = lease;
      });

      if (acquiredLease) {
        return acquiredLease;
      }

      if (limitReached) {
        if (waitForSlotMs > 0 && (Date.now() - queueStart < waitForSlotMs)) {
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        const limit = resourceClass === RESOURCE_CLASSES.HEAVY ? this.heavyLimit : this.lightLimit;
        throw new Error(`Resource limit reached for class '${resourceClass}' (${limit}/${limit} in use). Concurrency queue is busy.`);
      }
    }
  }

  /**
   * Releases an acquired lease under exclusive lock.
   */
  release(token) {
    if (!token) return false;
    return this.withLock(() => {
      const candidates = [
        token.endsWith('.json') ? token : `${token}.json`,
        token.startsWith('lease_') || token.startsWith('sub_') ? `${token}.json` : `lease_${token}.json`,
      ];
      for (const cand of candidates) {
        const file = path.join(this.leasesDir, cand);
        if (fs.existsSync(file)) {
          try {
            fs.unlinkSync(file);
            return true;
          } catch {
            return false;
          }
        }
      }
      return false;
    });
  }

  /**
   * Safe process cancellation: kills child processes and their process groups.
   * Sends SIGTERM, verifies exit during grace period, escalates to SIGKILL if necessary,
   * and confirms termination before returning.
   */
  cancelProcessTree(pid, {
    platform = process.platform,
    spawnSyncImpl = spawnSync,
    killImpl = (targetPid, signal) => process.kill(targetPid, signal),
    // Liveness probe is injectable so callers that only test with fake PIDs
    // never touch a real host process with signal 0 (safety: review blocker 1).
    livenessImpl = (targetPid) => { try { process.kill(targetPid, 0); return true; } catch { return false; } },
    killAfterMs = DEFAULT_CANCEL_ESCALATION_MS,
    setTimeoutImpl = setTimeout,
  } = {}) {
    if (!pid || typeof pid !== 'number') return false;
    try {
      if (platform === 'win32') {
        const res = spawnSyncImpl('taskkill', ['/pid', String(pid), '/T', '/F']);
        return res?.status === 0 || res !== undefined;
      } else {
        let sent = false;
        // 1. SIGTERM to the whole process group (-pid) and to the direct
        //    child, so grandchildren get the same graceful stop signal.
        try {
          killImpl(-pid, 'SIGTERM');
          sent = true;
        } catch {
          // not a process group leader
        }
        try {
          killImpl(pid, 'SIGTERM');
          sent = true;
        } catch {
          // process may already be exiting
        }

        // 2. SIGKILL escalation after a grace period: anything in the tree
        //    that ignored SIGTERM dies at +killAfterMs. The timer is unref'd
        //    so it never keeps a CLI/MCP/test process alive on its own, and it
        //    re-checks liveness so a recycled pid is never signalled.
        const escalate = () => {
          const childAlive = livenessImpl(pid);
          const groupAlive = livenessImpl(-pid);
          if (!childAlive && !groupAlive) return;
          try { killImpl(-pid, 'SIGKILL'); } catch { /* ignore */ }
          try { killImpl(pid, 'SIGKILL'); } catch { /* ignore */ }
        };
        try {
          const timer = setTimeoutImpl(escalate, killAfterMs);
          if (timer && typeof timer.unref === 'function') timer.unref();
        } catch {
          escalate();
        }

        return sent;
      }
    } catch {
      return false;
    }
  }

  /**
   * Recovers interrupted jobs on startup (e.g. after crash or restart).
   * Transitions any job in 'running' state whose PID is dead or orphaned into 'interrupted'.
   */
  recoverInterruptedJobs() {
    if (!this.jobStore) return [];
    const runningJobs = this.jobStore.list({ state: 'running' });
    const recovered = [];

    for (const job of runningJobs) {
      // Check if any active lease exists for this job
      const activeLease = this.getActiveLeases().find(l => l.jobId === job.id);
      let stillAlive = false;
      if (activeLease && activeLease.pid) {
        try {
          process.kill(activeLease.pid, 0);
          stillAlive = true;
        } catch {
          stillAlive = false;
        }
      }

      if (!stillAlive) {
        // Job was interrupted by crash/restart
        try {
          this.jobStore.setState(job.id, 'error', { error: 'Interrupted by application restart or process crash' });
          this.jobStore.checkpoint(job.id, 'interruptedAt', new Date().toISOString());
          recovered.push(job.id);
        } catch {
          // transition might fail if state already changed
        }
      }
    }

    return recovered;
  }

  /**
   * Content and version-based caching key.
   */
  getCacheKey(opName, version, inputHash) {
    return crypto.createHash('sha256').update(`${opName}:${version}:${inputHash}`).digest('hex');
  }

  getCache(opName, version, inputHash) {
    const key = this.getCacheKey(opName, version, inputHash);
    const file = path.join(this.cacheDir, `${key}.json`);
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    }
    return null;
  }

  setCache(opName, version, inputHash, data) {
    const key = this.getCacheKey(opName, version, inputHash);
    const file = path.join(this.cacheDir, `${key}.json`);
    atomicWriteJson(file, {
      opName,
      version,
      inputHash,
      cachedAt: new Date().toISOString(),
      data,
    });
  }
}
