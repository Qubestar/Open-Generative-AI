import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCleanerMcpService } from '../lib/cleanerService.js';

const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };

function harness() {
  const calls = [];
  const repurposeService = {
    create: args => { calls.push(['create', args]); fs.mkdirSync(args.projectDir, { recursive: true }); writeJson(path.join(args.projectDir, 'repurpose.json'), {}); return {}; },
    get: ({ projectDir }) => ({ stages: JSON.parse(fs.readFileSync(path.join(projectDir, 'repurpose-stages.json'), 'utf8')) }),
    analyze: args => { calls.push(['analyze', args]); return { job: { id: 'job_1', state: 'queued' } }; },
  };
  const execFile = (_python, _args, _options, callback) => callback(null, JSON.stringify({ event: 'completed' }), '');
  return { service: createCleanerMcpService({ repurposeService, execFile }), calls };
}

test('Cleaner MCP project carries the intake once without exposing a skill', () => {
  const { service, calls } = harness();
  const root = tempDir('vidmyo-cleaner-mcp-root-');
  const dir = path.join(root, 'project');
  const source = path.join(root, 'source.mp4'); fs.writeFileSync(source, 'media');
  const result = service.create({ projectDir: dir, sourcePath: source, scriptMode: 'rough', scriptText: 'Hook then demo.', includeMp4: true, saveMode: 'custom' });
  assert.equal(result.manifest.analysis.provider, 'current_agent');
  assert.equal(result.manifest.cleanup.remove_filler_words, false);
  assert.equal(calls[0][0], 'create');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'cleaner.json'), 'utf8'), /SKILL\.md|Perfect Cuts/);
});

test('Cleaner MCP prepares only local inspect and transcription before agent decisions', () => {
  const { service, calls } = harness();
  const root = tempDir('vidmyo-cleaner-mcp-prep-');
  writeJson(path.join(root, 'cleaner.json'), { stages: { ingest: { state: 'pending' }, transcribe: { state: 'pending' } } });
  writeJson(path.join(root, 'repurpose-stages.json'), { ingest: { state: 'pending' }, transcribe: { state: 'pending' } });
  const result = service.prepare({ projectDir: root });
  assert.equal(result.state, 'preparing');
  assert.equal(calls[0][0], 'analyze');
  assert.equal(calls[0][1].stage, 'ingest');
});

test('Cleaner MCP transcript decisions default to keep and remain reversible', () => {
  const { service } = harness();
  const root = tempDir('vidmyo-cleaner-mcp-plan-');
  writeJson(path.join(root, 'cleaner.json'), {
    source: { type: 'local_file', uri: '/tmp/source.mp4' },
    stages: { transcribe: { state: 'pending' }, decide_cuts: { state: 'pending' }, review: { state: 'pending' } },
  });
  writeJson(path.join(root, 'artifacts', 'transcript-artifact.v1.json'), { segments: [
    { id: 'whisper_1', start_seconds: 0, end_seconds: 1, text: 'wrong take', word_ids: [] },
    { id: 'whisper_2', start_seconds: 1, end_seconds: 2, text: 'right take', word_ids: [] },
  ] });
  const result = service.submitPlan({ projectDir: root, cuts: [{ segment_id: 'segment_000001', category: 'retake', reason: 'Repeated by the next complete take.' }] });
  assert.equal(result.plan_summary.proposed_cuts, 1);
  const restored = service.setDecision({ projectDir: root, segmentId: 'segment_000001', decision: 'keep' });
  assert.equal(restored.decision.decision, 'keep');
});
