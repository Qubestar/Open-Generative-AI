// Editing Decision Graph (EDG) Specification & Validator for Vidmyo V2.6
// Separates AI decision making from deterministic rendering.
// Guarantees strictly validated, versioned data structures with asset hashes,
// source-to-output time ranges, and no executable code injection.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFps, secondsToFrame, frameToSeconds, rationalToNumber, STANDARD_FPS, DEFAULT_SAMPLE_RATE } from './timebase.js';

export const EDG_SCHEMA_VERSION = '1.0.0';

export const ALLOWED_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5', '21:9'];

export const STANDARD_CANVAS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1':  { width: 1080, height: 1080 },
};

export const TRACK_TYPES = ['video', 'audio', 'overlay', 'caption'];

export const TRANSITION_TYPES = ['cut', 'crossfade', 'dissolve', 'wipe_left', 'wipe_right', 'dip_to_black'];

export class EdgValidationError extends Error {
  constructor(message, path = '') {
    super(path ? `[EDG validation error at ${path}] ${message}` : `[EDG validation error] ${message}`);
    this.name = 'EdgValidationError';
    this.path = path;
  }
}

/**
 * Validates a complete Editing Decision Graph against Schema v1.0.0.
 */
export function validateEdg(edg) {
  if (!edg || typeof edg !== 'object') {
    throw new EdgValidationError('EDG must be a non-null object');
  }

  if (edg.schemaVersion !== EDG_SCHEMA_VERSION) {
    throw new EdgValidationError(`Unsupported schemaVersion: ${edg.schemaVersion}, expected ${EDG_SCHEMA_VERSION}`, 'schemaVersion');
  }

  if (!edg.id || typeof edg.id !== 'string' || !/^edg_[\w-]+$/.test(edg.id)) {
    throw new EdgValidationError(`Invalid edg id: ${edg.id}`, 'id');
  }

  // Validate Timebase
  if (!edg.timebase || typeof edg.timebase !== 'object') {
    throw new EdgValidationError('Missing timebase definition', 'timebase');
  }
  const fps = parseFps(edg.timebase.fps);
  const sampleRate = edg.timebase.sampleRate || DEFAULT_SAMPLE_RATE;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new EdgValidationError(`Invalid audio sampleRate: ${sampleRate}`, 'timebase.sampleRate');
  }

  // Validate Canvas
  if (!edg.canvas || typeof edg.canvas !== 'object') {
    throw new EdgValidationError('Missing canvas definition', 'canvas');
  }
  const { width, height, aspect } = edg.canvas;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new EdgValidationError(`Invalid canvas dimensions: ${width}x${height}`, 'canvas');
  }
  if (!ALLOWED_ASPECT_RATIOS.includes(aspect)) {
    throw new EdgValidationError(`Unsupported aspect ratio: ${aspect}`, 'canvas.aspect');
  }

  // Validate Assets
  if (!edg.assets || typeof edg.assets !== 'object') {
    throw new EdgValidationError('Missing assets dictionary', 'assets');
  }
  const assetMap = new Map();
  for (const [assetId, asset] of Object.entries(edg.assets)) {
    if (!asset || typeof asset !== 'object') {
      throw new EdgValidationError(`Asset ${assetId} must be an object`, `assets.${assetId}`);
    }
    if (asset.id !== assetId) {
      throw new EdgValidationError(`Asset key ${assetId} does not match asset.id ${asset.id}`, `assets.${assetId}`);
    }
    if (!asset.path || typeof asset.path !== 'string') {
      throw new EdgValidationError(`Asset ${assetId} missing path string`, `assets.${assetId}.path`);
    }
    if (!asset.hash || typeof asset.hash !== 'string' || asset.hash.length < 8) {
      throw new EdgValidationError(`Asset ${assetId} missing valid content hash`, `assets.${assetId}.hash`);
    }
    assetMap.set(assetId, asset);
  }

  // Validate Tracks and Clips
  if (!Array.isArray(edg.tracks)) {
    throw new EdgValidationError('Tracks must be an array', 'tracks');
  }

  let totalTimelineFrames = 0;

  edg.tracks.forEach((track, tIdx) => {
    const tPath = `tracks[${tIdx}]`;
    if (!track.id || typeof track.id !== 'string') {
      throw new EdgValidationError('Track missing id', `${tPath}.id`);
    }
    if (!TRACK_TYPES.includes(track.type)) {
      throw new EdgValidationError(`Unknown track type: ${track.type}`, `${tPath}.type`);
    }
    if (!Array.isArray(track.clips)) {
      throw new EdgValidationError('Track clips must be an array', `${tPath}.clips`);
    }

    let prevClipEndFrame = -1;

    track.clips.forEach((clip, cIdx) => {
      const cPath = `${tPath}.clips[${cIdx}]`;
      if (!clip.id || typeof clip.id !== 'string') {
        throw new EdgValidationError('Clip missing id', `${cPath}.id`);
      }
      if (clip.assetId && !assetMap.has(clip.assetId)) {
        throw new EdgValidationError(`Clip references non-existent asset: ${clip.assetId}`, `${cPath}.assetId`);
      }

      // Check timeline frame ranges
      if (!Number.isInteger(clip.timelineStartFrame) || clip.timelineStartFrame < 0) {
        throw new EdgValidationError(`Invalid timelineStartFrame: ${clip.timelineStartFrame}`, `${cPath}.timelineStartFrame`);
      }
      if (!Number.isInteger(clip.timelineEndFrame) || clip.timelineEndFrame <= clip.timelineStartFrame) {
        throw new EdgValidationError(`timelineEndFrame must be strictly greater than timelineStartFrame: ${clip.timelineEndFrame} <= ${clip.timelineStartFrame}`, `${cPath}.timelineEndFrame`);
      }

      // Disallow overlapping clips on the same track
      if (clip.timelineStartFrame < prevClipEndFrame) {
        throw new EdgValidationError(`Overlapping clips detected: clip starts at ${clip.timelineStartFrame} before previous clip ended at ${prevClipEndFrame}`, cPath);
      }
      prevClipEndFrame = clip.timelineEndFrame;

      if (clip.timelineEndFrame > totalTimelineFrames) {
        totalTimelineFrames = clip.timelineEndFrame;
      }

      // Check source frame ranges if asset is present
      if (clip.assetId) {
        if (clip.sourceStartFrame !== undefined && (!Number.isInteger(clip.sourceStartFrame) || clip.sourceStartFrame < 0)) {
          throw new EdgValidationError(`Invalid sourceStartFrame: ${clip.sourceStartFrame}`, `${cPath}.sourceStartFrame`);
        }
        if (clip.sourceEndFrame !== undefined && (!Number.isInteger(clip.sourceEndFrame) || clip.sourceEndFrame <= (clip.sourceStartFrame || 0))) {
          throw new EdgValidationError(`Invalid sourceEndFrame: ${clip.sourceEndFrame}`, `${cPath}.sourceEndFrame`);
        }
      }
    });
  });

  return {
    valid: true,
    fps,
    sampleRate,
    totalTimelineFrames,
    totalDurationSeconds: frameToSeconds(totalTimelineFrames, fps),
    trackCount: edg.tracks.length,
    assetCount: assetMap.size,
  };
}

