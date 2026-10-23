// Editor MCP surface — schema, defaulting and argument mapping.
// The service is a recording stub, so this suite never runs inference or ffmpeg.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerEditorTools } from '../lib/tools.js';

const EDITOR_TOOLS = [
  'editor_capabilities',
  'editor_start_edit',
  'editor_get_job',
  'editor_list_jobs',
  'editor_cancel_job',
  'editor_retry_job',
  'editor_analyze_examples',
  'editor_get_analysis',
  'editor_save_template',
  'editor_list_templates',
  'editor_delete_template',
  'editor_read_artifact',
];

async function harness(overrides = {}) {
  const calls = [];
  const job = state => ({
    contract_version: 1,
    job_id: 'job_editor_1',
    state: state || 'queued',
    engine: 'v1',
    mode: 'original',
    stage: 'probe',
    stage_label: 'Inspecting footage',
    progress: 10,
    stages: [{ id: 'probe', status: 'running', label: 'Inspecting footage' }],
    outputs: [],
    warnings: [],
  });
  const service = {
    capabilities: async () => ({
      contract_version: 1,
      engines: [{ id: 'v1', name: 'V1', modes: ['original', 'custom'] }],
      modes: [{ id: 'original', label: 'Original' }, { id: 'custom', label: 'Custom' }],
      qualities: ['draft', 'standard', 'high'],
      pacings: ['reference', 'long'],
      template_count: 0,
    }),
    start: args => { calls.push(['start', args]); return job(); },
    get: jobId => { calls.push(['get', jobId]); return { ...job('done'), job_id: jobId }; },
    list: options => { calls.push(['list', options]); return { contract_version: 1, count: 0, jobs: [] }; },
    cancel: jobId => { calls.push(['cancel', jobId]); return { ...job('cancelled'), job_id: jobId }; },
    retry: jobId => { calls.push(['retry', jobId]); return { ...job(), job_id: 'job_editor_2', stage: 'render' }; },
    analyzeExamples: args => { calls.push(['analyzeExamples', args]); return { contract_version: 1, job_id: 'job_analysis_1', state: 'queued', progress: 0 }; },
    getAnalysis: jobId => { calls.push(['getAnalysis', jobId]); return { contract_version: 1, job_id: jobId, state: 'done', style: { cut_median_s: 0.62, cuts_per_minute: 96 } }; },
    saveTemplate: args => { calls.push(['saveTemplate', args]); return { contract_version: 1, template: { id: 'style-abc123', name: args.name } }; },
    listTemplates: options => { calls.push(['listTemplates', options]); return { contract_version: 1, count: 0, templates: [] }; },
    deleteTemplate: id => { calls.push(['deleteTemplate', id]); return { contract_version: 1, id, removed: true }; },
    readArtifact: (jobId, artifact) => { calls.push(['readArtifact', jobId, artifact]); return { contract_version: 1, artifact, value: { beats: [] } }; },
    ...overrides,
  };
  const server = new McpServer({ name: 'vidmyo-editor-test', version: '1.0.0' });
  registerEditorTools(server, service);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, calls };
}

const payload = result => JSON.parse(result.content[0].text);

test('editor tools are registered on the MCP surface', async () => {
  const { client } = await harness();
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  for (const name of EDITOR_TOOLS) assert.ok(names.includes(name), `missing tool ${name}`);
  await client.close();
});

test('editor_capabilities returns engines and modes', async () => {
  const { client } = await harness();
  const result = await client.callTool({ name: 'editor_capabilities', arguments: {} });
  const body = payload(result);
  assert.equal(body.engines[0].id, 'v1');
  assert.deepEqual(body.engines[0].modes, ['original', 'custom']);
  assert.equal(body.qualities.length, 3);
  await client.close();
});

test('editor_start_edit maps the agent sentence to an editor job', async () => {
  const { client, calls } = await harness();
  const result = await client.callTool({
    name: 'editor_start_edit',
    arguments: {
      input_dir: '/Users/luke/Footage/launch',
      output_dir: '/Users/luke/Movies',
      mode: 'custom',
      template_id: 'style-abc123',
      music_path: '/Users/luke/Music/bed.mp3',
      quality: 'high',
      face_share: 0.25,
    },
  });
  const body = payload(result);
  assert.equal(body.job_id, 'job_editor_1');
  const start = calls.find(entry => entry[0] === 'start')[1];
  assert.equal(start.input_dir, '/Users/luke/Footage/launch');
  assert.equal(start.output_dir, '/Users/luke/Movies');
  assert.equal(start.template_id, 'style-abc123');
  assert.equal(start.options.mode, 'custom');
  assert.equal(start.options.engine, 'v1');
  assert.equal(start.options.quality, 'high');
  assert.equal(start.options.face_share, 0.25);
  assert.equal(start.options.music_path, '/Users/luke/Music/bed.mp3');
  assert.deepEqual(start.options.examples, []);
  assert.equal(start.options.cut_out, false);
  await client.close();
});

