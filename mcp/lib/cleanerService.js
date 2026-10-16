// Cleaner capability service for agents using Vidmyo through MCP.
// The calling agent supplies editorial decisions; no nested provider is launched.

import fs from 'node:fs';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { DEFAULT_REPURPOSE_ENGINE_DIR, DEFAULT_REPURPOSE_PYTHON } from '../../packages/core/index.js';

const MANIFEST = 'cleaner.json';
const PLAN = path.join('artifacts', 'cleaner-plan.v1.json');
const SEGMENT_ID = /^segment_\d{6}$/;

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch { /* replaced */ } }
}

function readJson(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path.basename(file)} is invalid`);
  return value;
}

function analysisUnits(transcript) {
  const words = new Map((transcript.words || []).map(item => [item.id, item]));
  const units = [];
  const add = (selected, fallback = {}) => {
    const start = selected.length ? Number(selected[0].start_seconds) : Number(fallback.start_seconds || 0);
    const end = selected.length ? Number(selected.at(-1).end_seconds) : Number(fallback.end_seconds || start);
    const text = selected.length ? selected.map(item => item.text).join(' ').trim() : String(fallback.text || '').trim();
    if (text && end > start) units.push({ id: `segment_${String(units.length + 1).padStart(6, '0')}`, start_seconds: start, end_seconds: end, text });
  };
  for (const segment of transcript.segments || []) {
    const selected = (segment.word_ids || []).map(id => words.get(id)).filter(Boolean);
    if (!selected.length) { add([], segment); continue; }
    let current = [selected[0]];
    for (const word of selected.slice(1)) {
      if (Number(word.start_seconds) - Number(current.at(-1).end_seconds) >= 0.25) { add(current); current = []; }
      current.push(word);
    }
    add(current);
  }
  return units;
}

export function createCleanerMcpService({
  repurposeService,
  python = DEFAULT_REPURPOSE_PYTHON,
  engineDir = DEFAULT_REPURPOSE_ENGINE_DIR,
  execFile = nodeExecFile,
} = {}) {
  if (!repurposeService) throw new Error('Cleaner MCP service requires the shared Repurpose service');

  function requireProject(projectDir) {
    const dir = absolute(projectDir, 'project_dir');
    const manifest = readJson(path.join(dir, MANIFEST));
    return { dir, manifest };
  }

  function transcript(projectDir) {
    const precise = path.join(projectDir, 'artifacts', 'cleaner-transcript.v1.json');
    return readJson(fs.existsSync(precise) ? precise : path.join(projectDir, 'artifacts', 'transcript-artifact.v1.json'));
  }

  function runCleaner(command, projectDir, modelCache = null) {
    return new Promise((resolve, reject) => {
      execFile(python, ['-m', 'vidmyo_repurpose.cleaner', command, '--project', projectDir], {
        env: { ...process.env, ...(modelCache ? { VIDMYO_CLEANER_MODEL_CACHE: modelCache } : {}), PYTHONPATH: [path.join(engineDir, 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
        timeout: 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout = '', stderr = '') => {
        if (error) reject(new Error(String(stderr || stdout || error.message).trim().slice(0, 1000)));
        else resolve(stdout);
      });
    });
  }

  return {
    create({ projectDir, sourcePath, scriptMode, scriptText, includeMp4, saveMode }) {
      const dir = absolute(projectDir, 'project_dir');
      const source = absolute(sourcePath, 'source_path');
      if (!['exact', 'rough', 'freestyle'].includes(scriptMode)) throw new Error('script_mode is invalid');
      if (scriptMode !== 'freestyle' && !String(scriptText || '').trim()) throw new Error('script_text is required for exact or rough mode');
      repurposeService.create({
        projectDir: dir, sourcePath: source, requestedClipCount: 1,
        contentType: 'general_speech', targetPlatforms: ['cleaner'],
        renderDefaults: { captions: { enabled: false, style: 'clean' } },
      });
      const created = new Date().toISOString();
      const manifest = {
        id: `cleaner_mcp_${Date.now()}`, version: 1,
        source: { type: 'local_file', uri: source },
        intake: { script_mode: scriptMode, script_text: scriptMode === 'freestyle' ? null : String(scriptText).trim(), language: 'en' },
        cleanup: { remove_retakes: true, remove_false_starts: true, remove_dead_air: true, remove_filler_words: false, pause_treatment: 'balanced', review_before_export: true },
        delivery: { include_mp4: includeMp4 !== false, save_mode: saveMode || 'custom' },
        analysis: { mode: 'mcp', provider: 'current_agent', model: null },
        stages: { setup: { state: 'completed' }, ingest: { state: 'pending' }, transcribe: { state: 'pending' }, decide_cuts: { state: 'pending' }, review: { state: 'pending' }, export: { state: 'pending' } },
        outputs: [], created_at: created, updated_at: created,
      };
      atomicJson(path.join(dir, MANIFEST), manifest);
      return { contract_version: 1, project_dir: dir, manifest };
    },

    get({ projectDir }) {
      const { dir, manifest } = requireProject(projectDir);
      let plan = null;
      try { plan = readJson(path.join(dir, PLAN)); } catch { /* pending */ }
      return {
        contract_version: 1, project_dir: dir, manifest,
        plan_summary: plan?.summary || null,
        outputs: manifest.outputs || [],
      };
    },

    prepare({ projectDir, stageOptions = {} }) {
      const { dir, manifest } = requireProject(projectDir);
      const repurpose = repurposeService.get({ projectDir: dir });
      if (stageOptions.model_cache) manifest.cleaner_model_cache = absolute(stageOptions.model_cache, 'model_cache');
      for (const stage of ['ingest', 'transcribe']) {
        if (repurpose.stages[stage].state === 'completed') manifest.stages[stage].state = 'completed';
        else if (repurpose.stages[stage].state === 'failed') manifest.stages[stage].state = 'failed';
      }
      manifest.updated_at = new Date().toISOString();
      atomicJson(path.join(dir, MANIFEST), manifest);
      const next = ['ingest', 'transcribe'].find(stage => repurpose.stages[stage].state !== 'completed');
      if (!next) return runCleaner('prepare-transcript', dir, manifest.cleaner_model_cache).then(() => ({ contract_version: 1, project_dir: dir, state: 'ready_for_decisions' }));
      const result = repurposeService.analyze({ projectDir: dir, stage: next, options: next === 'transcribe' ? stageOptions : {} });
      manifest.stages[next].state = result.job.state === 'error' ? 'failed' : 'running';
      manifest.updated_at = new Date().toISOString();
      atomicJson(path.join(dir, MANIFEST), manifest);
      return { contract_version: 1, project_dir: dir, state: 'preparing', repurpose_job: result.job, next_action: 'Poll get_repurpose_job, then call cleaner_prepare again.' };
    },

    getTranscript({ projectDir, offset = 0, limit = 120 }) {
      const { dir, manifest } = requireProject(projectDir);
      const items = analysisUnits(transcript(dir));
      const start = Math.max(0, Number(offset) || 0);
      const count = Math.max(1, Math.min(200, Number(limit) || 120));
      return {
        contract_version: 1, project_dir: dir, total: items.length, offset: start,
        segments: items.slice(start, start + count).map(item => ({
          segment_id: item.id, start_seconds: item.start_seconds, end_seconds: item.end_seconds,
          text: String(item.text || '').slice(0, 2000),
        })),
        editorial_rules: [
          'Submit only clear retakes, abandoned false starts, directions to camera, sound checks, or non-speech transcript noise.',
          'For repeated takes, keep the latest complete fluent take unless an earlier take connects better.',
          'Never remove useful unique content or filler words inside an otherwise good delivery. When uncertain, keep.',
        ],
        script: manifest.intake,
        quality_warnings: transcript(dir).quality_warnings || [],
        next_offset: start + count < items.length ? start + count : null,
      };
    },

    submitPlan({ projectDir, cuts }) {
      const { dir, manifest } = requireProject(projectDir);
      const segments = analysisUnits(transcript(dir));
      const byId = new Map(segments.map(item => [item.id, item]));
      const normalized = new Map();
      for (const cut of cuts) {
        if (!SEGMENT_ID.test(cut.segment_id) || !byId.has(cut.segment_id)) throw new Error(`Unknown transcript segment: ${cut.segment_id}`);
        if (!['retake', 'false_start', 'direction', 'non_speech'].includes(cut.category)) throw new Error(`Invalid category for ${cut.segment_id}`);
        const reason = String(cut.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240);
        if (!reason) throw new Error(`A reason is required for ${cut.segment_id}`);
        normalized.set(cut.segment_id, { category: cut.category, reason });
      }
      const decisions = segments.map(segment => {
        const cut = normalized.get(segment.id);
        const uncertain = (transcript(dir).quality_warnings || []).some(w => w.start_seconds < segment.end_seconds && w.end_seconds > segment.start_seconds);
        return {
          segment_id: segment.id, start_seconds: segment.start_seconds, end_seconds: segment.end_seconds,
          text: segment.text, proposed: cut ? 'cut' : 'keep', decision: cut && !uncertain ? 'cut' : 'keep', needs_review: uncertain,
          category: cut?.category || null, reason: cut?.reason || 'Kept by the conservative cleanup pass.',
        };
      });
      const plan = {
        version: 1, source: manifest.source, provider: { id: 'current_agent', model: null }, decisions,
        transcript_strategy: transcript(dir).cleaner_strategy || null,
        transcript_key: transcript(dir).cleaner_cache_key || null,
        quality_warnings: transcript(dir).quality_warnings || [],
        summary: { segments: decisions.length, proposed_cuts: normalized.size },
      };
      atomicJson(path.join(dir, PLAN), plan);
      manifest.stages.transcribe.state = 'completed';
      manifest.stages.decide_cuts.state = 'completed';
      manifest.stages.review.state = 'running';
      manifest.updated_at = new Date().toISOString();
      atomicJson(path.join(dir, MANIFEST), manifest);
      return { contract_version: 1, project_dir: dir, plan_summary: plan.summary };
    },

    setDecision({ projectDir, segmentId, decision }) {
      const { dir } = requireProject(projectDir);
      if (!SEGMENT_ID.test(segmentId) || !['keep', 'cut'].includes(decision)) throw new Error('Invalid Cleaner decision');
      const plan = readJson(path.join(dir, PLAN));
      const item = plan.decisions.find(entry => entry.segment_id === segmentId);
      if (!item) throw new Error(`Unknown transcript segment: ${segmentId}`);
      item.decision = decision;
      item.reviewed = true;
      plan.summary.proposed_cuts = plan.decisions.filter(entry => entry.decision === 'cut').length;
      atomicJson(path.join(dir, PLAN), plan);
      return { contract_version: 1, project_dir: dir, decision: item };
    },

    async render({ projectDir }) {
      const { dir, manifest } = requireProject(projectDir);
      if (manifest.delivery.include_mp4 === false) throw new Error('This Cleaner project was configured as review-plan only');
      manifest.stages.review.state = 'completed';
      manifest.stages.export.state = 'running';
      manifest.updated_at = new Date().toISOString();
      atomicJson(path.join(dir, MANIFEST), manifest);
      try {
        await runCleaner('render', dir);
        const outputFile = path.join(dir, 'exports', 'cleaned-video.mp4');
        if (!fs.existsSync(outputFile) || !fs.statSync(outputFile).isFile() || fs.statSync(outputFile).size === 0) {
          throw new Error('Cleaner renderer did not create a complete local MP4');
        }
        manifest.stages.export.state = 'completed';
        manifest.outputs = ['exports/cleaned-video.mp4'];
        manifest.updated_at = new Date().toISOString();
        atomicJson(path.join(dir, MANIFEST), manifest);
        return { contract_version: 1, project_dir: dir, output: 'exports/cleaned-video.mp4', publishing_allowed: false };
      } catch (error) {
        manifest.stages.export.state = 'failed';
        manifest.updated_at = new Date().toISOString();
        atomicJson(path.join(dir, MANIFEST), manifest);
        throw error;
      }
    },
  };
}
