// Doodle pipeline runner — spawns the vendored deterministic scripts
// (pipelines/doodle/scripts/) as child processes. Core stays the orchestrator;
// the Python/ffmpeg layer stays the proven executor.
//
// The exec implementation is injectable for tests. Real use goes through
// node:child_process execFile with output capture; failures throw with the
// stderr tail so job logs say what actually broke.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SCRIPTS_DIR = fileURLToPath(new URL('../pipelines/doodle/scripts/', import.meta.url));

function defaultExec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).slice(-2000);
        reject(new Error(`${path.basename(cmd)} ${args[0] || ''} failed: ${tail}`));
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

export class DoodlePipeline {
  constructor({
    scriptsDir = DEFAULT_SCRIPTS_DIR,
    venvPython = null,
    ffmpeg = 'ffmpeg',
    execImpl = defaultExec,
  } = {}) {
    this.scriptsDir = scriptsDir.replace(/\/$/, '');
    this.venvPython = venvPython || path.join(this.scriptsDir, '.venv', 'bin', 'python');
    this.ffmpeg = ffmpeg;
    this.exec = execImpl;
  }

  _script(name) {
    return path.join(this.scriptsDir, name);
  }

  // What's installed vs missing — feeds `vidmyo doctor`. Never installs.
  readiness() {
    const missing = [];
    if (!fs.existsSync(this.venvPython)) missing.push('python venv (run setupEnv — downloads torch/Kokoro/whisper, multi-hundred-MB)');
    for (const s of ['tts_kokoro.py', 'detect_beats.py', 'assemble.py', 'finalize_video.sh']) {
      if (!fs.existsSync(this._script(s))) missing.push(`pipeline script ${s}`);
    }
    return { ok: missing.length === 0, missing };
  }

  // One-time env build. Caller owns consent + progress UI (large downloads).
  async setupEnv() {
    return this.exec('bash', [this._script('setup_env.sh')]);
  }

  async tts(scriptFile, outWav, { voice = 'am_onyx', speed = null } = {}) {
    const args = [this._script('tts_kokoro.py'), scriptFile, outWav, '--voice', voice];
    if (speed != null) args.push('--speed', String(speed));
    await this.exec(this.venvPython, args);
    if (!fs.existsSync(outWav)) throw new Error(`tts produced no file: ${outWav}`);
    return outWav;
  }

  async detectBeats(wav, outJson, { pauseGap = null, maxLen = null, minLen = null, model = null } = {}) {
    const args = [this._script('detect_beats.py'), wav, outJson];
    if (pauseGap != null) args.push('--pause-gap', String(pauseGap));
    if (maxLen != null) args.push('--max-len', String(maxLen));
    if (minLen != null) args.push('--min-len', String(minLen));
    if (model) args.push('--model', model);
    await this.exec(this.venvPython, args);
    if (!fs.existsSync(outJson)) throw new Error(`beat detection produced no file: ${outJson}`);
    return JSON.parse(fs.readFileSync(outJson, 'utf8'));
  }

  async assemble(videoDir, { fps = null, zoom = null, ext = null } = {}) {
    const args = [this._script('assemble.py'), videoDir];
    if (fps != null) args.push('--fps', String(fps));
    if (zoom != null) args.push('--zoom', String(zoom));
    if (ext) args.push('--ext', ext);
    const res = await this.exec(this.venvPython, args);
    const out = path.join(videoDir, 'output.mp4');
    if (!fs.existsSync(out)) throw new Error('assemble reported success but output.mp4 is missing');
    // assemble.py prints white-frame warnings — surface them to the caller.
    const warning = /WARNING: .*no image.*$/m.exec(res.stdout)?.[0] || null;
    return { path: out, warning };
  }

  async finalize(inMp4, outMp4, { no4k = false } = {}) {
    await this.exec('bash', [this._script('finalize_video.sh'), inMp4, outMp4], {
      env: { ...process.env, ...(no4k ? { NO4K: '1' } : {}) },
    });
    if (!fs.existsSync(outMp4)) throw new Error(`finalize produced no file: ${outMp4}`);
    return outMp4;
  }
}
