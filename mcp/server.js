#!/usr/bin/env node
// Vidmyo MCP server — STDIO entry point (standalone).
//
// Runs without Vidmyo open, which is why it exists: agents keep working when the
// desktop app is closed. The trade-off is no keychain — a plain node process
// can't read Electron safeStorage — so image generation needs keys in the env:
//
//   FAL_KEY / AGNES_API_KEY       the provider key
//   VIDMYO_IMAGE_SOURCE=fal|agnes which source story_generate_scene should use
//
// For keys from the OS keychain and the source from Settings → Story, use the
// HTTP server Vidmyo hosts instead (electron/lib/mcpHost.js) — the Agents tab's
// "Connect Vidmyo MCP" registers it while Vidmyo is running.
//
// Connect:  claude mcp add --transport stdio vidmyo -- node <abs path>/Vidmyo/mcp/server.js
// Video tools also need the Video Delta engine:  python -m videodelta.api

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTools } from './lib/tools.js';

// Provider id -> the env var this standalone server reads it from.
const ENV_KEY = { fal: 'FAL_KEY', agnes: 'AGNES_API_KEY' };

const server = new McpServer({ name: 'vidmyo', version: '0.3.0' });

registerTools(server, {
  secrets: (providerId) => process.env[ENV_KEY[providerId]] || '',
  imageConfig: () => ({
    imageSource: process.env.VIDMYO_IMAGE_SOURCE || 'flow',
    imageModel: process.env.VIDMYO_IMAGE_MODEL || null,
  }),
  keyHint: 'this MCP server\'s environment (FAL_KEY / AGNES_API_KEY), or use Vidmyo\'s hosted HTTP MCP for keychain keys',
});

const transport = new StdioServerTransport();
await server.connect(transport);