test('a relative input folder is rejected by the schema', async () => {
  const { client, calls } = await harness();
  const result = await client.callTool({
    name: 'editor_start_edit',
    arguments: { input_dir: 'footage/launch' },
  });
  assert.ok(result.isError, 'relative path must be rejected');
  assert.equal(calls.filter(entry => entry[0] === 'start').length, 0);
  await client.close();
});

test('an unknown quality is rejected before reaching the service', async () => {
  const { client, calls } = await harness();
  const result = await client.callTool({
    name: 'editor_start_edit',
    arguments: { input_dir: '/tmp/footage', quality: 'insane' },
  });
  assert.ok(result.isError);
  assert.equal(calls.filter(entry => entry[0] === 'start').length, 0);
  await client.close();
});

test('editor_get_job can include the plan artifact', async () => {
  const { client, calls } = await harness();
  const result = await client.callTool({ name: 'editor_get_job', arguments: { job_id: 'job_editor_1', include_plan: true } });
  const body = payload(result);
  assert.equal(body.job_id, 'job_editor_1');
  assert.deepEqual(body.plan, { beats: [] });
  assert.ok(calls.some(entry => entry[0] === 'readArtifact' && entry[2] === 'artifacts/plan.json'));
  await client.close();
});

test('editor_analyze_examples then save_template keeps the measured style', async () => {
  const { client, calls } = await harness();
  const analysis = payload(await client.callTool({
    name: 'editor_analyze_examples',
    arguments: { urls: ['https://www.youtube.com/watch?v=abc123'], name: 'Teal reel' },
  }));
  assert.equal(analysis.job_id, 'job_analysis_1');
  const analyzeArgs = calls.find(entry => entry[0] === 'analyzeExamples')[1];
  assert.deepEqual(analyzeArgs.urls, ['https://www.youtube.com/watch?v=abc123']);
  assert.deepEqual(analyzeArgs.videos, []);
  assert.equal(analyzeArgs.name, 'Teal reel');

  const saved = payload(await client.callTool({
    name: 'editor_save_template',
    arguments: { name: 'Teal reel', analysis_job_id: 'job_analysis_1' },
  }));
  assert.equal(saved.template.id, 'style-abc123');
  await client.close();
});

test('editor_list_templates reads the local template store', async () => {
  const { client } = await harness();
  const body = payload(await client.callTool({ name: 'editor_list_templates', arguments: {} }));
  assert.equal(body.count, 0);
  assert.deepEqual(body.templates, []);
  await client.close();
});

test('editor_read_artifact rejects a non-JSON artifact', async () => {
  const { client } = await harness({
    readArtifact: () => { throw new Error('Only project-owned JSON artifacts can be read.'); },
  });
  const result = await client.callTool({
    name: 'editor_read_artifact',
    arguments: { job_id: 'job_editor_1', artifact: 'out/final.mp4' },
  });
  assert.ok(result.isError);
  await client.close();
});

test('editor_start_edit can point the brain at a local agent', async () => {
  const { client, calls } = await harness();
  await client.callTool({
    name: 'editor_start_edit',
    arguments: { input_dir: '/Users/luke/Footage/reel', brain_agent: 'opencode' },
  });
  const start = calls.find(entry => entry[0] === 'start')[1];
  assert.equal(start.options.brain_agent, 'opencode');
  await client.close();
});

test('editor_capabilities lists the local agents detection found', async () => {
  const { client } = await harness({
    capabilities: async () => ({
      contract_version: 1,
      engines: [{ id: 'v1', name: 'V1', modes: ['original', 'custom'] }],
      agents: [{ id: 'opencode', label: 'OpenCode', available: true }, { id: 'codex', label: 'Codex', available: false }],
      brain_default: 'none',
    }),
  });
  const body = payload(await client.callTool({ name: 'editor_capabilities', arguments: {} }));
  assert.equal(body.brain_default, 'none');
  assert.equal(body.agents.filter(agent => agent.available).length, 1);
  await client.close();
});
