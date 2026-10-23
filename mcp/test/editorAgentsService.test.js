// The agent list must never block a UI paint: installed rows come back immediately,
// the proven answers arrive later. No agent is launched here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobStore } from '../../packages/core/src/jobs.js';
import { createEditorMcpService } from '../lib/editorService.js';

function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-agents-'));
  const store = new JobStore(path.join(dir, 'jobs'));
  return createEditorMcpService({
    store,
    projectsDir: path.join(dir, 'projects'),
    engines: { capabilities: () => ({}) },
    // No CLI is spawned in this suite.
    probeRunner: async () => [
      { id: 'opencode', ready: true, installed: true, model: 'default' },
      { id: 'codex', ready: false, installed: true, reason: 'no model access', human_reason: 'This ChatGPT plan has no Codex model access.' },
    ],
  });
}

test('the agent list answers immediately without waiting for a probe', () => {
  const svc = service();
  const started = Date.now();
  const result = svc.agents({ probe: false });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `listed in ${elapsed} ms`);
  assert.equal(result.probed, false);
  assert.equal(result.pending, false);
  assert.ok(result.agents.length >= 1);
  for (const entry of result.agents) {
    assert.ok(entry.id, 'every row has an id');
    assert.equal(typeof entry.available, 'boolean');
    assert.ok('signed_in' in entry);
  }
});

test('a requested probe returns at once with pending=true and unknown rows', () => {
  const svc = service();
  const started = Date.now();
  const result = svc.agents({ probe: true });
  const elapsed = Date.now() - started;
  // It starts the probe in the background; the call itself is bounded by the cheap
  // status checks, not by an agent's answer (which takes tens of seconds).
  assert.ok(elapsed < 6000, `returned in ${elapsed} ms`);
  assert.equal(result.pending, true);
  assert.equal(result.probed, false);
});
