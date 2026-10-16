import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Project } from '../index.js';

const require = createRequire(import.meta.url);
const { createCreativeBridge } = require('../../../electron/lib/creativeBridge.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const brief = (overrides = {}) => ({
  kind: 'animation', style: 'documentary-map', topic: 'Routes across Europe', details: 'Fixture',
  aspect: '16:9', durationSec: 5, language: 'English',
  provider: { id: 'codex', model: 'configured-default' },
  narration: false, voiceProvider: 'kokoro', reviewScript: true, reviewVoiceover: false,
  imageSource: '', imageModel: '', script: '', ...overrides,
});

function harness({ renderVideo, makePipeline, director, approval = 0, secret = null, generateImage, voiceboxStatus, flowFiles = null, trackerSavePath = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-creative-'));
  const userData = path.join(root, 'user-data'); fs.mkdirSync(userData);
  const handlers = new Map();
  let directorCalls = 0; let renderCalls = 0; let imageCalls = 0;
  const bridge = createCreativeBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { isPackaged: false, getPath: () => userData },
    repoRoot,
    BrowserWindow: { getAllWindows: () => [] },
    dialog: {
      showOpenDialog: async ({ title }) => title === 'Choose Curio Flow Queue images' && flowFiles ? ({ canceled: false, filePaths: flowFiles() }) : ({ canceled: true }),
      showSaveDialog: async () => trackerSavePath ? ({ canceled: false, filePath: trackerSavePath }) : ({ canceled: true }),
      showMessageBox: async () => ({ response: approval }),
    },
    agents: { detectAll: async () => [{ id: 'codex', installed: true, authed: true, subscriptionReady: true, path: '/fixture/codex' }] },
    getSecret: () => secret,
    media: { grant: async file => `fixture:${file}`, close() {} },
    renderer: { root, ensure: async () => ({ ok: true }), status: () => ({ binDir: root }) },
    verifyOutput: async () => ({ ok: true }),
    ...(makePipeline ? { makePipeline } : {}),
    ...(voiceboxStatus ? { voiceboxStatus } : {}),
    renderVideo: async (input) => { renderCalls += 1; if(renderVideo)return renderVideo(input); fs.writeFileSync(input.output, 'fixture-video'); return input.output; },
    ...(generateImage ? { generateImage: async input => { imageCalls += 1; return generateImage(input); } } : {}),
    director: async input => {
      directorCalls += 1;
      if (director) return director(input);
      if (input.phase === 'script') return { script: 'A short journey from Warsaw to London.' };
      return { version: 1, scenes: [{
        id: 's001', headline: 'Across Europe', visual: 'A route on a map', durationSec: 5,
        locations: [{ name: 'Warsaw', lat: 52.23, lon: 21.01 }, { name: 'London', lat: 51.51, lon: -0.13 }], layers: [],
      }] };
    },
  });
  bridge.register(); bridge.authorizeRoot(root);
  const invoke = (name, ...args) => handlers.get(`creative:${name}`)(null, ...args);
  return { root, bridge, invoke, calls: () => ({ directorCalls, renderCalls, imageCalls }) };
}