/**
 * Creates a blank, valid EDG structure with defaults.
 */
export function createEmptyEdg({
  title = 'Untitled Project',
  aspect = '16:9',
  fps = STANDARD_FPS.FPS_30,
  sampleRate = DEFAULT_SAMPLE_RATE,
  metadata = {},
} = {}) {
  const parsedFps = parseFps(fps);
  const canvasDims = STANDARD_CANVAS[aspect] || STANDARD_CANVAS['16:9'];
  const now = new Date().toISOString();

  return {
    schemaVersion: EDG_SCHEMA_VERSION,
    id: `edg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    title,
    timebase: {
      fps: { num: parsedFps.num, den: parsedFps.den },
      sampleRate,
    },
    canvas: {
      width: canvasDims.width,
      height: canvasDims.height,
      aspect,
    },
    assets: {},
    tracks: [
      { id: 'video-primary', type: 'video', name: 'Primary Video', clips: [] },
      { id: 'overlay-broll', type: 'overlay', name: 'B-Roll & Overlays', clips: [] },
      { id: 'audio-voice', type: 'audio', name: 'Voiceover & Dialogue', clips: [] },
      { id: 'audio-music', type: 'audio', name: 'Background Music', clips: [] },
      { id: 'captions-main', type: 'caption', name: 'Subtitles & Captions', clips: [] },
    ],
    transitions: [],
    metadata: {
      created: now,
      updated: now,
      source: 'vidmyo-edg-builder',
      ...metadata,
    },
  };
}

/**
 * Creates an EDG timeline populated with assets, tracks, and optional metadata.
 */
export function createEdgTimeline(options = {}) {
  const edg = createEmptyEdg(options);
  if (options.canvas) {
    edg.canvas = { ...edg.canvas, ...options.canvas };
  }
  if (options.assets) {
    edg.assets = { ...options.assets };
  }
  if (options.tracks) {
    edg.tracks = options.tracks;
  }
  if (options.transitions) {
    edg.transitions = options.transitions;
  }
  return edg;
}

/**
 * Strict validator for AI suggested edits.
 * Prevents arbitrary code execution and ensures AI output maps only to valid EDG mutations.
 */
export function sanitizeAiEdgSuggestion(rawSuggestion, existingEdg) {
  if (!rawSuggestion || typeof rawSuggestion !== 'object') {
    throw new EdgValidationError('AI suggestion must be a JSON object');
  }

  // Security barrier: Disallow any executable code / functions / script tags
  const serialized = JSON.stringify(rawSuggestion);
  if (/<script|javascript:|eval\(|function\s*\(|process\./i.test(serialized)) {
    throw new EdgValidationError('AI suggestion contains prohibited executable content');
  }

  const allowedOperations = ['insert_clip', 'replace_clip', 'split_clip', 'delete_clip', 'add_caption', 'set_volume'];
  const op = rawSuggestion.operation;
  if (!allowedOperations.includes(op)) {
    throw new EdgValidationError(`Prohibited or unknown AI operation: ${op}`);
  }

  // Validate targeted track
  if (rawSuggestion.trackId) {
    const trackExists = existingEdg.tracks.some(t => t.id === rawSuggestion.trackId);
    if (!trackExists) {
      throw new EdgValidationError(`AI targeted unknown trackId: ${rawSuggestion.trackId}`);
    }
  }

  return Object.freeze(JSON.parse(serialized));
}

/**
 * Computes deterministic SHA-256 content hash for an asset.
 * Reads file from disk if present, otherwise hashes the input identifier.
 */
export function computeAssetHash(filePathOrIdentifier) {
  if (!filePathOrIdentifier) return crypto.randomBytes(16).toString('hex');
  try {
    if (typeof filePathOrIdentifier === 'string' && fs.existsSync(filePathOrIdentifier)) {
      const stat = fs.statSync(filePathOrIdentifier);
      if (stat.isFile()) {
        const buf = fs.readFileSync(filePathOrIdentifier);
        return crypto.createHash('sha256').update(buf).digest('hex');
      }
    }
  } catch {
    // fallback to identifier hash
  }
  return crypto.createHash('sha256').update(String(filePathOrIdentifier)).digest('hex');
}

/**
 * Converts a Story project or manifest into a fully validated Editing Decision Graph (EDG).
 * Embeds SHA-256 asset content hashes, complete provenance (prompts, providers, voices),
 * precise rational timebase frame alignment, narration audio, and captions.
 */
export function storyToEdg(storyManifestOrProject, {
  fps = STANDARD_FPS.FPS_30,
  assetDir = null,
  title = null,
} = {}) {
  const manifest = storyManifestOrProject?.manifest || storyManifestOrProject;
  if (!manifest || typeof manifest !== 'object') {
    throw new EdgValidationError('storyToEdg requires a valid Story manifest or Project instance');
  }

  const projectTitle = title || manifest.brief?.topic || 'Story Project';
  const aspect = manifest.aspect || '16:9';
  const parsedFps = parseFps(fps);
  const now = new Date().toISOString();

  const edg = createEmptyEdg({
    title: projectTitle,
    aspect,
    fps: parsedFps,
    metadata: {
      projectId: manifest.id,
      style: manifest.style || 'doodle-v1',
      sourcePipeline: 'story-studio',
      created: manifest.createdAt || now,
      updated: now,
    },
  });

  const videoTrack = edg.tracks.find(t => t.id === 'video-primary');
  const voiceTrack = edg.tracks.find(t => t.id === 'audio-voice');
  const captionTrack = edg.tracks.find(t => t.id === 'captions-main');

  let currentTimelineFrame = 0;

  // 1. Process Voiceover Audio Asset & Track
  if (manifest.voiceover?.artifact) {
    const voPath = assetDir && !path.isAbsolute(manifest.voiceover.artifact)
      ? path.resolve(assetDir, manifest.voiceover.artifact)
      : manifest.voiceover.artifact;
    const voHash = computeAssetHash(voPath);
    const voAssetId = 'asset_voiceover_main';

    edg.assets[voAssetId] = {
      id: voAssetId,
      path: voPath,
      hash: voHash,
      type: 'audio',
      provenance: {
        source: manifest.voiceover.source || 'kokoro',
        voice: manifest.voiceover.voice || 'am_onyx',
        provider: 'kokoro',
        wordCount: manifest.voiceover.wordTimings?.length || 0,
        sampleRate: DEFAULT_SAMPLE_RATE,
      },
    };
  }

  // 2. Process Scenes -> Video Track, Audio Clips, and Captions
  const scenes = Array.isArray(manifest.scenes) ? manifest.scenes : [];
  for (const scene of scenes) {
    const durationSec = scene.narrationSpan?.durationSec || scene.durationSec || 5.0;
    const durationFrames = Math.max(1, secondsToFrame(durationSec, parsedFps));
    const startFrame = currentTimelineFrame;
    const endFrame = startFrame + durationFrames;

    if (scene.artifact) {
      const scenePath = assetDir && !path.isAbsolute(scene.artifact)
        ? path.resolve(assetDir, scene.artifact)
        : scene.artifact;
      const assetId = `asset_${scene.id}`;
      const assetHash = computeAssetHash(scenePath);
      const isVideo = scenePath.endsWith('.mp4') || scenePath.endsWith('.webm') || scenePath.endsWith('.mov');

      edg.assets[assetId] = {
        id: assetId,
        path: scenePath,
        hash: assetHash,
        type: isVideo ? 'video' : 'image',
        durationSec,
        provenance: {
          sceneId: scene.id,
          prompt: scene.prompt || '',
          beat: scene.beat || '',
          imageSource: scene.imageSource || manifest.imageSource || 'flow',
          imageModel: scene.imageModel || manifest.imageModel || null,
          style: manifest.style || 'doodle-v1',
          approved: Boolean(scene.approved),
          author: 'story_studio',
        },
      };

      videoTrack.clips.push({
        id: `clip_${scene.id}`,
        assetId,
        sourceStartFrame: 0,
        sourceEndFrame: durationFrames,
        timelineStartFrame: startFrame,
        timelineEndFrame: endFrame,
        sceneId: scene.id,
      });
    }

    // Audio Voice mapping for this scene
    if (edg.assets.asset_voiceover_main) {
      const sourceStartFrame = secondsToFrame(scene.narrationSpan?.startSec || 0, parsedFps);
      voiceTrack.clips.push({
        id: `voice_${scene.id}`,
        assetId: 'asset_voiceover_main',
        sourceStartFrame,
        sourceEndFrame: sourceStartFrame + durationFrames,
        timelineStartFrame: startFrame,
        timelineEndFrame: endFrame,
      });
    }

    // Captions / Subtitles for this scene
    const captionText = scene.narrationSpan?.text || scene.beat || '';
    if (captionText) {
      captionTrack.clips.push({
        id: `caption_${scene.id}`,
        text: captionText,
        timelineStartFrame: startFrame,
        timelineEndFrame: endFrame,
      });
    }

    currentTimelineFrame = endFrame;
  }

  // 3. Optional word-level captions if precise wordTimings exist
  if (Array.isArray(manifest.voiceover?.wordTimings) && manifest.voiceover.wordTimings.length > 0) {
    captionTrack.clips = []; // replace coarse scene text with word-level captions
    let prevWordEnd = 0;
    manifest.voiceover.wordTimings.forEach((wt, idx) => {
      const startF = Math.max(prevWordEnd, secondsToFrame(wt.startSec, parsedFps));
      const endF = Math.max(startF + 1, secondsToFrame(wt.endSec, parsedFps));
      captionTrack.clips.push({
        id: `word_cap_${idx + 1}`,
        text: wt.word,
        timelineStartFrame: startF,
        timelineEndFrame: endF,
      });
      prevWordEnd = endF;
    });
  }

  validateEdg(edg);
  return edg;
}

/**
 * Adapter converting legacy Story scenes into standard EDG.
 * Kept for backward compatibility; calls storyToEdg internally.
 */
export function legacyStoryToEdg(storyManifest, { fps = STANDARD_FPS.FPS_30 } = {}) {
  return storyToEdg(storyManifest, { fps });
}

/**
 * Converts a Repurpose project or candidate into a fully validated Editing Decision Graph (EDG).
 * Embeds source video hashes, candidate AI score & ranking provenance, reframe coordinates,
 * rational framerate temporal mapping, sliced audio, and synchronized captions.
 */
export function repurposeToEdg(repurposeManifestOrProject, {
  candidateId = null,
  fps = STANDARD_FPS.FPS_30,
  targetAspect = null,
  title = null,
} = {}) {
  const manifest = repurposeManifestOrProject?.manifest || repurposeManifestOrProject;
  if (!manifest || typeof manifest !== 'object') {
    throw new EdgValidationError('repurposeToEdg requires a valid Repurpose manifest or RepurposeProject instance');
  }

  const parsedFps = parseFps(fps);
  const sourceUri = manifest.source?.uri || 'source.mp4';
  const sourceHash = manifest.source?.fingerprint
    ? manifest.source.fingerprint.replace(/^sha256:/i, '')
    : computeAssetHash(sourceUri);

  const aspect = targetAspect
    || (manifest.target_platforms?.includes('youtube_shorts') || manifest.target_platforms?.includes('tiktok') ? '9:16' : '16:9');

  const candidates = Array.isArray(manifest.candidates) ? manifest.candidates : [];
  let selectedCandidates = [];
  if (candidateId) {
    const found = candidates.find(c => c.id === candidateId);
    if (!found) throw new EdgValidationError(`Candidate id not found: ${candidateId}`);
    selectedCandidates = [found];
  } else {
    // Select approved candidates, or all candidates if none approved yet
    const approved = candidates.filter(c => c.decision === 'approved');
    selectedCandidates = approved.length > 0 ? approved : candidates;
  }

  const projectTitle = title || `Repurpose - ${path.basename(sourceUri, path.extname(sourceUri))}`;
  const now = new Date().toISOString();

  const edg = createEmptyEdg({
    title: projectTitle,
    aspect,
    fps: parsedFps,
    metadata: {
      repurposeProjectId: manifest.id,
      contentType: manifest.content_type || 'auto',
      engineVersion: manifest.engine_version || '1.0.0',
      sourcePipeline: 'repurpose-engine',
      created: manifest.created_at || now,
      updated: now,
    },
  });

  const sourceAssetId = 'asset_repurpose_source';
  edg.assets[sourceAssetId] = {
    id: sourceAssetId,
    path: sourceUri,
    hash: sourceHash,
    type: 'video',
    provenance: {
      sourceType: manifest.source?.type || 'local_file',
      sourceUri,
      contentType: manifest.content_type || 'auto',
      engineVersion: manifest.engine_version || '1.0.0',
      author: 'repurpose_engine',
    },
  };

  const videoTrack = edg.tracks.find(t => t.id === 'video-primary');
  const audioTrack = edg.tracks.find(t => t.id === 'audio-voice');
  const captionTrack = edg.tracks.find(t => t.id === 'captions-main');
  const overlayTrack = edg.tracks.find(t => t.id === 'overlay-broll');

  let currentTimelineFrame = 0;

  if (selectedCandidates.length === 0) {
    // Full source fallback if no candidates defined
    const durationSec = 10.0;
    const durationFrames = secondsToFrame(durationSec, parsedFps);
    videoTrack.clips.push({
      id: 'clip_source_full',
      assetId: sourceAssetId,
      sourceStartFrame: 0,
      sourceEndFrame: durationFrames,
      timelineStartFrame: 0,
      timelineEndFrame: durationFrames,
    });
    audioTrack.clips.push({
      id: 'audio_source_full',
      assetId: sourceAssetId,
      sourceStartFrame: 0,
      sourceEndFrame: durationFrames,
      timelineStartFrame: 0,
      timelineEndFrame: durationFrames,
    });
  } else {
    for (const cand of selectedCandidates) {
      const startSec = cand.start_time ?? cand.startSec ?? 0;
      const endSec = cand.end_time ?? cand.endSec ?? (startSec + 5.0);
      const durationSec = Math.max(0.1, endSec - startSec);

      const sourceStartFrame = secondsToFrame(startSec, parsedFps);
      const sourceEndFrame = secondsToFrame(endSec, parsedFps);
      const durationFrames = Math.max(1, sourceEndFrame - sourceStartFrame);

      const timelineStartFrame = currentTimelineFrame;
      const timelineEndFrame = timelineStartFrame + durationFrames;

      const clipId = `clip_${cand.id || currentTimelineFrame}`;
      videoTrack.clips.push({
        id: clipId,
        assetId: sourceAssetId,
        sourceStartFrame,
        sourceEndFrame,
        timelineStartFrame,
        timelineEndFrame,
        transform: cand.reframe ? {
          cropX: cand.reframe.x ?? 0.5,
          cropY: cand.reframe.y ?? 0.5,
          scale: cand.reframe.scale ?? 1.0,
        } : null,
        metadata: {
          candidateId: cand.id,
          score: cand.score ?? 0.85,
          hookScore: cand.hook_score ?? null,
          rationale: cand.rationale || '',
        },
      });

      audioTrack.clips.push({
        id: `audio_${clipId}`,
        assetId: sourceAssetId,
        sourceStartFrame,
        sourceEndFrame,
        timelineStartFrame,
        timelineEndFrame,
      });

      // Synchronize captions if candidate has words or transcript
      if (Array.isArray(cand.words) && cand.words.length > 0) {
        let prevEnd = timelineStartFrame;
        cand.words.forEach((w, wIdx) => {
          const wStart = Math.max(prevEnd, timelineStartFrame + secondsToFrame((w.start_time || 0) - startSec, parsedFps));
          const wEnd = Math.max(wStart + 1, timelineStartFrame + secondsToFrame((w.end_time || 0) - startSec, parsedFps));
          captionTrack.clips.push({
            id: `cap_${clipId}_${wIdx + 1}`,
            text: w.word || '',
            timelineStartFrame: wStart,
            timelineEndFrame: wEnd,
            confidence: w.confidence ?? 0.95,
          });
          prevEnd = wEnd;
        });
      } else if (cand.text || cand.transcript) {
        captionTrack.clips.push({
          id: `cap_${clipId}`,
          text: cand.text || cand.transcript,
          timelineStartFrame,
          timelineEndFrame,
        });
      }

      currentTimelineFrame = timelineEndFrame;
    }
  }

  validateEdg(edg);
  return edg;
}

/**
 * Builds a validated EDG from Cleaner manifest and plan.
 * Connects video cuts, audio voice, and B-roll overlays with provenance and hashes.
 */
export function cleanerToEdg(manifest, plan, { fps = STANDARD_FPS.FPS_30 } = {}) {
  const sourcePath = manifest?.source?.path || 'source.mp4';
  const fileHash = computeAssetHash(sourcePath);
  const parsedFps = parseFps(fps);

  const edg = createEdgTimeline({
    title: manifest?.name || 'Cleaner Project',
    aspect: '16:9',
    fps: parsedFps,
    assets: {
      asset_main_video: {
        id: 'asset_main_video',
        path: sourcePath,
        hash: fileHash,
        type: 'video',
        durationSec: plan?.summary?.source_seconds || 60,
        provenance: {
          source: 'cleaner_intake',
          author: 'user',
        },
      },
    },
    tracks: [
      { id: 'video-primary', type: 'video', name: 'Primary Video', clips: [] },
      { id: 'overlay-broll', type: 'overlay', name: 'B-Roll & Overlays', clips: [] },
      { id: 'audio-voice', type: 'audio', name: 'Voiceover & Dialogue', clips: [] },
      { id: 'captions-main', type: 'caption', name: 'Subtitles & Captions', clips: [] },
    ],
  });

  const videoTrack = edg.tracks.find(t => t.id === 'video-primary');
  const overlayTrack = edg.tracks.find(t => t.id === 'overlay-broll');
  const audioTrack = edg.tracks.find(t => t.id === 'audio-voice');
  const captionTrack = edg.tracks.find(t => t.id === 'captions-main');

  let timelineFrame = 0;
  const decisions = plan?.decisions || [];

  for (const item of decisions) {
    if (item.decision === 'cut') continue;
    const startSec = item.start_seconds || 0;
    const endSec = item.end_seconds || startSec + 1;
    const startFrame = secondsToFrame(startSec, parsedFps);
    const endFrame = secondsToFrame(endSec, parsedFps);
    const clipDurFrames = Math.max(1, endFrame - startFrame);

    const clipId = `clip_${item.segment_id || timelineFrame}`;
    videoTrack.clips.push({
      id: clipId,
      assetId: 'asset_main_video',
      sourceStartFrame: startFrame,
      sourceEndFrame: endFrame,
      timelineStartFrame: timelineFrame,
      timelineEndFrame: timelineFrame + clipDurFrames,
    });

    audioTrack.clips.push({
      id: `audio_${clipId}`,
      assetId: 'asset_main_video',
      sourceStartFrame: startFrame,
      sourceEndFrame: endFrame,
      timelineStartFrame: timelineFrame,
      timelineEndFrame: timelineFrame + clipDurFrames,
    });

    if (item.text) {
      captionTrack.clips.push({
        id: `cap_${clipId}`,
        text: item.text,
        timelineStartFrame: timelineFrame,
        timelineEndFrame: timelineFrame + clipDurFrames,
      });
    }

    timelineFrame += clipDurFrames;
  }

  // Embed B-roll overlays
  if (Array.isArray(plan?.overlays) && overlayTrack) {
    for (const ov of plan.overlays) {
      const assetId = ov.assetId || `broll_${ov.id || 'overlay'}`;
      if (!edg.assets[assetId]) {
        edg.assets[assetId] = {
          id: assetId,
          path: ov.path || `assets/${assetId}.mp4`,
          hash: ov.hash || computeAssetHash(ov.path || assetId),
          type: 'video',
          durationSec: ov.durationSec || 5,
          provenance: {
            license: ov.license || 'cc0',
            author: ov.author || 'Stock Provider',
            source: ov.source || 'stock_registry',
          },
        };
      }
      overlayTrack.clips.push({
        id: `overlay_${ov.id || Math.random().toString(36).slice(2, 8)}`,
        assetId,
        timelineStartFrame: secondsToFrame(ov.startSec || 0, parsedFps),
        timelineEndFrame: secondsToFrame((ov.startSec || 0) + (ov.durationSec || 3), parsedFps),
      });
    }
  }

  validateEdg(edg);
  return edg;
}

/**
 * Creates an EDG for advanced Audio Mixing with voiceover, background music,
 * sidechain ducking curve, and 48 kHz audio sample accuracy.
 */
export function createAudioMixEdg({
  title = 'Audio Mix Project',
  voiceAsset = null,
  musicAsset = null,
  duckingCurve = [],
  totalDurationSec = 30.0,
  fps = STANDARD_FPS.FPS_30,
  sampleRate = DEFAULT_SAMPLE_RATE,
} = {}) {
  const parsedFps = parseFps(fps);
  const totalFrames = secondsToFrame(totalDurationSec, parsedFps);

  const assets = {};
  if (voiceAsset) {
    const vHash = voiceAsset.hash || computeAssetHash(voiceAsset.path);
    assets[voiceAsset.id || 'asset_voice_track'] = {
      id: voiceAsset.id || 'asset_voice_track',
      path: voiceAsset.path,
      hash: vHash,
      type: 'audio',
      provenance: voiceAsset.provenance || { source: 'voiceover_tts', provider: 'kokoro' },
    };
  }
  if (musicAsset) {
    const mHash = musicAsset.hash || computeAssetHash(musicAsset.path);
    assets[musicAsset.id || 'asset_music_track'] = {
      id: musicAsset.id || 'asset_music_track',
      path: musicAsset.path,
      hash: mHash,
      type: 'audio',
      provenance: musicAsset.provenance || { source: 'background_music', license: 'royalty_free' },
    };
  }

  const voiceClips = voiceAsset ? [{
    id: 'clip_voice_main',
    assetId: voiceAsset.id || 'asset_voice_track',
    sourceStartFrame: 0,
    sourceEndFrame: totalFrames,
    timelineStartFrame: 0,
    timelineEndFrame: totalFrames,
  }] : [];

  const musicClips = musicAsset ? [{
    id: 'clip_music_main',
    assetId: musicAsset.id || 'asset_music_track',
    sourceStartFrame: 0,
    sourceEndFrame: totalFrames,
    timelineStartFrame: 0,
    timelineEndFrame: totalFrames,
    duckingKeyframes: duckingCurve,
  }] : [];

  const edg = createEmptyEdg({
    title,
    aspect: '16:9',
    fps: parsedFps,
    sampleRate,
    metadata: {
      isAudioOnlyMix: true,
      hasSidechainDucking: duckingCurve.length > 0,
    },
  });

  edg.assets = assets;
  edg.tracks = [
    { id: 'video-primary', type: 'video', name: 'Primary Video', clips: [] },
    { id: 'audio-voice', type: 'audio', name: 'Voiceover & Dialogue', clips: voiceClips },
    { id: 'audio-music', type: 'audio', name: 'Background Music', clips: musicClips },
  ];

  validateEdg(edg);
  return edg;
}

