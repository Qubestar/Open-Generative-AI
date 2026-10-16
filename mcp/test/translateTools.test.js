// Translate Video MCP surface — schema, defaulting and argument mapping.
// The service is a recording stub, so this suite never runs inference.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerTranslateTools } from '../lib/tools.js';

async function harness(overrides = {}) {
  const calls = [];
  const service = {
    capabilities: async () => ({
      contract_version: 1,
      source_languages: [{ code: 'auto', name: 'Auto detect' }, { code: 'en', name: 'English' }],
      target_languages: [{ code: 'pl', name: 'Polish' }],
      voice_clone_languages: [{ code: 'pl', name: 'Polish' }],
      modes: { audio: true, subtitles: true, source_separation: true, lip_sync: false },
      notes: ['Use voice cloning only with permission from the speaker.'],
    }),
    start: async args => { calls.push(['start', args]); return { contract_version: 1, job_id: 'job_started', state: 'queued', stage: 'import', progress: 0, target_language: args.options.target_language }; },
    get: async jobId => { calls.push(['get', jobId]); return { contract_version: 1, job_id: jobId, state: 'done', progress: 100, outputs: [{ kind: 'translated_video', artifact: 'artifacts/video.pl.mp4' }] }; },
    list: async options => { calls.push(['list', options]); return { contract_version: 1, count: 0, jobs: [] }; },
    cancel: async jobId => { calls.push(['cancel', jobId]); return { contract_version: 1, job_id: jobId, state: 'cancelled' }; },
    retry: async jobId => { calls.push(['retry', jobId]); return { contract_version: 1, job_id: 'job_retry', state: 'queued', stage: 'render' }; },
    readArtifact: (jobId, artifact) => { calls.push(['readArtifact', jobId, artifact]); return { contract_version: 1, artifact, value: { segments: [{ id: 'seg_0001', translated_text: 'Cześć' }] } }; },
    ...overrides,
  };
  const server = new McpServer({ name: 'vidmyo-translate-test', version: '1.0.0' });
  registerTranslateTools(server, service);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, calls };
}

const payload = result => JSON.parse(result.content[0].text);
const close = (server, client) => Promise.all([client.close(), server.close()]);

test('protocol lists the translate surface with read-only annotations', async () => {
  const { client, server } = await harness();
  const listed = await client.listTools();
  const tools = listed.tools.filter(tool => tool.name.startsWith('translate_'));
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'translate_cancel_job',
    'translate_capabilities',
    'translate_get_job',
    'translate_list_jobs',
    'translate_retry_job',
    'translate_video',
  ]);
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  assert.equal(byName.translate_capabilities.annotations.readOnlyHint, true);
  assert.equal(byName.translate_get_job.annotations.readOnlyHint, true);
  assert.equal(byName.translate_video.annotations.openWorldHint, true);
  assert.equal(byName.translate_video.annotations.readOnlyHint, false);
  await close(server, client);
});

test('translate_video maps agent arguments onto the canonical options with defaults', async () => {
  const { client, server, calls } = await harness();
  const result = await client.callTool({
    name: 'translate_video',
    arguments: { input: 'https://example.com/video.mp4', target_language: 'pl' },
  });
  assert.equal(result.isError, undefined);
  assert.equal(payload(result).job_id, 'job_started');
  const [method, args] = calls.find(call => call[0] === 'start');
  assert.equal(method, 'start');
  assert.equal(args.input, 'https://example.com/video.mp4');
  assert.deepEqual(args.options, {
    source_language: 'auto',
    target_language: 'pl',
    translate_audio: true,
    clone_voice: true,
    voice_id: null,
    preserve_background: true,
    background_mode: 'duck',
    subtitles: true,
    burn_subtitles: false,
    lip_sync: false,
    quality: 'quality',
    translation_model: null,
    transcription_model: null,
  });
  await close(server, client);
});

