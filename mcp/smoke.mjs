// End-to-end MCP smoke test: spawn server.js over stdio (as `claude mcp add` does),
// list tools, then drive a real composite-tier render through the MCP protocol.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['server.js'] });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

const cap = await client.callTool({ name: 'list_capabilities', arguments: {} });
console.log('CAPABILITIES ok:', JSON.parse(cap.content[0].text).name);

const sub = await client.callTool({
  name: 'create_video',
  arguments: { prompt: 'a red fox trots across snow', motion: 'composite', duration: 1.0,
               fps: 8, size: 64, upscale: 1 },
});
const { job_id } = JSON.parse(sub.content[0].text);
console.log('SUBMITTED job:', job_id);

let out = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const j = JSON.parse((await client.callTool({ name: 'get_job', arguments: { job_id } })).content[0].text);
  if (j.status === 'done') { out = j.out; break; }
  if (j.status === 'error') { throw new Error('job error: ' + j.error); }
}
console.log(out ? `DONE -> ${out}` : 'TIMEOUT');
await client.close();
process.exit(out ? 0 : 1);