test('creative bridge saves the packaged 21-column Vidmyo Tracker template', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-tracker-output-'));
  const destination = path.join(root, 'tracker.csv');
  const h = harness({ trackerSavePath: destination });
  try {
    const result = await h.invoke('save-tracker-template');
    assert.deepEqual(result, { ok: true, path: destination });
    const [header, example] = fs.readFileSync(destination, 'utf8').trimEnd().split('\n');
    assert.equal(header.split(',').length, 21);
    assert.equal(example.match(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/g)?.length + 1, 21);
  } finally {
    h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('creative project pauses only at selected review, then renders, reopens and stays idempotent', async () => {
  const h = harness();
  try {
    const created = await h.invoke('create', { root: h.root, brief: brief() });
    assert.equal(created.ok, true);
    const review = await h.invoke('start', created.dir);
    assert.equal(review.manifest.production.state, 'review-script');
    assert.equal(review.manifest.script, 'A short journey from Warsaw to London.');
    assert.deepEqual(h.calls(), { directorCalls: 1, renderCalls: 0, imageCalls: 0 });

    const edited = 'An edited journey from Warsaw to London.';
    const saved = await h.invoke('save', created.dir, { ...review.manifest.brief, script: edited });
    assert.equal(saved.manifest.production.state, 'review-script');
    assert.equal(saved.manifest.script, edited);
    const done = await h.invoke('start', created.dir, { approve: true });
    assert.equal(done.manifest.production.state, 'done');
    assert.equal(done.manifest.script, edited);
    assert.equal(done.manifest.renders.at(-1).width, 1920);
    assert.equal(done.manifest.renders.at(-1).frames, 150);
    assert.equal(done.previewUrl.startsWith('fixture:'), true);
    assert.deepEqual(h.calls(), { directorCalls: 2, renderCalls: 1, imageCalls: 0 });

    const reopened = await h.invoke('open', created.dir);
    assert.equal(reopened.manifest.production.state, 'done');
    await h.invoke('start', created.dir);
    assert.deepEqual(h.calls(), { directorCalls: 2, renderCalls: 1, imageCalls: 0 });
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('creative bridge exposes Voicebox profiles and changing the profile clears cached narration', async () => {
  const voices = [{ id: 'voice-a', name: 'Owned narrator' }];
  const h = harness({ voiceboxStatus: async () => ({ ok: true, available: true, voices }) });
  try {
    assert.deepEqual(await h.invoke('voicebox-status'), { ok: true, available: true, voices });
    const created = await h.invoke('create', { root: h.root, brief: brief({
      narration: true, voiceProvider: 'voicebox', voiceboxVoiceId: 'voice-a', script: 'Fixture narration.',
    }) });
    const project = Project.load(created.dir);
    fs.writeFileSync(path.join(created.dir, 'voiceover.wav'), Buffer.alloc(44));
    project.manifest.voiceover = { source: 'voicebox', artifact: 'voiceover.wav', voiceId: 'voice-a' };
    project.manifest.production.voiceFingerprint = 'cached'; project.save();
    const saved = await h.invoke('save', created.dir, { ...created.manifest.brief, voiceboxVoiceId: 'voice-b' });
    assert.equal(saved.manifest.brief.voiceboxVoiceId, 'voice-b');
    assert.equal(saved.manifest.voiceover.artifact, null);
    assert.equal(saved.manifest.production.voiceFingerprint, null);
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('creative cancellation prevents later planning and rendering', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = harness({ director: async ({ phase }) => {
    if (phase === 'script') { await blocked; return { script: 'Cancelled script.' }; }
    throw new Error('planning must not run');
  } });
  try {
    const created = await h.invoke('create', { root: h.root, brief: brief({ reviewScript: false }) });
    const running = h.invoke('start', created.dir);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await h.invoke('cancel', created.dir)).ok, true);
    release();
    const result = await running;
    assert.equal(result.manifest.production.state, 'cancelled');
    assert.equal(h.calls().renderCalls, 0);
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('changing the responsible director invalidates generated writing and downstream work', async () => {
  const h = harness();
  try {
    const created = await h.invoke('create', { root: h.root, brief: brief() });
    const review = await h.invoke('start', created.dir);
    assert.equal(review.manifest.production.state, 'review-script');
    assert.equal(review.manifest.production.scriptOrigin, 'generated');
    const changed = await h.invoke('save', created.dir, {
      ...review.manifest.brief,
      provider: { id: 'openrouter', model: 'openai/gpt-5.1' },
      script: review.manifest.script,
    });
    assert.equal(changed.ok, true);
    assert.equal(changed.manifest.script, null);
    assert.equal(changed.manifest.production.scriptOrigin, null);
    assert.equal(changed.manifest.production.state, 'draft');
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('legacy projects with a finished render reopen with a playable preview', async () => {
  const h = harness();
  try {
    const dir = path.join(h.root, 'legacy-project');
    const project = Project.create(dir, { brief: brief({ reviewScript: false }), style: 'documentary-map', aspect: '16:9' });
    const output = path.join(dir, 'legacy.mp4'); fs.writeFileSync(output, 'legacy-video');
    project.manifest.renders.push({ path: 'legacy.mp4', finalPath: 'legacy.mp4', finalized: true });
    delete project.manifest.production; project.save();
    const opened = await h.invoke('open', dir);
    assert.equal(opened.ok, true);
    assert.equal(opened.manifest.production.state, 'done');
    assert.equal(opened.manifest.production.output, 'legacy.mp4');
    assert.equal(opened.previewUrl, `fixture:${fs.realpathSync(output)}`);
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('layered animation generates isolated assets once and reuses the completed project', async () => {
  const h = harness({
    approval: 1, secret: 'fixture-key',
    director: async ({ phase }) => phase === 'script'
      ? { script: 'A paper rocket takes shape.' }
      : { version: 1, scenes: [{
          id: 's001', headline: 'Ready to launch', visual: 'A layered paper rocket', durationSec: 5,
          locations: [], layers: [
            { kind: 'hero', description: 'A red paper rocket' },
            { kind: 'support', description: 'A separate blue paper cloud' },
          ],
        }] },
    generateImage: ({ project, scene, layer }) => {
      const file = path.join(project.dir, 'images', `${scene.id}-${layer.kind}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture-image');
      return file;
    },
  });
  try {
    const created = await h.invoke('create', { root: h.root, brief: brief({
      style: 'paper-stop-motion', reviewScript: false, imageSource: 'fal', imageModel: 'fal-ai/flux/dev',
    }) });
    const done = await h.invoke('start', created.dir);
    assert.equal(done.manifest.production.state, 'done');
    const plan = JSON.parse(fs.readFileSync(path.join(created.dir, 'artifacts', 'animation-plan.json')));
    assert.equal(plan.scenes[0].layers.length, 2);
    assert(plan.scenes[0].layers.every(layer => layer.asset && layer.assetFingerprint));
    assert.deepEqual(h.calls(), { directorCalls: 2, renderCalls: 1, imageCalls: 2 });
    await h.invoke('start', created.dir);
    assert.deepEqual(h.calls(), { directorCalls: 2, renderCalls: 1, imageCalls: 2 });
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('Story Flow hands off an exact queue, imports sNNN downloads, then resumes render', async () => {
  let h;
  h = harness({ flowFiles: () => [path.join(h.root, 'downloads')] });
  try {
    const created = await h.invoke('create', { root: h.root, brief: brief({
      kind: 'story', style: 'doodle-v1', topic: 'Night sky', narration: false,
      reviewScript: false, imageSource: 'flow', imageModel: '',
    }) });
    const paused = await h.invoke('start', created.dir);
    assert.equal(paused.manifest.production.state, 'flow-images');
    const queuePath = path.join(created.dir, 'artifacts', 'flow-image-queue.json');
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    assert.equal(queue.schemaVersion, 1);
    assert.equal(queue.outputDirectory, 'downloads');
    assert.equal(queue.downloadSubdirectory, 'images');
    assert.deepEqual(queue.scenes.map(scene => scene.sceneId), ['s001']);
    assert.equal(queue.scenes[0].kind, 'image');
    assert.equal(queue.scenes[0].expectedAspectRatio, '16:9');
    const downloaded = path.join(h.root, 'downloads', queue.projectId, 'images');
    fs.mkdirSync(downloaded, { recursive: true });
    fs.writeFileSync(path.join(downloaded, 's001.png'), 'fixture-flow-image');
    const imported = await h.invoke('import-flow-images', created.dir);
    assert.equal(imported.ok, true);
    assert.equal(imported.manifest.production.state, 'flow-images');
    assert.equal(imported.manifest.production.assetsDone, true);
    assert.match(imported.manifest.production.message, /Continue to render/);
    const done = await h.invoke('start', created.dir);
    assert.equal(done.manifest.production.state, 'done');
    assert.equal(h.calls().imageCalls, 0, 'Flow never calls a cloud image adapter');
    assert.equal(h.calls().renderCalls, 1);
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});


test('Kokoro selection reaches TTS, persists, and changing it invalidates narration', async () => {
  const calls = [];
  const h = harness({ makePipeline: async () => ({
    readiness: () => ({ ok: true }),
    tts: async (_script, output, options) => { calls.push(options); fs.writeFileSync(output, Buffer.alloc(44)); },
  }) });
  try {
    const created = await h.invoke('create', { root: h.root, brief: brief({
      kind: 'story', narration: true, kokoroVoiceId: 'bm_george', script: 'Fixture narration.',
      reviewScript: false, reviewVoiceover: true,
    }) });
    await h.invoke('start', created.dir);
    const project = Project.load(created.dir);
    assert.deepEqual(calls, [{ voice: 'bm_george', lang: 'b' }]);
    assert.equal(project.manifest.brief.kokoroVoiceId, 'bm_george');
    assert.equal(project.manifest.voiceover.voiceId, 'bm_george');
    const saved = await h.invoke('save', created.dir, { ...project.manifest.brief, kokoroVoiceId: 'af_heart' });
    assert.equal(saved.manifest.brief.kokoroVoiceId, 'af_heart');
    assert.equal(saved.manifest.voiceover.artifact, null);
    assert.equal(saved.manifest.production.voiceFingerprint, null);
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});


test('animated Stickman uses background-only Flow images, carries rigs to render and invalidates on mode change', async () => {
  let h;
  let rendered;
  const characters=[{id:'host',x:.5,endX:.5,y:.8,scale:.35,action:'wave',expression:'happy',facing:'right',shirt:'blue',skin:'paper'}];
  h=harness({
    flowFiles:()=>[path.join(h.root,'downloads')],
    director:async ({phase})=>phase==='script'?{script:'A room comes to life.'}:{scenes:[{
      id:'s001',headline:'Hello',visual:'An empty living room',durationSec:5,locations:[],layers:[],characters,
    }]},
    renderVideo:async ({props,output})=>{rendered=props;fs.writeFileSync(output,'fixture');return output;},
  });
  try {
    const created=await h.invoke('create',{root:h.root,brief:brief({kind:'story',characterAnimation:'animated',reviewScript:false,imageSource:'flow'})});
    const paused=await h.invoke('start',created.dir);
    assert.equal(paused.manifest.production.state,'flow-images');
    const queue=JSON.parse(fs.readFileSync(path.join(created.dir,'artifacts','flow-image-queue.json')));
    assert.match(queue.scenes[0].prompt,/BACKGROUND ONLY/);
    const downloaded=path.join(h.root,'downloads',queue.projectId,'images');fs.mkdirSync(downloaded,{recursive:true});
    fs.writeFileSync(path.join(downloaded,'s001.png'),'fixture');
    await h.invoke('import-flow-images',created.dir);
    const done=await h.invoke('start',created.dir);
    assert.equal(done.manifest.production.state,'done');
    assert.equal(rendered.characterAnimation,'animated');
    assert.equal(rendered.scenes[0].characters[0].action,'wave');
    assert.equal((await h.invoke('open',created.dir)).manifest.brief.characterAnimation,'animated');
    const changed=await h.invoke('save',created.dir,{...done.manifest.brief,characterAnimation:'static'});
    assert.equal(changed.manifest.production.output,null);
    assert.equal(changed.manifest.production.planFingerprint,null);
    assert.equal(fs.existsSync(path.join(created.dir,'artifacts','animation-plan.json')),false);
  } finally {h.bridge.stop();fs.rmSync(h.root,{recursive:true,force:true});}
});

test('Codex Images needs no API key and switching to Flow preserves the script and scene plan', async () => {
  const h=harness({approval:1,generateImage:async({project})=>{const file=path.join(project.dir,'image.png');fs.writeFileSync(file,'fixture');return file;}});
  try{
    const created=await h.invoke('create',{root:h.root,brief:brief({kind:'story',style:'doodle-v1',reviewScript:false,imageSource:'codex-images',imageModel:'gpt-image-2'})});
    const done=await h.invoke('start',created.dir);
    assert.equal(done.manifest.production.state,'done');
    const calls=h.calls().directorCalls;
    await h.invoke('save',created.dir,{...done.manifest.brief,imageSource:'flow',imageModel:''});
    const flow=await h.invoke('start',created.dir);
    assert.equal(flow.manifest.production.state,'flow-images');
    assert.equal(flow.manifest.script,done.manifest.script);
    assert.equal(h.calls().directorCalls,calls);
    assert.equal(h.calls().imageCalls,1);
  }finally{h.bridge.stop();fs.rmSync(h.root,{recursive:true,force:true});}
});
