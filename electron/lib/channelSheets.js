// Main-process Google Sheets sync for Channel Workspace trackers.
//
// The visible Videos worksheet is deliberately the portable 21-column
// tracker. `_Vidmyo` stays hidden and records stable IDs, row positions,
// revisions, and a fingerprint of the last synchronized visible row. The
// fingerprint makes edits made in Sheets detectable before a local push.

const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,}$/;
const VIDEOS_TAB = 'Videos';
const META_TAB = '_Vidmyo';
const META_COLUMNS = Object.freeze(['videoId', 'row', 'revision', 'fingerprint']);
const MAX_TRACKER_ROWS = 1000;
const MAX_TITLE_LENGTH = 200;

function clone(value) { return structuredClone(value); }

function fail(message) { throw new Error(message); }

function quoteTab(tab) { return `'${String(tab).replace(/'/g, "''")}'`; }

function hashRow(values) {
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function normalizeRow(values, width, label) {
  if (!Array.isArray(values)) fail(`${label} must be a row.`);
  if (values.length > width) fail(`${label} has more than ${width} columns.`);
  return Array.from({ length: width }, (_unused, index) => String(values[index] ?? ''));
}

function boundedIds(ids) {
  const values = [...new Set(ids)].slice(0, 25);
  return { ids: values, truncated: ids.length > values.length };
}

function syncResult({ spreadsheetId, title = '', rows = 0, action, conflicts = [] } = {}) {
  const bounded = boundedIds(conflicts);
  return {
    ok: conflicts.length === 0,
    ...(conflicts.length ? { conflict: true, code: 'tracker-conflict', conflicts: bounded.ids, conflictsTruncated: bounded.truncated } : {}),
    spreadsheetId,
    title: String(title || '').slice(0, MAX_TITLE_LENGTH),
    rows: Math.min(Math.max(Number(rows) || 0, 0), MAX_TRACKER_ROWS),
    action,
  };
}

function requireWorkspace(workspace) {
  if (!workspace || typeof workspace.snapshot !== 'function' || typeof workspace.save !== 'function' || !workspace.manifest) {
    fail('A loaded ChannelWorkspace is required for Google Sheets sync.');
  }
  return workspace;
}

function spreadsheetIdFor(manifest) {
  const id = String(manifest?.tracker?.sheetId || '');
  if (!SHEET_ID_RE.test(id)) fail('This Channel Workspace is not connected to a Google tracker. Create a tracker first.');
  return id;
}

function assertVideos(values, columns) {
  if (!Array.isArray(values) || values.length === 0) fail('The Videos worksheet is empty. Restore the Vidmyo tracker header before syncing.');
  const header = normalizeRow(values[0], columns.length, 'Videos header');
  if (header.length !== columns.length || header.some((value, index) => value !== columns[index])) {
    fail('The Videos worksheet header no longer matches the Vidmyo 21-column tracker.');
  }
  if (values.length - 1 > MAX_TRACKER_ROWS) fail(`The tracker exceeds the ${MAX_TRACKER_ROWS}-row sync limit.`);
  return [header, ...values.slice(1).map((row, index) => normalizeRow(row, columns.length, `Videos row ${index + 2}`))];
}

function parseMetadata(values) {
  if (!Array.isArray(values) || values.length === 0) fail('The hidden _Vidmyo worksheet is missing its sync metadata.');
  const header = normalizeRow(values[0], META_COLUMNS.length, '_Vidmyo header');
  if (header.some((value, index) => value !== META_COLUMNS[index])) {
    fail('The hidden _Vidmyo worksheet metadata is invalid. Create a new tracker or restore its metadata header.');
  }
  if (values.length - 1 > MAX_TRACKER_ROWS) fail(`The tracker metadata exceeds the ${MAX_TRACKER_ROWS}-row sync limit.`);
  const ids = new Set();
  const rows = new Set();
  return values.slice(1).map((raw, index) => {
    const [videoId, rowText, revisionText, fingerprint] = normalizeRow(raw, META_COLUMNS.length, `_Vidmyo row ${index + 2}`);
    const row = Number(rowText);
    const revision = Number(revisionText);
    if (!/^video_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(videoId)) fail(`_Vidmyo row ${index + 2} has an invalid video ID.`);
    if (!Number.isInteger(row) || row < 2 || row > MAX_TRACKER_ROWS + 1) fail(`_Vidmyo row ${index + 2} has an invalid visible row.`);
    if (!Number.isInteger(revision) || revision < 0) fail(`_Vidmyo row ${index + 2} has an invalid revision.`);
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) fail(`_Vidmyo row ${index + 2} has an invalid fingerprint.`);
    if (ids.has(videoId) || rows.has(row)) fail('The hidden _Vidmyo worksheet contains duplicate video metadata.');
    ids.add(videoId); rows.add(row);
    return { videoId, row, revision, fingerprint };
  });
}

