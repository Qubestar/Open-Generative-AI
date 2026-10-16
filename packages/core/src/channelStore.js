// Atomic, local-only persistence for Channel Workspace manifests.

import fs from 'node:fs';
import path from 'node:path';
import {
  CHANNEL_MANIFEST_NAME,
  CHANNEL_ID_PREFIX,
  assertStableId,
  createChannelManifest,
  validateChannelManifest,
  listVideos,
  getVideo,
  addVideo,
  updateVideo,
  archiveVideo,
  nextReady,
  claimVideo,
  releaseClaim,
  recoverStaleClaims,
  linkProduction,
} from './channel.js';

function clone(value) {
  return structuredClone(value);
}

function atomicWriteJson(file, data) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* preserve original error */ }
    throw error;
  }
}

function workspaceFile(dir) {
  return path.join(dir, CHANNEL_MANIFEST_NAME);
}

function currentIso(clock) {
  const value = clock ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('clock: must return a valid date');
  return date.toISOString();
}

function safeChild(root, id) {
  assertStableId(id, CHANNEL_ID_PREFIX, 'channelId');
  const base = path.resolve(root);
  const target = path.resolve(base, id);
  const relation = path.relative(base, target);
  if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error('channelId: escapes the ChannelStore root');
  }
  return target;
}

export class ChannelWorkspace {
  constructor(dir, manifest, options = {}) {
    this.dir = path.resolve(dir);
    this.manifest = validateChannelManifest(clone(manifest));
    this.clock = options.clock;
    this.idGenerator = options.idGenerator;
  }

  static create(dir, input = {}, options = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const file = workspaceFile(dir);
    if (fs.existsSync(file)) throw new Error(`Refusing to overwrite existing channel manifest: ${file}`);
    const manifest = createChannelManifest(input, options);
    atomicWriteJson(file, manifest);
    return new ChannelWorkspace(dir, manifest, options);
  }

  static load(dir, options = {}) {
    const file = workspaceFile(dir);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`Could not load channel manifest ${file}: ${error.message}`);
    }
    if (manifest?.version === 1) {
      if (!Object.hasOwn(manifest, 'research')) manifest.research = null;
      if (!Object.hasOwn(manifest, 'analysis')) manifest.analysis = null;
    }
    return new ChannelWorkspace(dir, manifest, options);
  }

  snapshot() {
    return clone(this.manifest);
  }

  save() {
    validateChannelManifest(this.manifest);
    atomicWriteJson(workspaceFile(this.dir), this.manifest);
    return this;
  }

  listVideos() { return listVideos(this.manifest); }
  getVideo(videoId) { return getVideo(this.manifest, videoId); }

  update(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch: must be an object');
    const protectedKeys = new Set(['version', 'id', 'videos', 'createdAt', 'updatedAt']);
    for (const key of Object.keys(patch)) if (protectedKeys.has(key)) throw new Error(`patch.${key}: is immutable`);
    this.manifest = { ...this.manifest, ...clone(patch), updatedAt: currentIso(this.clock) };
    validateChannelManifest(this.manifest);
    return this.save().snapshot();
  }

  addVideo(input = {}) {
    this.manifest = addVideo(this.manifest, input, this);
    this.save();
    return this.getVideo(this.manifest.videos.at(-1).id);
  }

  updateVideo(videoId, patch = {}) {
    this.manifest = updateVideo(this.manifest, videoId, patch, this);
    this.save();
    return this.getVideo(videoId);
  }

  archiveVideo(videoId) {
    this.manifest = archiveVideo(this.manifest, videoId, this);
    this.save();
    return this.getVideo(videoId);
  }

  nextReady() { return nextReady(this.manifest); }

  claimVideo(videoId, options = {}) {
    this.manifest = claimVideo(this.manifest, videoId, { ...options, clock: this.clock });
    this.save();
    return this.getVideo(videoId);
  }

  releaseClaim(videoId, options = {}) {
    this.manifest = releaseClaim(this.manifest, videoId, { ...options, clock: this.clock });
    this.save();
    return this.getVideo(videoId);
  }

  recoverStaleClaims() {
    const result = recoverStaleClaims(this.manifest, this);
    this.manifest = result.manifest;
    if (result.recoveredIds.length) this.save();
    return result.recoveredIds;
  }

  linkProduction(videoId, productionProjectId) {
    this.manifest = linkProduction(this.manifest, videoId, productionProjectId, this);
    this.save();
    return this.getVideo(videoId);
  }
}

export class ChannelStore {
  constructor(root, options = {}) {
    if (typeof root !== 'string' || !root.trim()) throw new Error('root: must be a non-empty path');
    this.root = path.resolve(root);
    this.clock = options.clock;
    this.idGenerator = options.idGenerator;
  }

  create(input = {}) {
    const manifest = createChannelManifest(input, this);
    const dir = safeChild(this.root, manifest.id);
    if (fs.existsSync(dir)) throw new Error(`Refusing to overwrite existing channel workspace: ${dir}`);
    fs.mkdirSync(this.root, { recursive: true });
    return ChannelWorkspace.create(dir, manifest, this);
  }

  load(channelId) {
    const dir = safeChild(this.root, channelId);
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing symlinked channel workspace: ${dir}`);
    return ChannelWorkspace.load(dir, this);
  }

  list() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith(`${CHANNEL_ID_PREFIX}_`))
      .map(entry => this.load(entry.name))
      .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name) || left.manifest.id.localeCompare(right.manifest.id));
  }

  update(channelId, patch) {
    const workspace = this.load(channelId);
    if (typeof patch === 'function') {
      const result = patch(workspace.snapshot());
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('update callback must return a manifest snapshot');
      if (result.id !== channelId) throw new Error('update callback must preserve manifest.id');
      workspace.manifest = validateChannelManifest(clone(result));
      workspace.save();
      return workspace.snapshot();
    }
    return workspace.update(patch);
  }
}

export { atomicWriteJson };