test('translate_video accepts a structured input and honours explicit options', async () => {
  const { client, server, calls } = await harness();
  await client.callTool({
    name: 'translate_video',
    arguments: {
      input: { type: 'file', uri: '/Users/me/Videos/interview.mp4' },
      target_language: 'es',
      source_language: 'en',
      background_mode: 'separate',
      clone_voice: false,
      voice_id: 'voice42',
      translate_audio: true,
      subtitles: true,
      burn_subtitles: true,
      quality: 'fast',
      transcription_model: 'small',
    },
  });
  const args = calls.find(call => call[0] === 'start')[1];
  assert.deepEqual(args.input, { type: 'file', uri: '/Users/me/Videos/interview.mp4' });
  assert.equal(args.options.target_language, 'es');
  assert.equal(args.options.source_language, 'en');
  assert.equal(args.options.background_mode, 'separate');
  assert.equal(args.options.clone_voice, false);
  assert.equal(args.options.voice_id, 'voice42');
  assert.equal(args.options.burn_subtitles, true);
  assert.equal(args.options.quality, 'fast');
  assert.equal(args.options.transcription_model, 'small');
  await close(server, client);
});

test('the schema rejects unsupported values and unknown arguments', async () => {
  const { client, server } = await harness();
  const missingTarget = await client.callTool({ name: 'translate_video', arguments: { input: 'https://example.com/v.mp4' } });
  assert.equal(missingTarget.isError, true);

  const badMode = await client.callTool({
    name: 'translate_video',
    arguments: { input: 'https://example.com/v.mp4', target_language: 'pl', background_mode: 'louder' },
  });
  assert.equal(badMode.isError, true);

  const unknown = await client.callTool({
    name: 'translate_video',
    arguments: { input: 'https://example.com/v.mp4', target_language: 'pl', publish_now: true },
  });
  assert.equal(unknown.isError, true);
  await close(server, client);
});

test('the job tools surface bounded results and never raw paths', async () => {
  const { client, server, calls } = await harness();
  const polled = await client.callTool({ name: 'translate_get_job', arguments: { job_id: 'job_abc' } });
  assert.equal(payload(polled).state, 'done');
  assert.equal(payload(polled).outputs[0].artifact, 'artifacts/video.pl.mp4');

  const withTranscript = await client.callTool({ name: 'translate_get_job', arguments: { job_id: 'job_abc', include_transcript: true } });
  assert.equal(payload(withTranscript).transcript.value.segments[0].translated_text, 'Cześć');
  assert.deepEqual(calls.filter(call => call[0] === 'readArtifact'), [['readArtifact', 'job_abc', 'artifacts/translation.json']]);

  const listed = await client.callTool({ name: 'translate_list_jobs', arguments: {} });
  assert.equal(payload(listed).count, 0);

  const cancelled = await client.callTool({ name: 'translate_cancel_job', arguments: { job_id: 'job_abc' } });
  assert.equal(payload(cancelled).state, 'cancelled');

  const retried = await client.callTool({ name: 'translate_retry_job', arguments: { job_id: 'job_abc' } });
  assert.equal(payload(retried).job_id, 'job_retry');
  assert.equal(payload(retried).stage, 'render');

  const malformed = await client.callTool({ name: 'translate_get_job', arguments: { job_id: 'not-a-job' } });
  assert.equal(malformed.isError, true);
  await close(server, client);
});

test('capabilities are exposed as a read-only object an agent can reason about', async () => {
  const { client, server } = await harness();
  const result = await client.callTool({ name: 'translate_capabilities', arguments: {} });
  const caps = payload(result);
  assert.equal(caps.target_languages[0].code, 'pl');
  assert.equal(caps.modes.source_separation, true);
  assert.equal(caps.modes.lip_sync, false);
  assert.ok(caps.notes.some(note => /permission from the speaker/i.test(note)));
  await close(server, client);
});

test('a rejected input becomes a bounded public error, not a stack trace', async () => {
  const boom = new Error('Private, loopback, and link-local addresses cannot be imported as video URLs.');
  const { client, server } = await harness({ start: async () => { throw boom; } });
  const result = await client.callTool({
    name: 'translate_video',
    arguments: { input: 'http://127.0.0.1/v.mp4', target_language: 'pl' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text.includes(boom.message), false, 'the raw error must not be echoed');
  assert.match(result.content[0].text, /failed|did not match|not found|Review/i);
  await close(server, client);
});