function visibleRowsFor(core, manifest) {
  const rows = core.exportTrackerRows(manifest);
  if (rows.length - 1 > MAX_TRACKER_ROWS) fail(`The Channel Workspace exceeds the ${MAX_TRACKER_ROWS}-row sync limit.`);
  return rows.map((row, index) => normalizeRow(row, core.TRACKER_COLUMNS.length, `local tracker row ${index + 1}`));
}

function localRowsById(core, manifest) {
  const rows = visibleRowsFor(core, manifest);
  const metadata = core.trackerRowMetadata(manifest);
  const byId = new Map();
  for (const item of metadata) {
    const video = manifest.videos.find(candidate => candidate.id === item.videoId);
    byId.set(item.videoId, {
      row: Number.isInteger(video?.sheet?.lastKnownRow) ? video.sheet.lastKnownRow : item.row,
      revision: item.revision,
      values: rows[item.row - 1],
    });
  }
  return { rows, metadata, byId };
}

function metadataRows(entries) {
  return [Array.from(META_COLUMNS), ...entries
    .slice()
    .sort((left, right) => left.row - right.row || left.videoId.localeCompare(right.videoId))
    .map(item => [item.videoId, String(item.row), String(item.revision), item.fingerprint])];
}

function metadataForLocal(core, manifest, rows, revisions = new Map()) {
  return core.trackerRowMetadata(manifest).map(item => ({
    videoId: item.videoId,
    row: item.row,
    revision: revisions.get(item.videoId) ?? item.revision,
    fingerprint: hashRow(rows[item.row - 1]),
  }));
}

function metadataForRemote(manifest, visibleRows) {
  return manifest.videos.map(video => {
    const row = Number(video.sheet?.lastKnownRow);
    if (!Number.isInteger(row) || row < 2 || row > visibleRows.length) fail(`Video ${video.id} has no valid synchronized worksheet row.`);
    return { videoId: video.id, row, revision: Number(video.sheet.revision || 0), fingerprint: hashRow(visibleRows[row - 1]) };
  });
}

function evaluateRemote(core, manifest, visibleRows, metadata) {
  const local = localRowsById(core, manifest);
  const remoteById = new Map(metadata.map(item => [item.videoId, item]));
  const remoteChanges = [];
  const localChanges = [];
  const divergent = [];
  const unknownRemote = [];
  const missingKnown = [];

  for (const entry of metadata) {
    const remoteValues = visibleRows[entry.row - 1];
    if (!remoteValues) {
      remoteChanges.push(entry.videoId);
      continue;
    }
    const remoteFingerprint = hashRow(remoteValues);
    const known = local.byId.get(entry.videoId);
    if (!known) {
      unknownRemote.push(entry.videoId);
      continue;
    }
    const localFingerprint = hashRow(known.values);
    const remoteChanged = remoteFingerprint !== entry.fingerprint
      || known.row !== entry.row
      || known.revision !== entry.revision;
    const localChanged = localFingerprint !== entry.fingerprint;
    if (remoteChanged) remoteChanges.push(entry.videoId);
    if (localChanged) localChanges.push(entry.videoId);
    if (remoteChanged && localChanged && remoteFingerprint !== localFingerprint) divergent.push(entry.videoId);
  }

  for (const [videoId, known] of local.byId) {
    const video = manifest.videos.find(candidate => candidate.id === videoId);
    if (!remoteById.has(videoId) && video?.sheet?.lastKnownRow !== null) missingKnown.push(videoId);
  }

  return { local, remoteChanges, localChanges, divergent, unknownRemote, missingKnown };
}

