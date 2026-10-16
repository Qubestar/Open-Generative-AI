// Governed subprocess runner for Vidmyo V2.6.
//
// Spawns a child process in its own process group (detached) under a
// ResourceGovernor lease, with optional wall-clock timeout and AbortSignal
// cancellation. Guarantees:
//   - Admission first: if the governor refuses, spawnImpl is never invoked.
//   - Idempotent per jobId: governor.acquire returns the existing lease.
//   - The lease is released only after the child's `exit` event.
//   - Timeout / cancel escalate to a process-group kill (SIGTERM then SIGKILL
//     via ResourceGovernor.cancelProcessTree), so grandchildren die too.
//   - Fail closed: no transport to external services; this only manages local
//     child processes.

import { spawn } from 'node:child_process';

function makeError(message, props = {}) {
  return Object.assign(new Error(message), props);
}

const STDERR_TAIL_BYTES = 8 * 1024;

// captureStdout: {maxBytes} — pipe stdout into a hard-capped buffer. On
// overflow the process tree is cancelled and the run rejects ESTDOUT_LIMIT,
// so a misbehaving render can never grow Node's heap without bound.
function resolveStdoutLimit(captureStdout) {
  if (captureStdout === null || captureStdout === undefined || captureStdout === false) return null;
  const maxBytes = typeof captureStdout === 'number' ? captureStdout : captureStdout?.maxBytes;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('captureStdout requires a positive maxBytes');
  }
  return Math.floor(maxBytes);
}

function stdioWithStdoutPipe(stdio) {
  if (Array.isArray(stdio)) {
    const copy = [...stdio];
    while (copy.length < 3) copy.push('ignore');
    copy[1] = 'pipe';
    return copy;
  }
  if (stdio === 'pipe') return ['pipe', 'pipe', 'pipe'];
  const side = stdio === 'inherit' ? 'inherit' : 'ignore';
  return [side, 'pipe', side];
}


// Keeps only the last STDERR_TAIL_BYTES of piped stderr so a failing render
// can surface a real diagnostic without unbounded memory growth.
class StderrTail {
  constructor(limit = STDERR_TAIL_BYTES) {
    this.limit = limit;
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.chunks.push(buf);
    this.length += buf.length;
    while (this.length > this.limit && this.chunks.length > 1) {
      this.length -= this.chunks[0].length;
      this.chunks.shift();
    }
    if (this.length > this.limit && this.chunks.length === 1) {
      const only = this.chunks[0];
      this.chunks[0] = only.subarray(only.length - this.limit);
      this.length = this.limit;
    }
  }

  toString() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Shared FFmpeg/ffprobe runner (Phase 4, item 1).
 *
 * Every FFmpeg process started for a render/export/preview goes through here
 * so the Phase 2/3 guarantees hold uniformly: governor admission first,
 * detached process group (cancel/timeout kill the WHOLE tree), lease released
 * only after the child exits, bounded stdout capture when asked.
 *
 * Exported from packages/core/index.js so screenStudio.js, avatarStudio.js and
 * RendererAdapter._runFfmpeg share ONE implementation instead of three.
 */
export async function runGovernedFfmpeg({
  cmd,
  args = [],
  cwd,
  env,
  governor = null,
  jobId = null,
  signal = null,
  timeoutMs = null,
  onSpawn = null,
  resourceClass = 'heavy',
  waitForSlotMs = 5000,
  stdio = ['ignore', 'ignore', 'pipe'],
  captureStdout = null,
  cancelEscalationMs = null,
  spawnImpl = undefined,
} = {}) {
  if (governor && !jobId) {
    throw new Error('runGovernedFfmpeg requires jobId when a governor is provided');
  }
  return runGovernedProcess({
    jobId,
    resourceClass,
    cmd,
    args,
    cwd,
    env,
    governor,
    signal,
    timeoutMs,
    onSpawn,
    stdio,
    detached: true,
    waitForSlotMs,
    captureStdout,
    cancelEscalationMs,
    spawnImpl,
  });
}

export async function runGovernedProcess({
  jobId,
  resourceClass = 'heavy',
  cmd,
  args = [],
  governor = null,
  parentReservationToken = null,
  timeoutMs = null,
  cancelEscalationMs = null,
  signal = null,
  spawnImpl = spawn,
  cwd,
  env,
  stdio = 'ignore',
  waitForSlotMs = 5000,
  detached = true,
  onSpawn = null,
  captureStdout = null,
} = {}) {
  if (!cmd) throw new Error('runGovernedProcess requires cmd');
  if (governor && !jobId) throw new Error('runGovernedProcess requires jobId when a governor is provided');

  // Pre-abort: an already-aborted signal must never spawn, never admit.
  if (signal?.aborted) {
    throw makeError('Process cancelled before spawn', { code: 'ECANCELLED', spawned: false });
  }

  const stdoutLimit = resolveStdoutLimit(captureStdout);
  const pipesStdout = stdoutLimit !== null;
  const effectiveStdio = pipesStdout ? stdioWithStdoutPipe(stdio) : stdio;

  // Admission first — a refusal here means spawnImpl is never called.
  let lease = null;
  if (governor) {
    lease = governor.acquire({
      jobId,
      resourceClass,
      parentReservationToken,
      waitForSlotMs,
    });
  }

  const releaseLease = () => {
    if (lease && governor) {
      try { governor.release(lease.token); } catch { /* already released */ }
      lease = null;
    }
  };

  // The signal may abort between admission and spawn — release and bail out.
  if (signal?.aborted) {
    releaseLease();
    throw makeError('Process cancelled before spawn', { code: 'ECANCELLED', spawned: false });
  }

  let child;
  try {
    child = spawnImpl(cmd, args, { cwd, env, stdio: effectiveStdio, detached });
  } catch (err) {
    releaseLease();
    throw err;
  }
  if (!child || typeof child.on !== 'function') {
    releaseLease();
    throw new Error('spawnImpl did not return a child process');
  }

  const pid = child.pid;

  // Capture a bounded stderr tail only when stderr is actually piped.
  const pipesStdio = Array.isArray(effectiveStdio) ? effectiveStdio[2] === 'pipe' : effectiveStdio === 'pipe';
  const stderrTail = new StderrTail();
  if (pipesStdio && child.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', (chunk) => stderrTail.push(chunk));
  }

  // Bounded stdout capture (captureStdout:{maxBytes}).
  const stdoutChunks = [];
  let stdoutBytes = 0;
  let stdoutOverflow = false;
  let killTreeRef = () => {};
  if (pipesStdout && child.stdout && typeof child.stdout.on === 'function') {
    child.stdout.on('data', (chunk) => {
      if (stdoutOverflow) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimit) {
        stdoutOverflow = true;
        stdoutChunks.length = 0;
        killTreeRef();
        return;
      }
      stdoutChunks.push(chunk);
    });
  }

