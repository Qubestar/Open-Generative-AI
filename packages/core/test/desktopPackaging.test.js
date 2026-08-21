import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveRuntimePaths } = require('../../../electron/lib/runtimePaths.js');
const { createWebHost } = require('../../../electron/lib/webHost.js');
const repo = path.resolve(import.meta.dirname, '../../..');

test('runtime paths never substitute developer locations in a packaged app', () => {
  const dev = resolveRuntimePaths({ repoRoot: repo, isPackaged: false });
  assert.equal(dev.mcpDir, path.join(repo, 'mcp'));
  assert.equal(dev.repurposeEngineDir, path.join(repo, 'packages', 'repurpose-engine'));
  assert.equal(dev.webDir, null);

  const packaged = resolveRuntimePaths({
    repoRoot: '/developer/source', isPackaged: true, resourcesPath: '/Applications/Vidmyo/Resources',
  });
  assert.equal(packaged.webDir, '/Applications/Vidmyo/Resources/web');
  assert.equal(packaged.mcpDir, '/Applications/Vidmyo/Resources/mcp');
  assert.equal(packaged.repurposeEngineDir, '/Applications/Vidmyo/Resources/packages/repurpose-engine');
  assert.doesNotMatch(JSON.stringify(packaged), /developer\/source\/mcp|developer\/source\/packages/);
});

test('web host starts one owned standalone process, waits for /studio, and terminates it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-web-host-'));
  fs.writeFileSync(path.join(root, 'server.js'), '// fixture');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.pid = 43210;
  child.kill = signal => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0, signal);
    return true;
  };
  let forkCall;
  const forkImpl = (...args) => { forkCall = args; return child; };
  const requestImpl = (url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    setImmediate(() => callback({ statusCode: 200, resume() {} }));
    return request;
  };
  const host = createWebHost({ forkImpl, requestImpl, freePortImpl: async () => 34567 });
  const started = await host.start({ serverDir: root, timeoutMs: 1000 });
  assert.equal(started.url, 'http://127.0.0.1:34567/studio');
  assert.equal(forkCall[0], path.join(root, 'server.js'));
  assert.equal(forkCall[2].cwd, root);
  assert.equal(forkCall[2].env.HOSTNAME, '127.0.0.1');
  assert.equal(forkCall[2].env.ELECTRON_RUN_AS_NODE, '1');
  await host.stop();
  assert.equal(child.killed, true);
});

test('desktop package manifest includes bounded runtime resources and excludes secrets/tests', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const resources = Object.fromEntries(pkg.build.extraResources.map(item => [item.to, item]));
  assert.ok(resources.web);
  assert.ok(resources.mcp.filter.includes('node_modules/**/*'));
  assert.ok(resources.mcp.filter.includes('!node_modules/**/test/**/*'));
  assert.ok(resources.mcp.filter.includes('!node_modules/**/tests/**/*'));
  assert.ok(resources.mcp.filter.includes('!node_modules/**/*.test.*'));
  assert.deepEqual(resources['packages/repurpose-engine'].filter.sort(), [
    'README.md', 'models/**/*', 'pyproject.toml', 'schemas/**/*', 'src/**/*',
  ]);
  assert.ok(resources.web.filter.includes('!**/.env'));
  assert.ok(resources.web.filter.includes('!**/.env.*'));
  const packagedInputs = [
    ...pkg.build.files,
    ...pkg.build.extraResources.flatMap(item => [item.from, ...(item.filter || [])]),
  ];
  for (const forbidden of ['.vidmyo/', 'videos/', 'packages/repurpose-engine/tests', 'mcp/test']) {
    assert.equal(packagedInputs.some(item => item.includes(forbidden)), false, forbidden);
  }
});
