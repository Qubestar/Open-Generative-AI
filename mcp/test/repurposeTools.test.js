import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerRepurposeTools } from '../lib/tools.js';

async function harness() {
  const calls = [];
  const service = new Proxy({}, {
    get: (_target, method) => args => {
      calls.push([method, args]);
      return { contract_version: 1, method, project_dir: args.projectDir || null };
    },
  });
  const server = new McpServer({ name: 'vidmyo-test', version: '1.0.0' });
  registerRepurposeTools(server, service);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, calls };
}

test('protocol lists the stable seven-tool Repurpose surface with annotations and schemas', async () => {
  const { client, server } = await harness();
  const listed = await client.listTools();
  const tools = listed.tools.filter(tool => tool.name.includes('repurpose'));
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'get_repurpose_job', 'repurpose_analyze', 'repurpose_create', 'repurpose_get',
    'repurpose_list_candidates', 'repurpose_render', 'repurpose_set_candidate_decision',
  ]);
  assert.equal(tools.find(tool => tool.name === 'repurpose_get').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'repurpose_render').annotations.openWorldHint, false);
  assert.equal(tools.find(tool => tool.name === 'repurpose_create').inputSchema.additionalProperties, false);
  await client.close();
  await server.close();
});

test('tool calls return matching text and structured content', async () => {
  const { client, server, calls } = await harness();
  const result = await client.callTool({
    name: 'repurpose_get', arguments: { project_dir: '/tmp/vidmyo-project' },
  });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.contract_version, 1);
  assert.deepEqual(calls[0], ['get', { projectDir: '/tmp/vidmyo-project' }]);
  await client.close();
  await server.close();
});

test('strict schemas reject unknown fields, relative paths, and malformed candidate ids before service calls', async () => {
  const { client, server, calls } = await harness();
  for (const request of [
    { name: 'repurpose_get', arguments: { project_dir: 'relative' } },
    { name: 'repurpose_get', arguments: { project_dir: '/tmp/project', extra: true } },
    { name: 'repurpose_set_candidate_decision', arguments: { project_dir: '/tmp/project', candidate_id: '1', action: 'approve' } },
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /validation error/i);
  }
  assert.equal(calls.length, 0);
  await client.close();
  await server.close();
});

