// The Vidmyo MCP over Streamable HTTP.
//
// Lives in mcp/ (not electron/) on purpose: every bare specifier here — the SDK,
// zod, and tools.js's deps — resolves from mcp/node_modules. Electron's main
// process imports THIS one file by absolute path and gets a working handler,
// instead of reaching across the package boundary for each dependency.
//
// Transport/protocol only. The host owns the socket, auth, and lifecycle
// (see electron/lib/mcpHost.js), and supplies keys/config through `ctx`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { registerTools } from './tools.js';

/**
 * Build a request handler that speaks MCP over Streamable HTTP.
 *
 * Stateless (sessionIdGenerator: undefined) with a FRESH server+transport per
 * request — the SDK's documented stateless pattern. Sharing one transport across
 * requests looks tempting and even survives `initialize`, but the very next
 * `notifications/initialized` 500s: with no session there is nothing to bind the
 * follow-up to. Rebuilding per request is cheap (registering tool closures, no
 * I/O) and there is no session state to leak or expire.
 *
 * @param {object} ctx  passed straight to registerTools (secrets, imageConfig, keyHint)
 * @returns {Promise<{handleRequest: Function, close: Function}>}
 */
export async function createHttpMcp(ctx = {}) {
  return {
    handleRequest: async (req, res, body) => {
      const server = new McpServer({ name: 'vidmyo', version: '0.3.0' });
      registerTools(server, ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    },
    close: async () => {},
  };
}