  if (typeof onSpawn === 'function') {
    try { onSpawn(child); } catch { /* observer must not break the run */ }
  }

  let timedOut = false;
  let cancelled = false;
  let settled = false;
  const stderrText = () => stderrTail.toString();

  const withStderr = (err) => {
    const text = stderrText();
    if (text) err.stderr = text;
    return err;
  };

  const killTree = () => {
    if (!pid) return;
    const cancelOptions = Number.isFinite(cancelEscalationMs) && cancelEscalationMs > 0
      ? { killAfterMs: cancelEscalationMs }
      : {};
    if (governor) {
      try { governor.cancelProcessTree(pid, cancelOptions); } catch { /* best effort */ }
      return;
    }
    try { process.kill(-pid, 'SIGTERM'); } catch { /* not a process group leader */ }
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    const delay = cancelOptions.killAfterMs || 3000;
    const t = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }, delay);
    if (t && typeof t.unref === 'function') t.unref();
  };
  killTreeRef = killTree;

  return await new Promise((resolve, reject) => {
    let timer = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
    }

    const onAbort = () => {
      cancelled = true;
      killTree();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      releaseLease();
      fn(value);
    };

    child.on('error', (err) => {
      settle(reject, withStderr(makeError(`Failed to spawn process: ${err.message}`, {
        code: 'ESPAWN',
        pid,
        cause: err,
      })));
    });

    let graceTimer = null;
    let exitInfo = null;

    const settleExit = (exitCode, exitSignal) => {
      if (stdoutOverflow) {
        settle(reject, withStderr(makeError(
          `stdout exceeded the ${stdoutLimit} byte capture limit: ${cmd}`,
          { code: 'ESTDOUT_LIMIT', pid, exitCode, exitSignal, maxBytes: stdoutLimit },
        )));
        return;
      }
      if (timedOut) {
        settle(reject, withStderr(makeError(`Process timed out after ${timeoutMs}ms: ${cmd}`, {
          code: 'ETIMEDOUT',
          pid,
          exitCode,
          exitSignal,
        })));
        return;
      }
      if (cancelled) {
        settle(reject, withStderr(makeError('Process cancelled', {
          code: 'ECANCELLED',
          pid,
          exitCode,
          exitSignal,
        })));
        return;
      }
      if (exitCode !== 0) {
        settle(reject, withStderr(makeError(
          `Process exited with code ${exitCode}${exitSignal ? ` (signal ${exitSignal})` : ''}: ${cmd}`,
          { code: 'EEXIT', pid, exitCode, exitSignal },
        )));
        return;
      }
      settle(resolve, {
        pid,
        exitCode,
        signal: exitSignal,
        timedOut: false,
        cancelled: false,
        stderr: stderrText(),
        ...(pipesStdout ? { stdout: Buffer.concat(stdoutChunks) } : {}),
      });
    };

    if (pipesStdout) {
      // 'close' (not 'exit') guarantees the stdout stream has been flushed
      // into our buffer; a grace timer after 'exit' prevents a leaked
      // grandchild that inherits stdout from hanging the caller forever.
      child.on('close', (exitCode, exitSignal) => {
        if (graceTimer) clearTimeout(graceTimer);
        settleExit(exitCode, exitSignal);
      });
      child.on('exit', (exitCode, exitSignal) => {
        exitInfo = { exitCode, exitSignal };
        graceTimer = setTimeout(() => {
          settleExit(exitInfo.exitCode, exitInfo.exitSignal);
        }, 5000);
      });
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('error', () => { /* stream teardown must not wedge the run */ });
      }
      return;
    }

    child.on('exit', (exitCode, exitSignal) => {
      settleExit(exitCode, exitSignal);
    });
  });
}
