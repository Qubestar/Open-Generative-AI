// Agent-authored scripts/code, local narration/render. Never launches a nested LLM.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Project, JobStore, DoodlePipeline, animationStyle, ANIMATION_STYLES, validateCreativeBrief,
  codeAnimationTask, validateCodeAnimation, creativeFingerprint, wavDurationSeconds,
  sceneIntervalsFromBeats, runGovernedProcess, produceCodeAnimation, assertAnimationIdle, acquireAnimationLock } from '../../packages/core/index.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const stamp = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const atomic = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file); };

export function createAnimationMcpService({ store = null, pipeline = null, renderImpl = null } = {}) {
  const jobs = () => store || (store = new JobStore());
  const active = new Map();
  function open(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('project_dir must be absolute.');
    const project = Project.load(fs.realpathSync(dir));
    if (project.manifest.brief?.kind !== 'animation' || animationStyle(project.manifest.style).engine !== 'code') throw new Error('This is not a code animation project.');
    return project;
  }
  function busy(project) {
    if (active.has(project.dir)) throw new Error('An animation job is already running.');
    assertAnimationIdle(project.dir);
  }
  function state(project, state, message) { project.manifest.production = { ...project.manifest.production, state, message }; project.save(); }
  function timing(project) {
    const manifest = project.manifest;
    if (!manifest.voiceover?.artifact) {
      if (manifest.brief.narration) throw new Error('Prepare the voiceover first.');
      return { durationSec: manifest.brief.durationSec, beats: [] };
    }
    if (manifest.production.preparedScript !== stamp(manifest.script)) throw new Error('The script changed; prepare narration again.');
    const audio = path.resolve(project.dir, manifest.voiceover.artifact);
    if (!fs.realpathSync(audio).startsWith(fs.realpathSync(project.dir) + path.sep)) throw new Error('Narration must be inside the project.');
    const durationSec = wavDurationSeconds(fs.readFileSync(audio));
    const beats = sceneIntervalsFromBeats(JSON.parse(fs.readFileSync(path.join(project.dir, 'beats.json'), 'utf8')).beats || [], durationSec);
    return { durationSec, beats };
  }
  function get(dir) {
    const project = open(dir), m = project.manifest;
    let time = null; try { time = timing(project); } catch {}
    return { project_dir: project.dir, id: m.id, style: { number: animationStyle(m.style).number, id: m.style, name: animationStyle(m.style).name }, brief: m.brief,
      state: m.production?.state, message: m.production?.message, script: m.script, voiceover: m.voiceover?.artifact || null,
      output: m.production?.state === 'done' ? m.production.output : null, timing: time,
      next: !m.script ? 'Write narration and call animations_set_script.' : !time ? 'Call animations_prepare; poll animations_get_job.' : !m.production?.codeFingerprint ? 'Call animations_code_task, author the HTML, then animations_submit_code.' : m.production.state !== 'done' ? 'Call animations_render; poll animations_get_job.' : 'MP4 ready. Publication uses the existing Publish workflow.' };
  }
  function start(dir, stage, work) {
    const project = open(dir); busy(project);
    const release = acquireAnimationLock(project.dir);
    let job; try { job = jobs().create({ type: 'animation-' + stage, project: project.manifest.id, params: { projectDir: project.dir, ownerPid: process.pid } }); } catch (error) { release(); throw error; }
    const controller = new AbortController(); active.set(project.dir, { controller, jobId: job.id });
    setImmediate(async () => {
      try {
        jobs().setState(job.id, 'running', { admit: false });
        await work(project, controller.signal, job.id);
        jobs().setState(job.id, 'done', { admit: false });
      } catch (error) {
        state(project, controller.signal.aborted ? 'cancelled' : 'error', String(error.message).slice(0, 1800));
        if (jobs().get(job.id)?.state !== 'cancelled') jobs().setState(job.id, 'error', { error: String(error.message).slice(0, 1800), admit: false });
      } finally { active.delete(project.dir); release(); }
    });
    return { job_id: job.id, state: job.state, project_dir: project.dir };
  }
  return {
    styles({ query = '', offset = 0, limit = 20 } = {}) {
      const list = ANIMATION_STYLES.filter(style => `${style.number} ${style.id} ${style.name} ${style.eyebrow}`.toLowerCase().includes(query.toLowerCase()));
      return { total: list.length, styles: list.slice(offset, offset + Math.min(50, limit)).map(({ number, id, name, eyebrow, engine, preview, sourceUrl }) => ({ number, id, name, category: eyebrow, engine, preview, sourceUrl })) };
    },
    create({ project_dir, topic, style, script = '', aspect = '16:9', duration_seconds = 30, language = 'English', narration = true, voice = 'am_onyx', details = '' }) {
      if (typeof project_dir !== 'string' || !path.isAbsolute(project_dir)) throw new Error('project_dir must be absolute.');
      if (fs.existsSync(project_dir) && fs.readdirSync(project_dir).length) throw new Error('Choose an empty project directory.');
      const selected = animationStyle(style);
      if (selected.engine !== 'code') throw new Error('Styles 1–3 use the original desktop pipeline. Choose a code style numbered 4 or higher.');
      const brief = validateCreativeBrief({ kind: 'animation', topic, style: selected.id, script, aspect, durationSec: duration_seconds, language, narration, kokoroVoiceId: voice, voiceProvider: 'kokoro', provider: { id: 'hermes' }, details });
      const project = Project.create(project_dir, { brief, style: selected.id, aspect });
      project.manifest.script = script || null; state(project, 'draft', 'Ready for the agent-authored script.');
      return get(project_dir);
    },
    get,
    setScript(dir, script) {
      const project = open(dir); busy(project);
      if (typeof script !== 'string' || !script.trim() || script.length > 30000) throw new Error('Script must contain 1–30,000 characters.');
      const release = acquireAnimationLock(project.dir);
      try {
      if (project.manifest.script !== script.trim()) {
        project.manifest.script = script.trim(); project.manifest.brief.script = script.trim();
        project.manifest.voiceover = { source: null, artifact: null }; project.manifest.production = {};
        state(project, 'draft', 'Script saved; prepare narration.');
      }
      return get(dir);
      } finally { release(); }
    },
    prepare(dir) {
      const current = open(dir);
      if (!current.manifest.script) throw new Error('Set the narration script first.');
      busy(current);
      try { timing(current); return { state: 'done', project: get(dir), reused: true }; } catch {}
      return start(dir, 'prepare', async (project, signal, jobId) => {
        const m = project.manifest;
        if (!m.brief.narration) { state(project, 'planning', 'No narration requested; animation uses the target duration.'); return; }
        const candidates = [process.env.VIDMYO_VENV_PYTHON, '/Volumes/My Lexar/AI Projects/Faceless YT 1/pipeline/.venv/bin/python'];
        const p = pipeline || new DoodlePipeline({ venvPython: candidates.find(file => file && fs.existsSync(file)) });
        if (!p.readiness().ok) throw new Error('Local Kokoro is not installed. Configure local voice tools in Vidmyo first; MCP does not download models automatically.');
        const execute = async (cmd, args) => { await runGovernedProcess({ jobId: jobId + '_' + crypto.randomBytes(3).toString('hex'), resourceClass: 'heavy', governor: jobs().governor, cmd, args, signal, cwd: project.dir, timeoutMs: 1800000 }); return { stdout: '', stderr: '' }; };
        p.exec = execute;
        const voiceFile = path.join(project.dir, 'voiceover.wav');
        if (m.production.preparedScript !== stamp(m.script) || !fs.existsSync(voiceFile)) {
          state(project, 'voiceover', 'Creating local Kokoro narration');
          const scriptFile = path.join(project.dir, 'script.txt'); fs.writeFileSync(scriptFile, m.script);
          await p.tts(scriptFile, voiceFile, { voice: m.brief.kokoroVoiceId });
          signal.throwIfAborted();
          m.voiceover = { source: 'kokoro', artifact: 'voiceover.wav', voiceId: m.brief.kokoroVoiceId };
          m.production.preparedScript = stamp(m.script); project.save();
        }
        state(project, 'planning', 'Measuring narration beats');
        await p.detectBeats(voiceFile, path.join(project.dir, 'beats.json'), { minLen: 3, maxLen: 12 });
        signal.throwIfAborted(); state(project, 'planning', 'Narration ready; author the animation code.');
      });
    },
    codeTask(dir) { const p = open(dir); busy(p); return codeAnimationTask(p.manifest.brief, { ...timing(p), script: p.manifest.script }); },
    submitCode(dir, value) {
      const project = open(dir); busy(project); const code = validateCodeAnimation(value);
      const release = acquireAnimationLock(project.dir);
      try {
      const task = codeAnimationTask(project.manifest.brief, { ...timing(project), script: project.manifest.script });
      atomic(path.join(project.dir, 'artifacts', 'code-animation.json'), code);
      project.manifest.production.codeFingerprint = creativeFingerprint(task);
      project.manifest.production.output = null;
      state(project, 'planning', 'Code saved; ready to render.'); return get(dir);
      } finally { release(); }
    },
    render(dir) {
      const p = open(dir); timing(p);
      busy(p);
      if (!p.manifest.production.codeFingerprint) throw new Error('Submit animation code before rendering.');
      if (p.manifest.production.state === 'done' && p.manifest.production.output && fs.existsSync(path.join(p.dir, p.manifest.production.output))) return { state: 'done', project: get(dir), reused: true };
      return start(dir, 'render', async (project, signal, jobId) => {
        await produceCodeAnimation({ project, ...timing(project), signal, renderer: renderImpl,
          direct: async () => { throw new Error('Code is stale. Read animations_code_task and submit updated code.'); },
          setState: (s, message) => state(project, s, message),
          run: (cmd, args) => runGovernedProcess({ jobId, resourceClass: 'heavy', governor: jobs().governor, cmd, args, signal, cwd: repo, timeoutMs: 3600000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }) });
      });
    },
    job(id) {
      let job = jobs().get(id); if (!job || !job.type.startsWith('animation-')) throw new Error('Animation job not found.');
      if (['queued','running'].includes(job.state) && job.params.ownerPid) {
        let dead=false; try { process.kill(job.params.ownerPid,0); } catch(error) { dead=error.code==='ESRCH'; }
        if(dead){job=jobs().setState(id,'error',{error:'Animation process stopped. Completed stages are preserved; prepare or render this project again.'});const p=open(job.params.projectDir);state(p,'interrupted',job.error);}
      }
      return { job_id: id, state: job.state, error: job.error, project_dir: job.params.projectDir, project: get(job.params.projectDir) };
    },
    cancel(id) { const job = jobs().get(id); if (!job || !job.type.startsWith('animation-')) throw new Error('Animation job not found.'); if (!['queued','running'].includes(job.state)) return { job_id: id, state: job.state }; const current = active.get(job.params.projectDir); if (current?.jobId !== id) throw new Error('Stop this job from the Vidmyo interface that started it.'); current.controller.abort(); jobs().cancel(id); return { job_id: id, state: jobs().get(id).state }; },
  };
}
