// Phase 3, item 4 (real) — EDG → HyperFrames renders, measured against the
// FFmpeg path of the SAME EDG, plus a cancel test that proves the whole
// process tree dies.
//
// Thresholds were written into docs/plans/vidmyo-v2.6/PLAN.md BEFORE measuring:
//   enforced   : same canvas, 30 fps, h264 + aac 48000 Hz,
//                duration within 1 frame + 0.02 s, frame count within 1,
//                no frozen frames (freezedetect),
//                PSNR >= 20 dB AND SSIM >= 0.85 against the FFmpeg render.
//   reported   : SSIM >= 0.97 and PSNR >= 35 dB (the WS-3 reference targets).
//
// Nothing is downloaded, no binary is bundled, no network is used. MP4s are
// deleted at the end; only the JSON metrics survive.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { createEdgTimeline } from '../src/edg.js';
import { RendererAdapter, RENDERER_TYPES, resolveFfmpegBinary, resolveFfprobeBinary } from '../src/rendererAdapter.js';
import { ResourceGovernor } from '../src/governor.js';
import * as core from '../index.js';

const require = createRequire(import.meta.url);
const { createPromoBridge } = require('../../../electron/lib/promoBridge.js');

const ffmpegBin = resolveFfmpegBinary();
const ffprobeBin = resolveFfprobeBinary();
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const EVIDENCE_PATH = path.join(REPO_ROOT, '.tmp', 'vidmyo-v2.6', 'hf-edg-render-evidence.json');

const THRESHOLDS = {
  psnrDbMin: 20,
  ssimMin: 0.85,
  durationDiffSecMax: 1 / 30 + 0.02,
  frameDiffMax: 1,
  audioSampleRate: '48000',
  reportedOnly: { ssimMin: 0.97, psnrDbMin: 35 },
};

const ASPECTS = [
  { aspect: '16:9', w: 1280, h: 720 },
  { aspect: '9:16', w: 720, h: 1280 },
  { aspect: '1:1', w: 960, h: 960 },
];

const evidence = {
  recordedAt: new Date().toISOString(),
  thresholds: THRESHOLDS,
  thresholdsWrittenIn: 'docs/plans/vidmyo-v2.6/PLAN.md (before measurement)',
  aspects: {},
  cancel: null,
};

function writeEvidence() {
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
}
after(() => writeEvidence());

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', command: [cmd, ...args].join(' ') };
}

