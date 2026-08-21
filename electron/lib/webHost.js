'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { fork } = require('node:child_process');

function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function fetchStatus(url, requestImpl = http.get) {
  return new Promise(resolve => {
    const request = requestImpl(url, response => {
      response.resume?.();
      resolve({ ok: response.statusCode >= 200 && response.statusCode < 400, status: response.statusCode });
    });
    request.setTimeout?.(1000, () => request.destroy());
    request.once('error', () => resolve({ ok: false, status: null }));
  });
}

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function createWebHost({ forkImpl = fork, requestImpl = http.get, freePortImpl = freePort } = {}) {
  let child = null;
  let state = null;

  async function start({ serverDir, timeoutMs = 20000 } = {}) {
    if (state) return state;
    const root = path.resolve(serverDir || '');
    const entry = path.join(root, 'server.js');
    if (!serverDir || !fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
      throw new Error(`Packaged web server is missing: ${entry}`);
    }
    const port = await freePortImpl('127.0.0.1');
    let output = '';
    child = forkImpl(entry, [], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOSTNAME: '127.0.0.1',
        PORT: String(port),
        ELECTRON_RUN_AS_NODE: '1',
      },
      silent: true,
    });
    const collect = chunk => { output = `${output}${String(chunk)}`.slice(-2000); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (child.exitCode !== null || child.killed) {
        child = null;
        throw new Error(`Packaged web server exited before readiness: ${output.trim() || 'no output'}`);
      }
      const result = await fetchStatus(`http://127.0.0.1:${port}/studio`, requestImpl);
      if (result.ok) {
        state = { url: `http://127.0.0.1:${port}/studio`, port, pid: child.pid };
        return state;
      }
      await delay(100);
    }
    child.kill('SIGTERM');
    child = null;
    throw new Error(`Packaged web server was not ready within ${timeoutMs}ms: ${output.trim() || 'no output'}`);
  }

  async function stop({ timeoutMs = 5000 } = {}) {
    const owned = child;
    child = null;
    state = null;
    if (!owned || owned.exitCode !== null) return;
    const exited = new Promise(resolve => owned.once('exit', resolve));
    owned.kill('SIGTERM');
    const timeout = delay(timeoutMs).then(() => 'timeout');
    if (await Promise.race([exited, timeout]) === 'timeout' && owned.exitCode === null) {
      owned.kill('SIGKILL');
      await Promise.race([exited, delay(1000)]);
    }
  }

  return { start, stop, info: () => state, ownedProcess: () => child };
}

module.exports = { createWebHost, fetchStatus, freePort };
