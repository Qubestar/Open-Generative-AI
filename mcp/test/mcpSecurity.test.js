import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateMcpRequest } = require('../../electron/lib/mcpSecurity.js');

const request = (overrides = {}) => ({
  method: 'POST', url: '/mcp', headers: { host: '127.0.0.1:7862' }, ...overrides,
});

test('hosted MCP accepts only its POST endpoint on the bound loopback port', () => {
  assert.equal(validateMcpRequest(request(), 7862), null);
  assert.equal(validateMcpRequest(request({ headers: { host: 'localhost:7862' } }), 7862), null);
  assert.equal(validateMcpRequest(request({ method: 'GET' }), 7862), 'method not allowed');
  assert.equal(validateMcpRequest(request({ url: '/other' }), 7862), 'not found');
  assert.equal(validateMcpRequest(request({ headers: { host: 'evil.example:7862' } }), 7862), 'forbidden host');
  assert.equal(validateMcpRequest(request({ headers: { host: '127.0.0.1:9999' } }), 7862), 'forbidden host');
});

test('hosted MCP rejects hostile or malformed browser origins before protocol handling', () => {
  assert.equal(validateMcpRequest(request({
    headers: { host: '127.0.0.1:7862', origin: 'http://127.0.0.1:7862' },
  }), 7862), null);
  assert.equal(validateMcpRequest(request({
    headers: { host: '127.0.0.1:7862', origin: 'https://evil.example' },
  }), 7862), 'forbidden origin');
  assert.equal(validateMcpRequest(request({
    headers: { host: '127.0.0.1:7862', origin: 'not a url' },
  }), 7862), 'forbidden origin');
});