function probe(file) {
  const r = run(ffprobeBin, ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,nb_read_frames',
    '-show_entries', 'format=duration', '-of', 'json', file]);
  assert.equal(r.status, 0, `ffprobe failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function measurePsnrSsim(a, b) {
  const psnr = run(ffmpegBin, ['-i', a, '-i', b, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-']);
  const ssim = run(ffmpegBin, ['-i', a, '-i', b, '-lavfi', '[0:v][1:v]ssim', '-f', 'null', '-']);
  return {
    psnrAvg: (/average:([\d.]+|inf)/.exec(psnr.stderr) || [])[1] ?? null,
    ssimAll: (/All:([\d.]+|inf)/.exec(ssim.stderr) || [])[1] ?? null,
    exitCodes: [psnr.status, ssim.status],
  };
}

function frozenSeconds(file) {
  const r = run(ffmpegBin, ['-v', 'info', '-i', file, '-vf', 'freezedetect=d=1:n=-60dB', '-f', 'null', '-']);
  const matches = [...r.stderr.matchAll(/freeze_duration:\s*([\d.]+)/g)];
  return matches.reduce((sum, m) => sum + Number(m[1]), 0);
}

function generateSource(dir, w, h) {
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, 'source.mp4');
  // The FFmpeg legacy (single-scene) path maps `0:a?` — the video input must
  // therefore carry the audio track for both pipelines to produce aac 48 kHz.
  const r = run(ffmpegBin, ['-y', '-v', 'error', '-f', 'lavfi',
    `-i`, `gradients=s=${w}x${h}:speed=1:rate=30:duration=4`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-shortest', video]);
  assert.equal(r.status, 0, `source video gen failed: ${r.stderr}`);
  return { video, audio: video };
}

function buildEdg({ w, h, aspect, video, audio }) {
  const fps = 30;
  const total = 120; // 4 s — every aspect stays at or under the 4 s budget
  const edg = createEdgTimeline({
    title: `Vidmyo EDG→HyperFrames ${aspect}`,
    aspect,
    fps,
    canvas: { width: w, height: h, aspect },
    assets: {
      v: { id: 'v', path: video, hash: sha256(video), type: 'video', durationSec: 4 },
      a: { id: 'a', path: audio, hash: sha256(audio), type: 'audio', durationSec: 4 },
    },
    tracks: [
      { id: 'video-primary', type: 'video', name: 'Video', clips: [
        { id: 'c1', assetId: 'v', timelineStartFrame: 0, timelineEndFrame: total, sourceStartFrame: 0, sourceEndFrame: total },
      ] },
      { id: 'audio-voice', type: 'audio', name: 'Voice', clips: [
        { id: 'a1', assetId: 'a', timelineStartFrame: 0, timelineEndFrame: total, volume: 0.5 },
      ] },
      { id: 'captions-main', type: 'caption', name: 'Captions', clips: [
        { id: 'cap1', text: `HyperFrames ${aspect}`, timelineStartFrame: 6, timelineEndFrame: 66 },
        { id: 'cap2', text: 'measured against FFmpeg', timelineStartFrame: 78, timelineEndFrame: 114 },
      ] },
    ],
    transitions: [],
  });
  edg.totalTimelineFrames = total;
  return edg;
}

test('EDG → HyperFrames renders real MP4s at 16:9, 9:16 and 1:1, within pre-registered thresholds vs FFmpeg', { timeout: 900000 }, async () => {
  const root = tempDir('vidmyo-hf-edg-render-');
  const adapter = new RendererAdapter();
  try {
    for (const fmt of ASPECTS) {
      const tag = fmt.aspect.replace(':', 'x');
      const src = generateSource(path.join(root, `src_${tag}`), fmt.w, fmt.h);
      const edg = buildEdg({ ...fmt, ...src });

      const hfOut = path.join(root, `hf_${tag}.mp4`);
      const ffOut = path.join(root, `ff_${tag}.mp4`);

      const hfStart = Date.now();
      // Review R3: a caller-supplied projectDir is caller-owned and must
      // survive `keepProject: false`; only a directory this call created
      // itself may be removed.
      const callerProjectDir = fmt.aspect === '16:9' ? path.join(root, `caller_proj_${tag}`) : null;
      const hfRes = await adapter.renderExport(edg, hfOut, {
        renderer: RENDERER_TYPES.HYPERFRAMES,
        execute: true,
        keepProject: false,
        ...(callerProjectDir ? { projectDir: callerProjectDir } : {}),
      });
      const hfMs = Date.now() - hfStart;
      assert.equal(hfRes.status, 'done', hfRes.note);
      assert.equal(hfRes.engine, 'hyperframes');
      assert.equal(hfRes.version, '0.8.72');
      assert.deepEqual(hfRes.unsupported, [], 'this EDG must convert with no unsupported features');

      if (callerProjectDir) {
        assert.equal(hfRes.conversion.projectDir, path.resolve(callerProjectDir));
        assert.ok(
          fs.existsSync(path.join(callerProjectDir, 'index.html')),
          'caller-supplied projectDir must never be deleted by renderExport',
        );
      } else {
        assert.ok(
          !fs.existsSync(path.join(root, `.hf_${tag}.mp4.hfproj`)),
          'self-created project dir is removed when keepProject is false',
        );
      }

      const ffStart = Date.now();
      const ffRes = await adapter.renderExport(edg, ffOut, {
        renderer: RENDERER_TYPES.FFMPEG,
        execute: true,
      });
      const ffMs = Date.now() - ffStart;
      assert.equal(ffRes.status, 'done');

      const hfProbe = probe(hfOut);
      const ffProbe = probe(ffOut);
      const hfV = hfProbe.streams.find((s) => s.codec_type === 'video');
      const hfA = hfProbe.streams.find((s) => s.codec_type === 'audio');
      const ffV = ffProbe.streams.find((s) => s.codec_type === 'video');
      const ffA = ffProbe.streams.find((s) => s.codec_type === 'audio');

      // ── structural (enforced) ────────────────────────────────────────────
      for (const [label, v, a] of [['hyperframes', hfV, hfA], ['ffmpeg', ffV, ffA]]) {
        assert.equal(v.width, fmt.w, `${label} width`);
        assert.equal(v.height, fmt.h, `${label} height`);
        assert.equal(v.codec_name, 'h264', `${label} codec`);
        assert.equal(v.r_frame_rate, '30/1', `${label} fps`);
        assert.ok(a, `${label} must have an audio stream`);
        assert.equal(a.codec_name, 'aac', `${label} audio codec`);
        assert.equal(a.sample_rate, THRESHOLDS.audioSampleRate, `${label} sample rate`);
      }
      assert.equal(hfV.width, ffV.width);
      assert.equal(hfV.height, ffV.height);

      const hfDur = Number(hfProbe.format.duration);
      const ffDur = Number(ffProbe.format.duration);
      const durDiff = Math.abs(hfDur - ffDur);
      assert.ok(durDiff <= THRESHOLDS.durationDiffSecMax,
        `duration diff ${durDiff}s exceeds ${THRESHOLDS.durationDiffSecMax}s (hf=${hfDur} ff=${ffDur})`);

      const hfFrames = Number(hfV.nb_read_frames);
      const ffFrames = Number(ffV.nb_read_frames);
      const frameDiff = Math.abs(hfFrames - ffFrames);
      assert.ok(frameDiff <= THRESHOLDS.frameDiffMax,
        `frame count diff ${frameDiff} exceeds ${THRESHOLDS.frameDiffMax}`);

      const hfFrozen = frozenSeconds(hfOut);
      const ffFrozen = frozenSeconds(ffOut);
      assert.equal(hfFrozen, 0, `hyperframes output has ${hfFrozen}s of frozen video`);
      assert.equal(ffFrozen, 0, `ffmpeg output has ${ffFrozen}s of frozen video`);

      // ── similarity (enforced) ────────────────────────────────────────────
      const sim = measurePsnrSsim(hfOut, ffOut);
      const psnr = Number(sim.psnrAvg);
      const ssim = Number(sim.ssimAll);
      assert.ok(Number.isFinite(psnr) && psnr >= THRESHOLDS.psnrDbMin,
        `PSNR ${sim.psnrAvg} dB below the pre-registered ${THRESHOLDS.psnrDbMin} dB`);
      assert.ok(Number.isFinite(ssim) && ssim >= THRESHOLDS.ssimMin,
        `SSIM ${sim.ssimAll} below the pre-registered ${THRESHOLDS.ssimMin}`);

      evidence.aspects[fmt.aspect] = {
        width: fmt.w,
        height: fmt.h,
        hyperframes: { ms: hfMs, bytes: fs.statSync(hfOut).size, durationSec: hfDur, frames: hfFrames, frozenSec: hfFrozen, version: hfRes.hyperframes.version, license: hfRes.hyperframes.license },
        ffmpeg: { ms: ffMs, bytes: fs.statSync(ffOut).size, durationSec: ffDur, frames: ffFrames, frozenSec: ffFrozen, captionMode: ffRes.captions?.renderMode || null },
        durationDiffSec: durDiff,
        frameDiff,
        psnrDb: psnr,
        ssimAll: ssim,
        meetsReportedTargets: { psnr35: psnr >= THRESHOLDS.reportedOnly.psnrDbMin, ssim097: ssim >= THRESHOLDS.reportedOnly.ssimMin },
        unsupported: hfRes.unsupported,
        conversion: { totalFrames: hfRes.conversion.totalFrames, durationSec: hfRes.conversion.durationSec, elementCount: hfRes.conversion.elementCount },
        commands: { psnr: sim.exitCodes[0], ssim: sim.exitCodes[1] },
      };
      writeEvidence();

      fs.rmSync(hfOut, { force: true });
      fs.rmSync(ffOut, { force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function listProcesses() {
  const r = spawnSync('ps', ['-ww', '-axo', 'pid=,pgid=,ppid=,command='], { encoding: 'utf8' });
  return String(r.stdout || '').split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), pgid: Number(m[2]), ppid: Number(m[3]), command: m[4] } : null;
  }).filter(Boolean);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate, timeoutMs = 20000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

test('cancel mid-HyperFrames-render ends the job cancelled, kills the whole tree and frees the governor slot', { timeout: 300000 }, async () => {
  const handlers = new Map();
  const home = tempDir('vidmyo-hf-cancel-');
  const userDataDir = path.join(home, 'user-data');
  const jobsDir = path.join(userDataDir, 'jobs');
  const exportsDir = path.join(userDataDir, 'exports');
  const governorDir = path.join(home, 'governor');
  const isolatedCore = { ...core, defaultGovernorDir: () => governorDir };
  const bridge = createPromoBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    core: async () => isolatedCore,
    userDataDir, jobsDir, exportsDir, governorDir,
  });
  bridge.register();
  const store = new core.JobStore(jobsDir, { governorDir });

  const src = generateSource(path.join(home, 'src'), 480, 270);
  const edg = buildEdg({ w: 480, h: 270, aspect: '16:9', ...src });
  const render = handlers.get('promo:render-export');
  const cancel = handlers.get('promo:cancel-render-export');
  assert.ok(render);
  assert.ok(cancel);

  const jobId = `job_hf_cancel_${Date.now()}`;
  const renderPromise = render({ jobId }, { edg, outputPath: null, renderer: 'hyperframes' });

  // Wait until the pinned HyperFrames CLI (and its Chrome children) run.
  const spawned = await waitFor(() => listProcesses().some((p) => p.command.includes(exportsDir)), 30000);
  assert.ok(spawned, 'HyperFrames render process must appear');

  const rootProc = listProcesses().find((p) => p.command.includes(exportsDir));
  assert.ok(rootProc, 'the HyperFrames render root process must be visible');
  const pgid = rootProc.pgid;

  // Everything that belongs to this render: the whole process group (this is
  // what `pgrep -g <pgid>` returns), direct children (Chrome is spawned as a
  // child of the CLI) and anything whose command line carries our export dir.
  const inTree = (p, root) => p.pgid === pgid || p.ppid === root.pid || p.command.includes(exportsDir);

  // Wait for a live, real descendant (Chrome/FFmpeg). The CLI first runs short-lived helpers that exit within
  // milliseconds and show up in `ps` as "(node)"; cancelling at that point would not exercise the tree kill.
  // Render descendants (helpers, Chrome, FFmpeg) come and go during a render, so record every real one seen.
  const isRealLiveDescendant = (p, root) => inTree(p, root) && p.pid !== root.pid && !p.command.startsWith('(') && alive(p.pid);
  const seenDescendants = new Map();
  const descendantUp = await waitFor(() => {
    const root = listProcesses().find((p) => p.command.includes(exportsDir)) || rootProc;
    for (const p of listProcesses()) if (isRealLiveDescendant(p, root)) seenDescendants.set(p.pid, p);
    return seenDescendants.size > 0;
  }, 30000);
  assert.ok(descendantUp, 'a Chromium/HyperFrames/FFmpeg descendant must be running before cancel');

  const rootNow = listProcesses().find((p) => p.command.includes(exportsDir)) || rootProc;
  // Precondition: the render is still running and a real descendant was observed. The kill itself is proven
  // below: every process seen in the tree must be gone and nothing may remain in the render's process group.
  const tree = [rootNow, ...seenDescendants.values(), ...listProcesses().filter((p) => inTree(p, rootNow) && !p.command.startsWith('(') && alive(p.pid))];
  const pids = [...new Set(tree.map((p) => p.pid))];
  const descendantCommands = [...seenDescendants.values()].map((p) => p.command.split(' ').slice(0, 4).join(' '));
  assert.ok(alive(rootNow.pid), 'render root must be running before cancel');
  assert.ok(seenDescendants.size >= 1, 'a real Chromium/HyperFrames/FFmpeg descendant must have run before cancel');

  const cancelRes = await cancel(null, jobId);
  assert.equal(cancelRes.ok, true, cancelRes.error);
  assert.equal(cancelRes.cancelled, true);

  const result = await renderPromise;
  assert.equal(result.ok, false, `render must not report success after cancel: ${JSON.stringify(result)}`);
  assert.equal(result.cancelled, true, `render must report cancellation: ${JSON.stringify(result)}`);
  assert.equal(result.jobId, jobId);

  const dead = await waitFor(() => pids.every((pid) => !alive(pid)), 8000);
  assert.ok(dead, `render pids must be ESRCH within 8s: ${pids.filter(alive).join(', ')}`);

  const survivors = listProcesses().filter((p) => p.pgid === pgid || p.command.includes(exportsDir));
  assert.deepEqual(survivors.map((s) => ({ pid: s.pid, command: s.command.slice(0, 120) })), [],
    'no Chromium/HyperFrames descendant may survive (`pgrep -g <pgid>` must be empty)');

  const finalJob = store.get(jobId);
  assert.equal(finalJob.state, 'cancelled', 'job must end as cancelled');
  assert.equal(finalJob.checkpoints?.leaseToken, null, 'governor lease token must be cleared');
  assert.equal(store.governor.getActiveLeases().length, 0, 'governor must hold no lease');
  assert.equal(fs.readdirSync(path.join(governorDir, 'leases')).length, 0, 'leases directory empty');

  // The heavy slot is free immediately: a second render is admitted.
  const before = Date.now();
  const second = await render(null, { edg, outputPath: null, renderer: 'ffmpeg' });
  const admissionMs = Date.now() - before;
  assert.equal(second.ok, true, second.error);
  assert.equal(second.renderer, 'ffmpeg');

  evidence.cancel = {
    pids,
    pgid,
    descendantCommands,
    jobState: finalJob.state,
    leasesAfter: store.governor.getActiveLeases().length,
    secondRenderer: second.renderer,
    secondAdmissionMs: admissionMs,
    survivors: survivors.length,
  };
  writeEvidence();

  fs.rmSync(home, { recursive: true, force: true });
});