function commitWorkspace(workspace, manifest) {
  workspace.manifest = manifest;
  workspace.save();
  return workspace.snapshot();
}

function createChannelSheets(deps = {}) {
  const google = deps.google;
  if (!google || typeof google.apiJson !== 'function' || typeof google.writeJson !== 'function') {
    throw new Error('Channel Sheets requires the native Google OAuth service.');
  }
  const loadCore = deps.core || (() => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'core', 'index.js')).href));

  async function readRemote(core, spreadsheetId) {
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
    url.searchParams.append('ranges', `${VIDEOS_TAB}!A1:U${MAX_TRACKER_ROWS + 1}`);
    url.searchParams.append('ranges', `${quoteTab(META_TAB)}!A1:D${MAX_TRACKER_ROWS + 1}`);
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');
    const data = await google.apiJson(url.toString());
    const ranges = Array.isArray(data?.valueRanges) ? data.valueRanges : [];
    const visible = assertVideos(ranges[0]?.values, core.TRACKER_COLUMNS);
    const metadata = parseMetadata(ranges[1]?.values);
    return { title: String(data?.spreadsheetId || spreadsheetId), visible, metadata };
  }

  async function writeValues(spreadsheetId, data) {
    return google.writeJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, {
      method: 'POST',
      body: { valueInputOption: 'RAW', data },
    });
  }

  async function create(workspace, options = {}) {
    try {
      requireWorkspace(workspace);
      const core = await loadCore();
      const manifest = workspace.snapshot();
      const title = String(options.title || `${manifest.name} — Vidmyo tracker`).trim();
      if (!title || title.length > MAX_TITLE_LENGTH) fail(`Tracker title must be 1–${MAX_TITLE_LENGTH} characters.`);
      const rows = visibleRowsFor(core, manifest);
      const created = await google.writeJson('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        body: { properties: { title }, sheets: [
          { properties: { title: VIDEOS_TAB } },
          { properties: { title: META_TAB, hidden: true } },
        ] },
      });
      const spreadsheetId = String(created?.spreadsheetId || '');
      if (!SHEET_ID_RE.test(spreadsheetId)) fail('Google did not return a valid spreadsheet ID.');
      const metadata = metadataForLocal(core, manifest, rows);
      await writeValues(spreadsheetId, [
        { range: `${VIDEOS_TAB}!A1`, majorDimension: 'ROWS', values: rows },
        { range: `${quoteTab(META_TAB)}!A1`, majorDimension: 'ROWS', values: metadataRows(metadata) },
      ]);
      const next = clone(manifest);
      next.tracker = { ...next.tracker, sheetId: spreadsheetId, tab: VIDEOS_TAB, syncMode: 'google-sheets' };
      for (const item of metadata) {
        const video = next.videos.find(candidate => candidate.id === item.videoId);
        if (video) video.sheet = { lastKnownRow: item.row, revision: item.revision };
      }
      commitWorkspace(workspace, next);
      return syncResult({ spreadsheetId, title: created?.properties?.title || title, rows: metadata.length, action: 'created' });
    } catch (error) { return { ok: false, error: String(error?.message || error).slice(0, 500) }; }
  }

  async function pull(workspace) {
    try {
      requireWorkspace(workspace);
      const core = await loadCore();
      const manifest = workspace.snapshot();
      const spreadsheetId = spreadsheetIdFor(manifest);
      const remote = await readRemote(core, spreadsheetId);
      const evaluated = evaluateRemote(core, manifest, remote.visible, remote.metadata);
      const conflicts = [...evaluated.divergent, ...evaluated.missingKnown];
      if (conflicts.length) return syncResult({ spreadsheetId, rows: remote.metadata.length, action: 'pull', conflicts });
      const changed = evaluated.remoteChanges.length > 0 || evaluated.unknownRemote.length > 0;
      if (!changed) return syncResult({ spreadsheetId, rows: remote.metadata.length, action: 'pull-unchanged' });
      const imported = core.importTrackerRows(manifest, remote.visible, { metadata: remote.metadata.map(({ videoId, row, revision }) => ({ videoId, row, revision })) });
      const next = imported.manifest;
      next.tracker = { ...next.tracker, sheetId: spreadsheetId, tab: VIDEOS_TAB, syncMode: 'google-sheets' };
      const acknowledged = metadataForRemote(next, remote.visible);
      await writeValues(spreadsheetId, [{ range: `${quoteTab(META_TAB)}!A1`, majorDimension: 'ROWS', values: metadataRows(acknowledged) }]);
      commitWorkspace(workspace, next);
      return syncResult({ spreadsheetId, rows: acknowledged.length, action: 'pulled' });
    } catch (error) { return { ok: false, error: String(error?.message || error).slice(0, 500) }; }
  }

  async function push(workspace) {
    try {
      requireWorkspace(workspace);
      const core = await loadCore();
      const manifest = workspace.snapshot();
      const spreadsheetId = spreadsheetIdFor(manifest);
      const remote = await readRemote(core, spreadsheetId);
      const evaluated = evaluateRemote(core, manifest, remote.visible, remote.metadata);
      const conflicts = [...evaluated.remoteChanges, ...evaluated.unknownRemote, ...evaluated.missingKnown];
      if (conflicts.length) return syncResult({ spreadsheetId, rows: remote.metadata.length, action: 'push', conflicts });
      const hasNewLocal = [...evaluated.local.byId.keys()].some(videoId => !remote.metadata.some(item => item.videoId === videoId));
      if (!evaluated.localChanges.length && !hasNewLocal) return syncResult({ spreadsheetId, rows: remote.metadata.length, action: 'push-unchanged' });
      const rows = evaluated.local.rows;
      const revisions = new Map();
      const next = clone(manifest);
      for (const item of evaluated.local.metadata) {
        const video = next.videos.find(candidate => candidate.id === item.videoId);
        const revision = Number(video.sheet?.revision || 0) + (evaluated.localChanges.includes(item.videoId) ? 1 : 0);
        revisions.set(item.videoId, revision);
        video.sheet = { lastKnownRow: item.row, revision };
      }
      next.tracker = { ...next.tracker, sheetId: spreadsheetId, tab: VIDEOS_TAB, syncMode: 'google-sheets' };
      const metadata = metadataForLocal(core, next, rows, revisions);
      await writeValues(spreadsheetId, [
        { range: `${VIDEOS_TAB}!A1`, majorDimension: 'ROWS', values: rows },
        { range: `${quoteTab(META_TAB)}!A1`, majorDimension: 'ROWS', values: metadataRows(metadata) },
      ]);
      commitWorkspace(workspace, next);
      return syncResult({ spreadsheetId, rows: metadata.length, action: 'pushed' });
    } catch (error) { return { ok: false, error: String(error?.message || error).slice(0, 500) }; }
  }

  return { create, pull, push };
}

module.exports = { createChannelSheets, META_COLUMNS, VIDEOS_TAB, META_TAB, MAX_TRACKER_ROWS };
