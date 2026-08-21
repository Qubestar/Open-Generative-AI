'use strict';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

function splitHost(value) {
  const match = /^([^:]+)(?::(\d+))?$/.exec(String(value || '').trim().toLowerCase());
  return match ? { hostname: match[1], port: match[2] ? Number(match[2]) : null } : null;
}

function validateMcpRequest(req, port) {
  let pathname;
  try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname; } catch { return 'invalid request path'; }
  if (req.method !== 'POST') return 'method not allowed';
  if (pathname !== '/mcp') return 'not found';

  const host = splitHost(req.headers.host);
  if (!host || !LOCAL_HOSTS.has(host.hostname) || (host.port !== null && host.port !== port)) {
    return 'forbidden host';
  }

  const originValue = req.headers.origin;
  if (originValue) {
    try {
      const origin = new URL(originValue);
      const originPort = origin.port ? Number(origin.port) : (origin.protocol === 'https:' ? 443 : 80);
      if (origin.protocol !== 'http:' || !LOCAL_HOSTS.has(origin.hostname.toLowerCase()) || originPort !== port) {
        return 'forbidden origin';
      }
    } catch { return 'forbidden origin'; }
  }
  return null;
}

module.exports = { validateMcpRequest };

