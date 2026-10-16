import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCleanerTools } from '../lib/tools.js';

async function harness() {
  const calls = [];
  const service = new Proxy({}, { get: (_target, method) => args => {
    calls.push([method, args]);
    return { contract_version: 1, method, project_dir: args.projectDir || null };
  } });
  const server = new McpServer({ name: 'cleaner-test', version: '1' });
  registerCleanerTools(server, service);
  const client = new Client({ name: 'client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, calls };
}

test('Cleaner MCP exposes setup, transcript, review, and local render tools', async () => {
  const { client, server } = await harness();
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
    'cleaner_create', 'cleaner_get', 'cleaner_get_transcript', 'cleaner_prepare',
    'cleaner_render', 'cleaner_set_decision', 'cleaner_submit_plan',
  ]);
  assert.equal(listed.tools.find(tool => tool.name === 'cleaner_get').annotations.readOnlyHint, true);
  assert.equal(listed.tools.find(tool => tool.name === 'cleaner_render').annotations.openWorldHint, false);
  await client.close(); await server.close();
});

test('Cleaner MCP passes normalized current-agent decisions to the service', async () => {
  const { client, server, calls } = await harness();
  const result = await client.callTool({ name: 'cleaner_submit_plan', arguments: {
    project_dir: '/tmp/cleaner', cuts: [{ segment_id: 'segment_000001', category: 'retake', reason: 'Earlier take.' }],
  } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls[0], ['submitPlan', {
    projectDir: '/tmp/cleaner', cuts: [{ segment_id: 'segment_000001', category: 'retake', reason: 'Earlier take.' }],
  }]);
  await client.close(); await server.close();
});

test('Cleaner MCP rejects path escapes and malformed decision ids before service calls', async () => {
  const { client, server, calls } = await harness();
  for (const request of [
    { name: 'cleaner_get', arguments: { project_dir: 'relative' } },
    { name: 'cleaner_set_decision', arguments: { project_dir: '/tmp/cleaner', segment_id: '1', decision: 'cut' } },
  ]) assert.equal((await client.callTool(request)).isError, true);
  assert.equal(calls.length, 0);
  await client.close(); await server.close();
});
