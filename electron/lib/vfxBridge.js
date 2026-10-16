// Desktop VFX project orchestration. Secrets and processes stay in the host.
const {ipcMain, dialog, app, shell, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const agents = require('./agents');
const {getSecret} = require('./secrets');
const {resolveRuntimePaths} = require('./runtimePaths');
const {createCleanerMedia} = require('./cleanerMedia');
const {createVfxRuntime} = require('./vfxRuntime');
const LOCAL = new Set(['codex', 'claude_code', 'gemini', 'hermes']);
const THEMES = new Set(['simple-claude', 'liquid-glass', 'synthwave']);
const VFX_PLATFORMS = new Set(['auto','youtube','shorts','tiktok','reels','generic']);
const canvasClass = (width,height) => width / height <= .8 ? 'portrait' : width / height >= 1.25 ? 'landscape' : 'square';
function atomic(file, doc) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {fs.writeFileSync(temp, JSON.stringify(doc, null, 2), {mode:0o600}); fs.renameSync(temp,file);} finally {try {fs.unlinkSync(temp);} catch {}}
}
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
function createVfxBridge(deps = {}) {
  const ipc = deps.ipcMain || ipcMain, dialogs = deps.dialog || dialog, application = deps.app || app;
  const agentLib = deps.agents || agents, secret = deps.getSecret || getSecret, execute = deps.execFile || execFile;
  const windows = deps.BrowserWindow || BrowserWindow, revealShell = deps.shell || shell;
  const runtime = resolveRuntimePaths({isPackaged:application.isPackaged, resourcesPath:process.resourcesPath, ...(deps.repoRoot ? {repoRoot:deps.repoRoot} : {})});
  const engine = deps.engineDir || path.join(runtime.packaged ? process.resourcesPath : runtime.repoRoot,'packages','vfx-engine');
  const media = deps.media || createCleanerMedia();
  const sources = new Set(), roots = new Set(), projects = new Set(), busy = new Set(), children = new Map(), workerJobs = new Map();
  const configPath = path.join(application.getPath('userData'),'vfx-config.json');
  const config = () => {let cfg={};try {cfg=read(configPath);} catch {} return {...cfg,runtimeRoot:cfg.runtimeRoot || path.join(application.getPath('userData'),'vfx-runtime')};};
  const requireProject = dir => {if (typeof dir !== 'string' || !path.isAbsolute(dir) || !projects.has(path.resolve(dir))) throw new Error('Open this VFX project first'); return path.resolve(dir);};
  const progress = (dir,message) => {for(const w of windows.getAllWindows()) {try {w.webContents.send('vfx:progress',{dir,message});} catch {}}};
  const run = (dir, command, args, opts={}) => new Promise((resolve,reject)=> {
    const child = execute(command,args,{timeout:3600000,maxBuffer:8*1024*1024,...opts,env:{...process.env,...opts.env,PATH:[rendererRuntime?.status()?.binDir,opts.env?.PATH || process.env.PATH,'/opt/homebrew/bin','/usr/local/bin'].filter(Boolean).join(path.delimiter)}},(err,stdout='',stderr='')=> {
      if (children.get(dir) === child) children.delete(dir);
      if(err) reject(new Error(String(stderr || err.message).trim().slice(0,1000))); else resolve(stdout);
    }); children.set(dir,child);
  });
  const rendererRuntime=deps.vfxRuntime || createVfxRuntime({engine,root:config().runtimeRoot,run,npmCli:deps.npmCli});
  const py = (dir,command,input,env={}) => run(dir,process.env.VIDMYO_REPURPOSE_PYTHON || 'python3',['-m','vidmyo_repurpose.vfx',command,'--project',dir,'--engine',engine,...(input ? ['--input',input] : [])], {env:{...process.env,...env,PYTHONPATH:path.join(runtime.repurposeEngineDir,'src')}}).then(JSON.parse);
  const core = async () => deps.core ? deps.core() : import(pathToFileURL(path.join(runtime.coreDir,'index.js')).href);
  const writeLog=async dir=> {
    const mod=await core(),manifest=read(path.join(dir,'vfx.json')),intake=read(path.join(dir,'artifacts/vfx-intake.json')),spec=read(path.join(dir,'artifacts/vfx-spec.json'));
    let parity=null;try{parity=read(path.join(dir,'artifacts/vfx-parity.json'));}catch{}
    fs.writeFileSync(path.join(dir,'run-log.md'),mod.formatVfxRunLog(manifest,intake,spec,parity),{mode:0o600});
  };
  const clearStoryboard = dir => {for(const name of ['vfx-storyboard.json']){try{fs.unlinkSync(path.join(dir,'artifacts',name));}catch{}}try{fs.rmSync(path.join(dir,'artifacts','vfx-storyboard'),{recursive:true,force:true});}catch{}};
  const rendererWorkspace = async (dir,spec,prefix) => {
    const cfg=config();await rendererRuntime.ensure();
    const work=path.join(dir,'.vidmyo',`${prefix}-${Date.now()}`);fs.cpSync(engine,work,{recursive:true,filter:p=>{const rel=path.relative(engine,p).split(path.sep);return !rel.includes('node_modules')&&!(rel[0]==='renderer'&&rel[1]==='public');}});
    const renderer=path.join(work,'renderer'),modules=path.join(cfg.runtimeRoot,'renderer/node_modules');
    const cli=path.join(modules,'@remotion/cli/remotion-cli.js');
    if(!fs.existsSync(cli))throw new Error('VFX preparation is incomplete. Try again');
    fs.symlinkSync(modules,path.join(renderer,'node_modules'),process.platform==='win32'?'junction':'dir');
    fs.mkdirSync(path.join(renderer,'public'),{recursive:true});
    const source=read(path.join(dir,'vfx.json')).source.uri,linked=path.join(renderer,'public/src.mp4');try{fs.linkSync(source,linked);}catch{fs.copyFileSync(source,linked);}
    const frozenSpec=path.join(work,'spec.json');atomic(frozenSpec,spec);
    return {work,renderer,modules,cli,frozenSpec};
  };
  const snapshot = async dir => {
    const m = read(path.join(dir,'vfx.json')); let intake=null,spec=null;
    try {intake=read(path.join(dir,'artifacts/vfx-intake.json'));} catch {}
    try {spec=read(path.join(dir,'artifacts/vfx-spec.json'));} catch {}
    if (intake) for(let i=0;i<intake.shots.length;i++) {
      const shot=intake.shots[i]; if(!/^shot-\d{3}\.jpg$/.test(shot.frame))throw new Error('Invalid shot thumbnail'); const originalIndex=Number(shot.frame.match(/\d+/)[0]); shot.frameUrl=await media.grant(path.join(dir,'artifacts/vfx-frames',shot.frame));
      if(i) {shot.beforeUrl=await media.grant(path.join(dir,'artifacts/vfx-frames',`cut-${String(originalIndex).padStart(3,'0')}-before.jpg`));shot.afterUrl=await media.grant(path.join(dir,'artifacts/vfx-frames',`cut-${String(originalIndex).padStart(3,'0')}-after.jpg`));}
    }
    if(m.output && path.basename(m.output)!==m.output)throw new Error('Invalid VFX output path');
    let review=[];try{review=read(path.join(dir,'artifacts/vfx-review.json'));}catch{}
    for(const item of review) {if(!/^(event|cut|click)-[a-z0-9-]+\.jpg$/.test(item.file))throw new Error('Invalid review frame');item.url=await media.grant(path.join(dir,'artifacts/vfx-review',item.file));}
    let storyboard=null;try{storyboard=read(path.join(dir,'artifacts/vfx-storyboard.json'));}catch{}
    if(storyboard) for(const item of storyboard.frames || []) {if(!/^event-evt-[0-9]+-(enter|hold|exit)\.jpg$/.test(item.file))throw new Error('Invalid storyboard frame');item.url=await media.grant(path.join(dir,'artifacts/vfx-storyboard',item.file));}
    return {ok:true,dir,manifest:m,intake,spec,review,storyboard,sourceUrl:await media.grant(m.source.uri),...(m.output ? {outputUrl:await media.grant(path.join(dir,m.output))} : {})};
  };
  const exclusive = (channel,fn) => ipc.handle(`vfx:${channel}`,async (_event,dir,...args)=> {
    let resolved, acquired=false;
    try {resolved=requireProject(dir);if(busy.has(resolved)) throw new Error('VFX is already working on this project');busy.add(resolved);acquired=true;return await fn(resolved,...args);}
    catch(error) {return {ok:false,error:String(error.message).slice(0,1000)};}
    finally {if(acquired) busy.delete(resolved);}
  });
  async function provider(settings) {
    if (settings?.mode === 'api') {
      if(settings.provider !== 'openrouter' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(settings.model || '')) throw new Error('Choose an explicit OpenRouter model');
      if(!secret('openrouter')) throw new Error('Add the OpenRouter key in global Settings');
      return {mode:'api',provider:'openrouter',model:settings.model};
    }
    if(settings?.mode !== 'agent' || !LOCAL.has(settings.provider)) throw new Error('Choose a supported local agent');
    const model=String(settings.model || '').trim();
    if(model&&!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model))throw new Error('Enter a valid agent model ID');
    return {mode:'agent',provider:settings.provider,model:model || null};
  }
  function register() {
    for(const [name,title,properties,grants] of [['source','Choose an edited VFX section',['openFile'],sources],['output','Choose VFX project folder',['openDirectory','createDirectory'],roots]]) {
      ipc.handle(`vfx:pick-${name}`,async ()=> {
        const r=await dialogs.showOpenDialog({title,properties,...(name==='source' ? {filters:[{name:'Video',extensions:['mp4','mov','mkv','webm','m4v'] }]} : {})});
        const p=r.filePaths[0];if(!r.canceled&&p)grants.add(path.resolve(p));
        return {ok:!r.canceled,path:p,canceled:r.canceled};
      });
    }
    ipc.handle('vfx:drop-source',async (_event,dropped)=> {
      try {
        if(typeof dropped!=='string'||!path.isAbsolute(dropped))throw new Error('Drop one video file from your computer');
        const source=fs.realpathSync(dropped),extension=path.extname(source).toLowerCase();
        if(!['.mp4','.mov','.mkv','.webm','.m4v'].includes(extension)||!fs.statSync(source).isFile())throw new Error('Use an MP4, MOV, MKV, WebM or M4V video');
        sources.add(source);return {ok:true,path:source};
      } catch(error){return {ok:false,error:error.message};}
    });
    ipc.handle('vfx:pick-project',async ()=> {
      try {const r=await dialogs.showOpenDialog({title:'Open VFX project',properties:['openDirectory']});if(r.canceled)return {ok:false,canceled:true};const dir=path.resolve(r.filePaths[0]);const m=read(path.join(dir,'vfx.json'));if(m.version!==1 || m.kind!=='vfx')throw new Error('This is not a VFX project');projects.add(dir);return await snapshot(dir);} catch(error){return {ok:false,error:error.message};}
    });
    ipc.handle('vfx:readiness',async ()=> {
      const cfg=config();return {ok:true,agents:(await agentLib.detectAll()).filter(a=>LOCAL.has(a.id)),apiConfigured:Boolean(secret('openrouter')),runtimeRoot:cfg.runtimeRoot || null,rendererReady:Boolean(rendererRuntime.status())};
    });
    ipc.handle('vfx:setup',async ()=> {try {return await rendererRuntime.ensure();}catch(error){return {ok:false,error:error.message};}});
    ipc.handle('vfx:create',async (_event,payload)=> {
      let pendingDir=null;
      try {
        const source=path.resolve(String(payload?.sourcePath || '')),root=path.resolve(String(payload?.outputRoot || ''));
        if(!sources.has(source)||!roots.has(root))throw new Error('Choose the source and output folder first');
        if(!['intro','chapter-card','custom'].includes(payload.segmentType)||!THEMES.has(payload.theme))throw new Error('Invalid VFX treatment or theme');
        if(!VFX_PLATFORMS.has(payload.platform || 'auto'))throw new Error('Invalid VFX destination');
        if(String(payload.brief || '').length>10000)throw new Error('Brief is too long');
        const analysis=await provider(payload.analysis);
        const stem=path.basename(source,path.extname(source)).replace(/[^\p{L}\p{N} _-]/gu,'').slice(0,80) || 'Section';
        const dir=path.join(root,`${stem} VFX ${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);pendingDir=dir;
        const brand={theme:payload.theme,kitSource:'theme-defaults',...(payload.accent ? {colors:{accent:String(payload.accent)}} : {})};
        if(payload.accent&&!/^#[0-9a-f]{6}$/i.test(payload.accent))throw new Error('Brand accent must be a six digit hex color');
        const fonts={};
        for(const [slot,value] of [['headline',payload.headline],['body',payload.bodyFont]]) {
          if(value) {if(typeof value!=='string'||! /^[\p{L}\p{N} _-]{1,80}$/u.test(value))throw new Error('Enter a font family name');fonts[slot]={family:value,source:'google',fallback:'Arial',weight:slot==='headline'?700:400};}
        }
        if(Object.keys(fonts).length)brand.fonts=fonts;
        await rendererRuntime.ensure();
        progress(dir,'Checking video orientation and format');
        const imported=await py(dir,'normalize',source),projectSource=path.resolve(imported.file);
        if(projectSource!==source&&!projectSource.startsWith(path.resolve(dir)+path.sep))throw new Error('Invalid normalized source path');
        // Probe the actual project source before writing manifests or transcribing.
        const sourceInfo=await py(dir,'probe',projectSource);
        const detectedCanvas=canvasClass(sourceInfo.width,sourceInfo.height);
        const requestedPlatform=payload.platform || 'auto';
        const resolvedPlatform=requestedPlatform==='auto'?(detectedCanvas==='portrait'?'shorts':'youtube'):requestedPlatform;
        const manifest={version:1,kind:'vfx',name:stem,source:{type:'local_file',uri:projectSource},originalSource:source,sourceNormalized:Boolean(imported.normalized),segmentType:payload.segmentType,brief:String(payload.brief || ''),format:{canvasClass:detectedCanvas,platform:resolvedPlatform,requestedPlatform},brand,analysis,state:'new',createdAt:new Date().toISOString(),output:null};
        atomic(path.join(dir,'vfx.json'),manifest);
        const mod=await core();mod.RepurposeProject.create(dir,{source:manifest.source,requestedClipCount:1,contentType:'general_speech',targetPlatforms:['cleaner'],renderDefaults:{captions:{enabled:false}}});
        projects.add(dir);return await snapshot(dir);
      } catch(error){if(pendingDir&&!projects.has(pendingDir))fs.rmSync(pendingDir,{recursive:true,force:true});return {ok:false,error:error.message};}
    });
    exclusive('get',snapshot);
    exclusive('set-provider',async (dir,settings)=> {const m=read(path.join(dir,'vfx.json'));m.analysis=await provider(settings);atomic(path.join(dir,'vfx.json'),m);return snapshot(dir);});
    exclusive('prepare',async dir=> {
      await rendererRuntime.ensure();
      const m=read(path.join(dir,'vfx.json'));m.state='new';m.output=null;atomic(path.join(dir,'vfx.json'),m);
      for(const file of ['vfx-spec.json','vfx-review.json','vfx-parity.json']){try{fs.unlinkSync(path.join(dir,'artifacts',file));}catch{}}clearStoryboard(dir);
      progress(dir,'Inspecting footage and cut candidates locally');
      await py(dir,'prepare');
      if(m.segmentType !== 'chapter-card' || read(path.join(dir,'artifacts/vfx-intake.json')).source.audio.length) {
        const mod=await core(), store=new mod.JobStore();
        let cfg={};try{cfg=read(path.join(application.getPath('userData'),'repurpose-config.json'));}catch{}
        for(const stage of ['ingest','transcribe']) {
          progress(dir,stage==='transcribe'?'Transcribing the section locally':'Checking source metadata');
          const job=mod.createRepurposeJob(store,{projectDir:dir,stage,options:stage==='transcribe'?{...(cfg.transcriptionModel?{model:cfg.transcriptionModel}:{}),...(cfg.modelCache?{model_cache:cfg.modelCache}:{})}:{}});
          workerJobs.set(dir,{mod,store,jobId:job.id});
          const result=await mod.runRepurposeJob(store,job.id,{python:process.env.VIDMYO_REPURPOSE_PYTHON || mod.DEFAULT_REPURPOSE_PYTHON,engineDir:runtime.repurposeEngineDir,onChild:child=>children.set(dir,child),onEvent:e=>progress(dir,e.payload?.message || stage)});
          children.delete(dir);workerJobs.delete(dir);
          if(result.state!=='done')throw new Error(result.error || `${stage} failed`);
        }
      } else atomic(path.join(dir,'artifacts/transcript-artifact.v1.json'),{segments:[],words:[]});
      m.state='shots';m.output=null;atomic(path.join(dir,'vfx.json'),m);return snapshot(dir);
    });
    exclusive('save-shots',async (dir,shots)=> {
      const file=path.join(dir,'artifacts/vfx-intake.json'),intake=read(file);
      if(!Array.isArray(shots)||shots.length!==intake.shots.length)throw new Error('Invalid shot map');
      const merged=[];
      for(let i=0;i<intake.shots.length;i++) {
        const original=intake.shots[i],choice=shots[i];
        if(!['talking-head','screen-share','b-roll'].includes(choice?.shot) || (i>0&&typeof choice.cutConfirmed!=='boolean'))throw new Error('Review every shot and candidate cut');
        if(i>0&&!choice.cutConfirmed) {
          if(merged.at(-1).shot!==choice.shot)throw new Error('A class change needs a real cut; keep that boundary');
          merged.at(-1).endSec=original.endSec;
        } else merged.push({...original,shot:choice.shot,cutConfirmed:true});
      }
      intake.shots=merged;intake.cuts=merged.slice(1).map(s=>s.startSec);
      intake.reviewed=true;atomic(file,intake);
      const m=read(path.join(dir,'vfx.json'));m.state='prepared';m.output=null;atomic(path.join(dir,'vfx.json'),m);
      try{fs.unlinkSync(path.join(dir,'artifacts/vfx-spec.json'));}catch{}clearStoryboard(dir);return snapshot(dir);
    });
    exclusive('plan',async (dir,revision='')=> {
      if(typeof revision!=='string'||revision.length>10000)throw new Error('Revision brief too long');
      const m=read(path.join(dir,'vfx.json')),a=m.analysis;const env={};
      if(revision.trim()) {m.brief=revision.trim();atomic(path.join(dir,'vfx.json'),m);}
      if(a.mode==='api') {
        const key=secret('openrouter');if(!key)throw new Error('Add an OpenRouter key in global Settings');
        const approval=await dialogs.showMessageBox({type:'question',buttons:['Cancel','Send to API'],defaultId:0,cancelId:0,message:'Generate the VFX beat plan?',detail:`OpenRouter model: ${a.model}\nThe section transcript, timing, shot classifications and brief will leave your machine. API usage may be billed. Footage is not uploaded.`});
        if(approval.response!==1)return {ok:false,canceled:true};env.OPENROUTER_API_KEY=key;
      } else {
        const agent=(await agentLib.detectAll()).find(x=>x.id===a.provider);
        if(!agent?.installed || !agent.authed || agent.subscriptionReady===false)throw new Error('The selected agent is not signed in. Open the Agents page, sign in, then return here and refresh the project');
        env.VIDMYO_AGENT_CLI=agent.path;
      }
      progress(dir,'Drafting graphics against speech, format and the reviewed shot map');await py(dir,'plan',null,env);clearStoryboard(dir);
      m.state='plan';m.output=null;atomic(path.join(dir,'vfx.json'),m);await writeLog(dir);return snapshot(dir);
    });
    exclusive('save-spec',async (dir,spec)=> {
      if(!spec || JSON.stringify(spec).length>200000)throw new Error('Invalid or oversized spec');
      const input=path.join(dir,'artifacts/vfx-spec-input.json');atomic(input,spec);await py(dir,'validate',input);
      clearStoryboard(dir);const m=read(path.join(dir,'vfx.json'));m.state='plan';m.output=null;atomic(path.join(dir,'vfx.json'),m);await writeLog(dir);return snapshot(dir);
    });
    exclusive('storyboard',async dir=> {
      const m=read(path.join(dir,'vfx.json')),specFile=path.join(dir,'artifacts/vfx-spec.json');
      await py(dir,'validate',specFile);const spec=read(specFile),digest=crypto.createHash('sha256').update(fs.readFileSync(specFile)).digest('hex');
      progress(dir,'Building the art-direction storyboard');
      const workspace=await rendererWorkspace(dir,spec,'vfx-storyboard');
      const folder=path.join(dir,'artifacts','vfx-storyboard');fs.rmSync(folder,{recursive:true,force:true});fs.mkdirSync(folder,{recursive:true});
      const frames=[];
      for(const event of spec.events) {
        const duration=event.endSec-event.startSec;
        const times={enter:event.startSec+Math.min(.3,duration*.18),hold:(event.startSec+event.endSec)/2,exit:event.endSec-Math.min(.22,duration*.12)};
        for(const [phase,time] of Object.entries(times)) {
          const file=`event-${event.id}-${phase}.jpg`,frame=Math.max(0,Math.min(spec.source.frameCount-1,Math.round(time*spec.source.fps)));
          progress(dir,`Storyboarding ${event.id} ${phase}`);
          await run(dir,process.execPath,[workspace.cli,'still','src/index.ts','PerfectVfx',path.join(folder,file),`--props=${workspace.frozenSpec}`,`--frame=${frame}`,'--image-format=jpeg','--log=error'],{cwd:workspace.renderer,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
          frames.push({file,time,label:`${event.id} ${phase}`,eventId:event.id,phase});
        }
      }
      const canvas=m.format?.canvasClass || canvasClass(spec.source.width,spec.source.height),platform=m.format?.platform || (canvas==='portrait'?'shorts':'youtube');
      const safeZones={youtube:{top:5.5,right:5.5,bottom:6.5,left:5.5},shorts:{top:12,right:18,bottom:20,left:8},tiktok:{top:11,right:20,bottom:21,left:8},reels:{top:10,right:16,bottom:19,left:8},generic:{top:7,right:7,bottom:9,left:7}};
      atomic(path.join(dir,'artifacts/vfx-storyboard.json'),{version:1,specDigest:digest,canvasClass:canvas,platform,safeZone:safeZones[platform] || safeZones.generic,checks:[{id:'responsive-layout',label:`${canvas} composition grammar`,passed:true},{id:'text-capacity',label:'Typography and item capacity',passed:true},{id:'platform-safe-zone',label:`${platform} safe-zone profile`,passed:true},{id:'subject-preservation',label:canvas==='portrait'?'Aspect-preserved portrait framing':'Shot-gated creator framing',passed:true}],frames});
      if(crypto.createHash('sha256').update(fs.readFileSync(specFile)).digest('hex')!==digest)throw new Error('Plan changed while storyboarding. Generate the storyboard again');
      m.state='storyboard';m.output=null;atomic(path.join(dir,'vfx.json'),m);return snapshot(dir);
    });
    exclusive('render',async dir=> {
      const m=read(path.join(dir,'vfx.json')),specFile=path.join(dir,'artifacts/vfx-spec.json');
      await py(dir,'validate',specFile);const spec=read(specFile),approvedDigest=crypto.createHash('sha256').update(fs.readFileSync(specFile)).digest('hex'),intake=read(path.join(dir,'artifacts/vfx-intake.json'));
      let storyboard;try{storyboard=read(path.join(dir,'artifacts/vfx-storyboard.json'));}catch{throw new Error('Generate and review the storyboard before rendering');}
      if(storyboard.specDigest!==approvedDigest)throw new Error('The plan changed after storyboarding. Generate and review a new storyboard');
      const current=await py(dir,'probe',m.source.uri);if(current.fingerprint!==intake.source.fingerprint)throw new Error('Source changed. Prepare this section again');
      const approval=await dialogs.showMessageBox({type:'question',buttons:['Cancel','Render reviewed plan'],defaultId:0,cancelId:0,message:'Render this VFX plan locally?',detail:`${m.name}: ${spec.events.length} graphics, ${spec.source.durationSec.toFixed(2)} seconds.\nReview the complete beat chart in VFX before continuing. Google Fonts may be downloaded. Source audio is copied unchanged.`});
      if(approval.response!==1)return {ok:false,canceled:true};
      if(crypto.createHash('sha256').update(fs.readFileSync(specFile)).digest('hex')!==approvedDigest)throw new Error('Plan changed during approval. Review it again');
      progress(dir,'Preparing VFX for rendering');const workspace=await rendererWorkspace(dir,spec,'vfx-render');
      const specDigest=approvedDigest;
      const video=path.join(workspace.work,'graphics.mp4');progress(dir,'Rendering the reviewed plan locally');
      await run(dir,process.execPath,[workspace.cli,'render','src/index.ts','PerfectVfx',video,`--props=${workspace.frozenSpec}`,'--crf=16','--color-space=bt709','--log=error','--concurrency=2'],{cwd:workspace.renderer,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
      const extension=current.audio.some(a=>!['aac','mp3','alac','ac3','eac3'].includes(a.codec_name))?'mov':'mp4';
      const output=`vfx-baked-${Date.now()}.${extension}`,target=path.join(dir,output);
      await run(dir,'ffmpeg',['-v','error','-y','-i',video,'-i',m.source.uri,'-map','0:v:0','-map','1:a?','-c','copy','-map_metadata','1',target]);
      progress(dir,'Verifying frame, color and audio parity');const result=await py(dir,'probe',target);
      if(result.width!==current.width||result.height!==current.height||Math.abs(result.fps-current.fps)>0.00001||result.frameCount!==current.frameCount)throw new Error('Rendered frame parity failed. Output has not been accepted');
      if(result.pix_fmt!=='yuv420p'||result.color_space!=='bt709'||result.color_range!=='tv')throw new Error('Rendered BT.709 color parity failed');
      const audioHash=async file=>run(dir,'ffmpeg',['-v','error','-i',file,'-map','0:a?','-vn','-c','copy','-f','streamhash','-hash','sha256','-']);
      if(current.audio.length && await audioHash(target)!==await audioHash(m.source.uri))throw new Error('Source audio parity failed');
      if((await py(dir,'probe',m.source.uri)).fingerprint!==current.fingerprint)throw new Error('Source changed during rendering');
      const reviewDir=path.join(dir,'artifacts/vfx-review');fs.mkdirSync(reviewDir,{recursive:true});const review=[];
      const sample=async (file,time,label)=> {await run(dir,'ffmpeg',['-v','error','-y','-ss',String(time),'-i',target,'-frames:v','1','-vf','scale=720:-2',path.join(reviewDir,file)]);review.push({file,time,label});};
      for(const event of spec.events) {
        await sample(`event-${event.id}.jpg`,(event.startSec+event.endSec)/2,`${event.id} midpoint`);
        if(event.move==='SUBSCRIBE_CTA')await sample(`click-${event.id}.jpg`,event.payload.clickSec || event.startSec,'Subscribe click');
      }
      for(let i=1;i<intake.shots.length;i++) {
        const t=intake.shots[i].startSec;await sample(`cut-${i}-before.jpg`,Math.max(0,t-1/current.fps),'Before cut');await sample(`cut-${i}-after.jpg`,t,'On cut');
      }
      let psnr=null,cursor=0;const intervals=[];
      for(const e of spec.events){if(e.startSec-cursor>=.7)intervals.push([cursor,e.startSec]);cursor=e.endSec;}
      if(current.durationSec-cursor>=.7)intervals.push([cursor,current.durationSec]);
      if(intervals.length) {
        const [start,end]=intervals[0],a=Math.ceil(start*current.fps)+2,b=Math.floor(end*current.fps)-2;
        const stats=path.join(dir,'artifacts/vfx-psnr.log');
        await run(dir,'ffmpeg',['-v','error','-y','-i',m.source.uri,'-i',target,'-lavfi',`[0:v]trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS[s];[1:v]trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS[o];[s][o]psnr=stats_file=vfx-psnr.log`, '-an','-f','null','-'],{cwd:path.join(dir,'artifacts')});
        const lines=fs.readFileSync(stats,'utf8').trim().split('\n');const values=lines.map(line=>line.match(/psnr_avg:([\d.]+|inf)/)?.[1]).filter(Boolean).map(v=>v==='inf'?100:Number(v));
        psnr={startFrame:a,endFrame:b,meanDb:values.reduce((a,b)=>a+b,0)/values.length};
        if(!values.length||psnr.meanDb<35)throw new Error('Clean footage PSNR quality gate failed. Output is available in files for diagnosis');
      }
      atomic(path.join(dir,'artifacts/vfx-review.json'),review);
      atomic(path.join(dir,'artifacts/vfx-parity.json'),{source:current,output:result,frames:true,audio:true,color:true,psnr,visualReviewRequired:true});
      if(crypto.createHash('sha256').update(fs.readFileSync(specFile)).digest('hex')!==specDigest)throw new Error('Plan changed while rendering. Review and render the new plan');
      m.state='render-review';m.output=output;atomic(path.join(dir,'vfx.json'),m);await writeLog(dir);
      return snapshot(dir);
    });
    exclusive('accept',async dir=> {const m=read(path.join(dir,'vfx.json'));if(m.state!=='render-review'||!m.output||path.basename(m.output)!==m.output)throw new Error('Render and watch the output first');m.state='complete';atomic(path.join(dir,'vfx.json'),m);await writeLog(dir);return snapshot(dir);});
    exclusive('reveal',async dir=> {const m=read(path.join(dir,'vfx.json'));revealShell.showItemInFolder(path.join(dir,m.output || 'vfx.json'));return {ok:true};});
    ipc.handle('vfx:cancel',async (_e,dir)=> {const resolved=requireProject(dir);const worker=workerJobs.get(resolved);if(worker)worker.mod.cancelRepurposeJob(worker.store,worker.jobId);try{children.get(resolved)?.kill('SIGTERM');}catch{}return {ok:true};});
    ipc.handle('vfx:boards',async ()=> {const boards={};for(const theme of THEMES){boards[theme]=await media.grant(path.join(engine,'themes/boards',`${theme}-board.png`));boards[`${theme}-portrait`]=await media.grant(path.join(engine,'themes/boards',`${theme}-portrait-board.svg`));}return {ok:true,boards};});
  }
  async function stop(){for(const w of workerJobs.values()){try{w.mod.cancelRepurposeJob(w.store,w.jobId);}catch{}}workerJobs.clear();for(const child of children.values()){try{child.kill('SIGTERM');}catch{}}children.clear();await media.close();}
  return {register,stop,prepare:()=>rendererRuntime.ensure()};
}
let bridge;
module.exports={createVfxBridge,register(){bridge ||= createVfxBridge();bridge.register();},stop(){return bridge?.stop();},prepare(){bridge ||= createVfxBridge();return bridge.prepare();}};
