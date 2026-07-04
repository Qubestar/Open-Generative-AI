// Tracker-sheet access (read-only — Vidmyo never writes production trackers).
//
// Two paths, tried in order:
//   1. Public CSV export — works for any link-shared Google Sheet, no auth.
//      The sellable-product path: users paste a sheet URL.
//   2. The `gws` CLI (authenticated Google Workspace) — dev-machine fallback
//      for private sheets.
// Consumed by both the Electron story bridge and the MCP server.

import { execFile } from 'node:child_process';

export function sheetIdFromInput(input) {
  const m = String(input || '').match(/\/d\/([\w-]{20,})/);
  if (m) return m[1];
  const bare = String(input || '').trim();
  return /^[\w-]{20,}$/.test(bare) ? bare : null;
}

// Minimal RFC-correct CSV parser — quoted fields may contain commas, quotes,
// and newlines (sheet descriptions do).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function gwsRead(sheetId, range) {
  return new Promise((resolve, reject) => {
    execFile('gws', ['sheets', '+read', '--spreadsheet', sheetId, '--range', range, '--format', 'json'],
      { timeout: 20000, env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } },
      (err, stdout) => {
        if (err) { reject(new Error(`gws failed: ${String(err.message).slice(0, 300)}`)); return; }
        try {
          const jsonStart = stdout.indexOf('{'); // gws may print a keyring notice first
          resolve(JSON.parse(stdout.slice(jsonStart)));
        } catch {
          reject(new Error('gws returned unparseable output'));
        }
      });
  });
}

export async function readSheetValues(sheetId, range, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(
      `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&range=${encodeURIComponent(range)}`,
      { redirect: 'follow' },
    );
    const text = await res.text();
    if (res.ok && !text.trimStart().startsWith('<')) {
      return { values: parseCsv(text), via: 'public-link' };
    }
  } catch { /* fall through to gws */ }
  const data = await gwsRead(sheetId, range).catch((err) => {
    throw new Error(`Could not read the sheet. Make it link-readable (Share → Anyone with the link → Viewer) or sign in with gws. (${err.message})`);
  });
  return { values: data.values || [], via: 'gws' };
}

// Map tracker rows (A:E = Status, Video #, Working Title, Hook, Topic/Angle)
// to brief objects. Row numbers are 1-based sheet rows; row 1 is the header.
export function trackerRows(values) {
  return (values || []).slice(1)
    .map((r, i) => ({
      row: i + 2,
      status: r[0] || '',
      videoNum: r[1] || '',
      title: r[2] || '',
      hook: r[3] || '',
      topic: r[4] || '',
    }))
    .filter((r) => r.title);
}
