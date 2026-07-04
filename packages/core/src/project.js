// Project manifests — the durable spine of Story Studio.
//
// One directory per project, one project.json manifest, scenes addressed by
// stable zero-padded IDs (s001, s002, …). Two production rules are enforced
// in code because they were learned the hard way (Omi mistakes.md 2026-07-01):
//   1. Scenes are resolved ONLY by explicit ID — never by array index or
//      "scene number = line number" assumptions.
//   2. A scene artifact is only accepted via acceptSceneArtifact(), which
//      requires the file to actually exist on disk (the visual check stays a
//      human/VLM gate above this layer, recorded via `approved`).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MANIFEST_NAME = 'project.json';
export const MANIFEST_VERSION = 1;

const SCENE_ID_RE = /^s\d{3,}$/;

export function sceneIdFor(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Scene numbers start at 1, got ${n}`);
  return `s${String(n).padStart(3, '0')}`;
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export class Project {
  constructor(dir, manifest) {
    this.dir = dir;
    this.manifest = manifest;
  }

  static create(dir, { brief = {}, style = 'doodle-v1', aspect = '16:9' } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, MANIFEST_NAME);
    if (fs.existsSync(file)) {
      throw new Error(`Refusing to overwrite existing manifest: ${file}`);
    }
    const now = new Date().toISOString();
    const manifest = {
      id: `proj_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      version: MANIFEST_VERSION,
      style,
      aspect,
      brief,               // { topic, audience, platform, durationSec, language, cta }
      script: null,
      scenes: [],
      voiceover: { source: null, artifact: null, wordTimings: null },
      renders: [],
      createdAt: now,
      updatedAt: now,
    };
    atomicWriteJson(file, manifest);
    return new Project(dir, manifest);
  }

  static load(dir) {
    const file = path.join(dir, MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.version !== MANIFEST_VERSION) {
      throw new Error(`Unsupported manifest version ${manifest.version} in ${file}`);
    }
    return new Project(dir, manifest);
  }

  save() {
    this.manifest.updatedAt = new Date().toISOString();
    atomicWriteJson(path.join(this.dir, MANIFEST_NAME), this.manifest);
    return this;
  }

  addScene({ beat = '', prompt = '', negative = '', imageSource = null } = {}) {
    const id = sceneIdFor(this.manifest.scenes.length + 1);
    const scene = {
      id,
      beat,
      prompt,
      negative,
      image: { source: imageSource, artifact: null, approved: false },
      narrationSpan: null,   // [startSec, endSec] filled in after voiceover timing
    };
    this.manifest.scenes.push(scene);
    this.save();
    return scene;
  }

  // The only sanctioned way to find a scene. Throws on malformed or unknown
  // IDs instead of silently returning a neighbor.
  getScene(id) {
    if (!SCENE_ID_RE.test(String(id))) {
      throw new Error(`Malformed scene id "${id}" — expected sNNN (e.g. s007)`);
    }
    const scene = this.manifest.scenes.find(s => s.id === id);
    if (!scene) throw new Error(`No scene ${id} in project ${this.manifest.id}`);
    return scene;
  }

  updateScene(id, patch) {
    const scene = this.getScene(id);
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue; // scene IDs are immutable
      scene[k] = v;
    }
    this.save();
    return scene;
  }

  // Record a generated artifact for a scene. The file must exist on disk —
  // "claimed" downloads are not accepted (logged production lesson).
  acceptSceneArtifact(id, artifactPath, { approved = false } = {}) {
    const scene = this.getScene(id);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Artifact for ${id} does not exist on disk: ${artifactPath}`);
    }
    scene.image.artifact = artifactPath;
    scene.image.approved = approved;
    this.save();
    return scene;
  }

  approveScene(id) {
    const scene = this.getScene(id);
    if (!scene.image.artifact) {
      throw new Error(`Cannot approve ${id}: no artifact recorded yet`);
    }
    scene.image.approved = true;
    this.save();
    return scene;
  }

  // Scenes that still need generation or approval — the resume queue.
  pendingScenes() {
    return this.manifest.scenes.filter(s => !s.image.artifact || !s.image.approved);
  }
}
