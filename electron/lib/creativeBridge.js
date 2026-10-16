// Durable, resumable Story/Animations production. The renderer receives data, never code.
const {ipcMain,app,dialog,BrowserWindow,shell}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const agents=require('./agents');
const {getSecret}=require('./secrets');
const {resolveRuntimePaths}=require('./runtimePaths');
const {createVfxRuntime}=require('./vfxRuntime');
const {createCleanerMedia}=require('./cleanerMedia');
const {makePipeline,readConfig:storyConfig}=require('./storyBridge');
const {createElevenLabsNarration}=require('./creativeNarration');
const {generateCodexImage}=require('./codexImages');
const {voiceboxStatus,createVoiceboxNarration}=require('./voicebox');

const MAX_JSON_BYTES=5*1024*1024;
const readJson=(file)=>{if(fs.statSync(file).size>MAX_JSON_BYTES)throw new Error('Project data is too large.');return JSON.parse(fs.readFileSync(file,'utf8'));};
function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=`${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);}
class Cancelled extends Error{constructor(message='Production stopped.'){super(message);this.name='CreativeCancelled';}}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const parseRate=(value)=>{const [a,b]=String(value||'0/1').split('/').map(Number);return b? a/b:0;};

function createCreativeBridge(deps={}){
  const ipc=deps.ipcMain||ipcMain;
  const application=deps.app||app;
  const dialogs=deps.dialog||dialog;
  const windows=deps.BrowserWindow||BrowserWindow;
  const agentLib=deps.agents||agents;
  const execute=deps.execFile||execFile;
  const secret=deps.getSecret||getSecret;
  const runtime=deps.runtime||resolveRuntimePaths({isPackaged:application.isPackaged,resourcesPath:process.resourcesPath,...(deps.repoRoot?{repoRoot:deps.repoRoot}:{})});
  const pkgRoot=runtime.packaged?process.resourcesPath:runtime.repoRoot;
  const engine=path.join(pkgRoot,'packages','animation-engine');
  const trackerTemplate=path.join(pkgRoot,'assets','templates','vidmyo-video-tracker-v1.csv');
  const core=deps.core||(()=>import(pathToFileURL(path.join(runtime.coreDir,'index.js')).href));
  const model=deps.model||(()=>import(pathToFileURL(path.join(runtime.coreDir,'src/animation.js')).href));
  const media=deps.media||createCleanerMedia();
  const active=new Map();
  const opened=new Set();
  const roots=new Set();
  const recentFile=path.join(application.getPath('userData'),'creative-projects.json');
  let registered=false;

  function recents(){
    try{
      const value=readJson(recentFile);
      if(!Array.isArray(value))return [];
      return value.filter((item)=>item&&typeof item.dir==='string'&&path.isAbsolute(item.dir)&&fs.existsSync(path.join(item.dir,'project.json'))).slice(0,100);
    }catch{return [];}
  }
  function remember(project){
    const brief=project.manifest.brief||{};
    const items=recents().filter((item)=>path.resolve(item.dir)!==path.resolve(project.dir));
    items.unshift({dir:project.dir,title:brief.topic||'Untitled video',kind:brief.kind||'story',style:project.manifest.style,updatedAt:project.manifest.updatedAt});
    atomicJson(recentFile,items.slice(0,100));
  }
  const check=(dir)=>{const resolved=typeof dir==='string'?path.resolve(dir):'';if(!resolved||!opened.has(resolved))throw new Error('Open this project first.');return resolved;};
  const fileIn=(dir,file)=>{
    if(typeof file!=='string'||!file)throw new Error('Project media is missing.');
    const root=fs.realpathSync(dir);const target=fs.realpathSync(path.resolve(dir,file));
    if(target===root||!target.startsWith(root+path.sep)||!fs.statSync(target).isFile())throw new Error('Project media must be inside its folder.');
    return target;
  };
  const relativeIn=(dir,file)=>path.relative(dir,fileIn(dir,file)).split(path.sep).join('/');
  function emit(dir,message){for(const win of windows.getAllWindows())try{win.webContents.send('creative:progress',{dir,message});}catch{}}
  function setState(project,state,message,extra={}){project.manifest.production={...project.manifest.production,...extra,state,message:message||state};project.save();remember(project);emit(project.dir,message||state);}

  let renderer;
  function run(dir,command,args,options={}){return new Promise((resolve,reject)=>{
    const job=active.get(path.resolve(dir));
    if(job?.cancelled){reject(new Cancelled());return;}
    const child=execute(command,args,{timeout:60*60*1000,maxBuffer:16*1024*1024,...options,env:{...process.env,...options.env,PATH:[renderer?.status()?.binDir,process.env.PATH,'/opt/homebrew/bin','/usr/local/bin'].filter(Boolean).join(path.delimiter)}},(error,stdout='',stderr='')=>{
      if(job?.child===child)job.child=null;
      if(error)reject(job?.cancelled?new Cancelled():new Error(String(stderr||error.message).slice(-1800)));
      else resolve(String(stdout));
    });
    if(job)job.child=child;
  });}
  let vfxConfig={};try{vfxConfig=readJson(path.join(application.getPath('userData'),'vfx-config.json'));}catch{}
  renderer=deps.renderer||createVfxRuntime({engine:path.join(pkgRoot,'packages','vfx-engine'),root:vfxConfig.runtimeRoot||path.join(application.getPath('userData'),'vfx-runtime'),run});

  async function loadProject(dir,{interrupt=false}={}){
    if(typeof dir!=='string'||!path.isAbsolute(dir))throw new Error('Choose a valid project folder.');
    const resolved=fs.realpathSync(dir);
    if(!fs.statSync(resolved).isDirectory())throw new Error('Choose a valid project folder.');
    const file=path.join(resolved,'project.json');
    const raw=readJson(file);
    if(raw.version!==1||typeof raw.id!=='string'||!/^proj_[A-Za-z0-9_-]+$/.test(raw.id)||!Array.isArray(raw.scenes)||!Array.isArray(raw.renders)||!raw.voiceover||typeof raw.voiceover!=='object'){
      throw new Error('This folder is not a Stickman or Animation project. Choose the folder containing project.json.');
    }
    const mod=await core();const contract=await model();const project=mod.Project.load(resolved);const before=JSON.stringify(project.manifest);
    contract.normalizeCreativeManifest(project.manifest);
    if(interrupt&&!active.has(resolved))contract.markInterruptedProduction(project.manifest);
    if(before!==JSON.stringify(project.manifest))project.save();
    return project;
  }
  async function snapshot(dir){
    const project=await loadProject(dir);const manifest=project.manifest;const result={ok:true,dir:project.dir,manifest,busy:active.has(path.resolve(project.dir))};
    const legacy=!manifest.production||manifest.production.state==='done';
    const output=manifest.production?.output||(legacy?(manifest.renders?.at(-1)?.finalPath||manifest.renders?.at(-1)?.path):null);
    if(output)try{result.previewUrl=await media.grant(fileIn(project.dir,output));}catch{}
    if(manifest.voiceover?.artifact)try{result.voiceUrl=await media.grant(fileIn(project.dir,manifest.voiceover.artifact));}catch{}
    return result;
  }
  async function providerEnv(brief){
    if(brief.provider.id==='openrouter'){
      const key=secret('openrouter');if(!key)throw new Error('Add your OpenRouter key in Settings.');return {OPENROUTER_API_KEY:key};
    }
    const detected=(await agentLib.detectAll()).find((item)=>item.id===brief.provider.id);
    if(!detected?.installed||!detected.authed||detected.subscriptionReady===false)throw new Error('The selected agent is not connected. Open Agents or choose another provider.');
    return {VIDMYO_AGENT_CLI:detected.path};
  }
  async function direct(project,phase,extra,env){
    if(deps.director)return deps.director({project,phase,brief:project.manifest.brief,...extra});
    const request=path.join(project.dir,'artifacts',`director-${phase}-request.json`);const output=path.join(project.dir,'artifacts',`director-${phase}.json`);
    const job=active.get(path.resolve(project.dir));
    const source=project.manifest.brief||{};
    const publicBrief={kind:source.kind,style:source.style,aspect:source.aspect,characterAnimation:source.characterAnimation,topic:source.topic,details:source.details,durationSec:source.durationSec,language:source.language,provider:{id:source.provider?.id,model:source.provider?.model}};
    const task={phase,brief:publicBrief};
    if(phase==='plan'){task.script=extra.script;task.beats=extra.beats;}
    atomicJson(request,task);
    await run(project.dir,process.env.VIDMYO_REPURPOSE_PYTHON||'python3',['-m','vidmyo_repurpose.creative','--request',request,'--output',output,'--cancel-file',job.cancelFile],{env:{...env,PYTHONPATH:path.join(runtime.repurposeEngineDir,'src')}});
    return readJson(output);
  }
  async function consent(project,mod,{needsImages=false,needsDirector=false,needsVoice=false}={}){
    const brief=project.manifest.brief;const production=project.manifest.production||{};
    const usesImages=brief.style!=='documentary-map';const source=usesImages?mod.getCreativeImageSource(brief.imageSource):null;
    const usesPaidDirector=brief.provider.id==='openrouter';const usesPaidVoice=brief.narration&&brief.voiceProvider==='elevenlabs';const usesVoicebox=brief.narration&&brief.voiceProvider==='voicebox';
    const maximumImages=usesImages?Math.ceil(brief.durationSec/3)*(brief.style==='editorial-collage'||brief.style==='paper-stop-motion'?4:1):0;
    const authorization=(await model()).creativeFingerprint({
      brief:{kind:brief.kind,style:brief.style,topic:brief.topic,details:brief.details,aspect:brief.aspect,durationSec:brief.durationSec,language:brief.language,suppliedScript:production.scriptOrigin==='supplied'?project.manifest.script:null},
      director:usesPaidDirector?brief.provider:null,
      images:usesImages?{source:source.id,model:brief.imageModel||mod.resolveCreativeImageModel(source.id),maximum:maximumImages}:null,
      voice:usesPaidVoice?'elevenlabs':usesVoicebox?{provider:'voicebox',voiceId:brief.voiceboxVoiceId}:null,
    });
    if(needsImages){if(!brief.imageSource||source.manual)throw new Error('Choose an automatic image provider. Google Flow cannot run automatically.');if(!source.subscription&&!secret(source.provider))throw new Error(`Add your ${source.name} key in Settings.`);}
    if(needsVoice&&usesPaidVoice&&!secret('elevenlabs'))throw new Error('Add your ElevenLabs key in Settings.');
    if(project.manifest.production.authorizationFingerprint===authorization)return true;
    if((needsDirector&&usesPaidDirector)||needsImages||(needsVoice&&(usesPaidVoice||usesVoicebox))){
      const voiceDetail=usesPaidVoice?'Voice: ElevenLabs multilingual. Script text is sent to ElevenLabs and may use paid credits.':brief.narration&&brief.voiceProvider==='voicebox'?'Voice: local Voicebox. Narration stays on this computer; use only a voice you own or have permission to use.':brief.narration?'Voice: local Kokoro.':'No narration.';
      const detail=[`${brief.topic} · ${brief.durationSec}s · ${brief.aspect}`,usesPaidDirector?`Director: OpenRouter / ${brief.provider.model}. Brief and narration are sent to this API.`:'Director: selected local agent.',voiceDetail,usesImages?`Images: ${source.name} / ${brief.imageModel||mod.resolveCreativeImageModel(source.id)}. ${source.subscription ? `Uses your Codex allowance, not unlimited image generation. Up to ${maximumImages} images. No API fallback.` : `At most ${maximumImages} isolated scene layers may be billed.`}`:'Maps render locally without image generation.','Script and voiceover reviews occur before image generation.'].join('\n');
      const answer=await dialogs.showMessageBox({type:'question',buttons:['Cancel','Create video'],defaultId:0,cancelId:0,message:'Start this video production?',detail});
      if(answer.response!==1)throw new Cancelled('Production cancelled before provider use.');
    }
    project.manifest.production={...project.manifest.production,authorizationFingerprint:authorization};project.save();return true;
  }
  function ensureRunning(dir){const job=active.get(path.resolve(dir));if(!job||job.cancelled)throw new Cancelled();return job;}
  function clearArtifacts(project,{script=false,voice=false,plan=false}={}){
    const manifest=project.manifest;const production=manifest.production||{};
    if(script){manifest.script=null;manifest.brief.script='';production.scriptFingerprint=null;production.scriptOrigin=null;production.scriptApproved=false;voice=true;}
    if(voice){manifest.voiceover={source:null,artifact:null,wordTimings:null};production.voiceFingerprint=null;production.voiceApproved=false;try{fs.unlinkSync(path.join(project.dir,'beats.json'));}catch{}plan=true;}
    if(plan){try{fs.unlinkSync(path.join(project.dir,'artifacts','animation-plan.json'));}catch{}try{fs.unlinkSync(path.join(project.dir,'artifacts','flow-image-queue.json'));}catch{}production.planFingerprint=null;production.flowQueue=null;production.assetsDone=false;production.output=null;}
    production.state='draft';production.message='Ready to create';manifest.production=production;
  }

  function sceneImagePrompt(brief,scene,target=scene,mod){
    const layer=target===scene?null:target;
    if(brief.kind==='story'&&brief.characterAnimation==='animated')return `Clean hand-drawn 2D cartoon environment. ${scene.visual}. BACKGROUND ONLY: no people, characters, faces, bodies, silhouettes, text or lettering. Static camera, clear ground plane at 80 percent image height, open foreground for separately animated stick figures. Consistent bold outlines and restrained colors. ${brief.aspect} composition.`;
    const direction=brief.kind==='story'?mod.DOODLE_STYLE.promptAnchor:brief.style==='paper-stop-motion'?'Premium handcrafted paper sculpture, thick layered cardstock, visible fibers and cut edges, dimensional shadow gaps, no text.':'Editorial documentary paper collage, photographic paper cutout, offset red marker edge, tactile paper texture, no text.';
    const subject=layer?`${layer.kind} object: ${layer.description}`:scene.visual;
    const isolation=layer?' Create one isolated cutout only on a fully transparent background. Preserve clean alpha edges; no backdrop, floor, frame, caption, lettering, or extra objects.':'';
    return `${direction} ${subject}.${isolation} ${brief.aspect} composition. ${brief.kind==='story'?mod.DOODLE_STYLE.promptLock.replace('16:9',brief.aspect):''}`;
  }

  function expectedAssetFingerprint(brief,scene,target,source,imageModel,contract){
    return contract.creativeAssetFingerprint(brief.style,brief.aspect,scene,{imageSource:source.id,imageModel,characterAnimation:brief.characterAnimation,layer:target===scene?null:target});
  }

  function hasImageAsset(project,brief,scene,target,source,imageModel,contract){
    const expected=expectedAssetFingerprint(brief,scene,target,source,imageModel,contract);
    if(!target.asset||target.assetFingerprint!==expected)return false;
    try{fileIn(project.dir,target.asset);return true;}catch{return false;}
  }

  function flowQueuePath(project){return path.join(project.dir,'artifacts','flow-image-queue.json');}
  function flowImagesReady(project,plan,brief,source,imageModel,contract){
    return plan.scenes.every((scene)=>hasImageAsset(project,brief,scene,scene,source,imageModel,contract));
  }

  function writeFlowQueue(project,plan,brief,mod){
    const queue=mod.createFlowQueue({projectId:project.manifest.id,aspect:brief.aspect,scenes:plan.scenes.map((scene)=>({sceneId:scene.id,prompt:sceneImagePrompt(brief,scene,scene,mod)}))});
    const file=flowQueuePath(project);atomicJson(file,queue);
    project.manifest.production.flowQueue={file:relativeIn(project.dir,file),fileName:path.basename(file),projectId:queue.projectId,sceneCount:queue.scenes.length,planFingerprint:project.manifest.production.planFingerprint};
    project.save();return queue;
  }

  function collectFlowImages(selection,queue){
    const expected=new Set(queue.scenes.map((scene)=>scene.sceneId));const found=new Map();
    for(const selected of selection){
      let candidates=[];
      try{
        const stat=fs.statSync(selected);
        if(stat.isDirectory()){
          candidates.push(selected,path.join(selected,queue.projectId,'images'),path.join(selected,'images'));
        }else if(stat.isFile())candidates.push(selected);
      }catch{continue;}
      for(const candidate of candidates){
        try{
          const stat=fs.statSync(candidate);
          const entries=stat.isDirectory()?fs.readdirSync(candidate,{withFileTypes:true}).filter((entry)=>entry.isFile()).map((entry)=>path.join(candidate,entry.name)):[candidate];
          for(const file of entries){
            const match=path.basename(file).match(/^(s\d{3,})\.(png|jpe?g|webp)$/i);
            if(match&&expected.has(match[1])&&!found.has(match[1]))found.set(match[1],file);
          }
        }catch{/* A suggested nested Downloads folder may not exist. */}
      }
    }
    return found;
  }

  async function generateSceneImage(project,scene,target,planFile,mod,contract){
    const brief=project.manifest.brief;const source=mod.getCreativeImageSource(brief.imageSource);const imageModel=mod.resolveCreativeImageModel(source.id,brief.imageModel);
    const layer=target===scene?null:target;
    const desired=expectedAssetFingerprint(brief,scene,target,source,imageModel,contract);
    if(target.asset&&(!target.assetFingerprint||target.assetFingerprint===desired)){
      try{fileIn(project.dir,target.asset);target.assetFingerprint=desired;atomicJson(planFile,{version:1,scenes:project._creativePlan.scenes});return;}catch{}
    }
    delete target.asset;delete target.assetFingerprint;
    const prompt=sceneImagePrompt(brief,scene,target,mod);
    if(deps.generateImage){const generated=await deps.generateImage({project,scene,layer,prompt,source,imageModel});ensureRunning(project.dir);target.asset=relativeIn(project.dir,generated.path||generated);target.assetFingerprint=desired;atomicJson(planFile,{version:1,scenes:project._creativePlan.scenes});return;}
    if(source.subscription){const output=await generateCodexImage({projectDir:project.dir,fingerprint:desired,prompt,agents:agentLib,run});ensureRunning(project.dir);target.asset=relativeIn(project.dir,output);target.assetFingerprint=desired;atomicJson(planFile,{version:1,scenes:project._creativePlan.scenes});return;}
    const jobsDir=path.join(project.dir,'.vidmyo','jobs');const store=new mod.JobStore(jobsDir,{governorDir:mod.defaultGovernorDir()});let job=target.jobId?store.get(target.jobId):null;
    if(job?.state==='done'){
      const artifact=job.artifacts?.[0]?.path;if(artifact){target.asset=relativeIn(project.dir,artifact);target.assetFingerprint=desired;atomicJson(planFile,{version:1,scenes:project._creativePlan.scenes});return;}
    }
    if(job?.state==='error'&&job.checkpoints?.handle)job=store.resume(job.id);
    if(job?.state==='cancelled'&&!job.checkpoints?.handle)job=null;
    if(job&&['running','error','cancelled'].includes(job.state)&&!job.checkpoints?.handle)throw new Error('Image submission was interrupted before a provider handle was saved. Vidmyo will not resubmit automatically because that could create a duplicate charge.');
    if(job?.state==='cancelled'&&job.checkpoints?.handle)throw new Error('This provider image request was cancelled after submission. Vidmyo will not submit it again automatically.');
    if(!job){const adapter=mod.makeGenerationAdapter(source.id,{key:secret(source.provider),model:imageModel,kind:'image'});job=store.create({type:'image',provider:source.id,project:project.manifest.id,params:mod.buildGenerationParams(source.id,'image',{prompt,aspect:brief.aspect})});target.jobId=job.id;atomicJson(planFile,{version:1,scenes:project._creativePlan.scenes});job._adapter=adapter;}
    const adapter=job._adapter||mod.makeGenerationAdapter(source.id,{key:secret(source.provider),model:imageModel,kind:'image'});const activeJob=ensureRunning(project.dir);activeJob.cloud={store,id:job.id};
    const done=await mod.runJob(store,job.id,adapter,{outDir:path.join(project.dir,'images'),pollMs:adapter.pollMs||1500});activeJob.cloud=null;ensureRunning(project.dir);
    if(done.state!=='done'||!done.artifacts?.length)throw new Error(done.error||'Image generation did not finish.');
    target.asset=relativeIn(project.dir,done.artifacts[0].path);target.assetFingerprint=desired;atomicJson(planFile,{version:1,scenes:project._creativePlan.scenes});
  }

  async function verifyOutput(output,props,audioDuration){
    if(deps.verifyOutput)return deps.verifyOutput({output,props,audioDuration});
    const probeTool=path.join(renderer.status().binDir,`ffprobe${process.platform==='win32'?'.exe':''}`);
    const probe=JSON.parse(await run(path.dirname(output),probeTool,['-v','error','-show_streams','-show_format','-of','json',output]));
    const video=probe.streams?.find((stream)=>stream.codec_type==='video');const audio=probe.streams?.find((stream)=>stream.codec_type==='audio');
    const duration=Number(probe.format?.duration||video?.duration);const expected=props.totalFrames/props.fps;
    if(!video||Number(video.width)!==props.width||Number(video.height)!==props.height)throw new Error('Output validation failed: dimensions do not match the project.');
    if(Math.abs(parseRate(video.avg_frame_rate||video.r_frame_rate)-props.fps)>.02)throw new Error('Output validation failed: frame rate is not 30 fps.');
    if(!Number.isFinite(duration)||duration+2/props.fps<expected||duration>expected+.25)throw new Error('Output validation failed: duration does not cover every planned frame.');
    if(audioDuration&&(!audio||duration+2/props.fps<audioDuration))throw new Error('Output validation failed: narration or its ending is missing.');
    return probe;
  }

  async function render(project,plan,totalDuration,audioDuration,contract){
    const brief=project.manifest.brief;const fps=30;const scenes=contract.allocateSceneFrames(plan.scenes,totalDuration,fps);const totalFrames=scenes.at(-1).startFrame+scenes.at(-1).frames;
    const renderFingerprint=contract.creativeFingerprint({rendererVersion:7,brief:{style:brief.style,aspect:brief.aspect,characterAnimation:brief.characterAnimation,characterDesign:brief.characterDesign},scenes:scenes.map(({id,headline,visual,frames,startFrame,asset,assetFingerprint,locations,layers,characters})=>({id,headline,visual,frames,startFrame,asset,assetFingerprint,locations,layers,characters})),voice:project.manifest.production.voiceFingerprint||null});
    const output=path.join(project.dir,`video-${renderFingerprint.slice(0,16)}.mp4`);const width=brief.aspect==='9:16'?1080:1920;const height=brief.aspect==='9:16'?1920:1080;
    const props={style:brief.style,characterAnimation:brief.characterAnimation,characterDesign:brief.characterDesign,width,height,fps,totalFrames,scenes};
    if(fs.existsSync(output)){await verifyOutput(output,props,audioDuration);return {output:relativeIn(project.dir,output),renderFingerprint,props};}
    if(deps.renderVideo){const made=await deps.renderVideo({project,plan,props,output});await verifyOutput(made||output,props,audioDuration);return {output:relativeIn(project.dir,made||output),renderFingerprint,props};}
    await renderer.ensure();ensureRunning(project.dir);
    const work=path.join(project.dir,'.vidmyo',`animation-${renderFingerprint.slice(0,16)}`);fs.mkdirSync(work,{recursive:true});fs.cpSync(path.join(engine,'renderer'),work,{recursive:true});
    const modules=path.join(renderer.root,'renderer','node_modules');const link=path.join(work,'node_modules');if(!fs.existsSync(link))fs.symlinkSync(modules,link,process.platform==='win32'?'junction':'dir');
    const publicDir=path.join(work,'public');fs.mkdirSync(publicDir,{recursive:true});
    props.scenes=props.scenes.map((scene,index)=>{const entry={...scene};if(scene.asset){const name=`scene-${String(index+1).padStart(3,'0')}${path.extname(scene.asset).toLowerCase()}`;fs.copyFileSync(fileIn(project.dir,scene.asset),path.join(publicDir,name));entry.asset=name;}entry.layers=(scene.layers||[]).map((layer,layerIndex)=>{if(!layer.asset)return layer;const name=`scene-${index+1}-layer-${layerIndex+1}${path.extname(layer.asset).toLowerCase()}`;fs.copyFileSync(fileIn(project.dir,layer.asset),path.join(publicDir,name));return {...layer,asset:name};});return entry;});
    if(brief.narration){fs.copyFileSync(fileIn(project.dir,project.manifest.voiceover.artifact),path.join(publicDir,'voiceover.wav'));props.audio='voiceover.wav';}
    if(brief.characterAnimation==='animated'&&brief.narration){
      const pcm=path.join(work,'speech.f32le');const ffmpeg=path.join(renderer.status().binDir,`ffmpeg${process.platform==='win32'?'.exe':''}`);
      await run(project.dir,ffmpeg,['-y','-v','error','-i',path.join(publicDir,'voiceover.wav'),'-vn','-ac','1','-ar','8000','-f','f32le',pcm]);
      props.speechEnvelope=contract.speechEnvelopeFromPcm(fs.readFileSync(pcm),totalFrames,fps);fs.unlinkSync(pcm);
    }
    const propsFile=path.join(work,'props.json');atomicJson(propsFile,props);const raw=path.join(work,'render.mp4');
    await run(project.dir,process.execPath,[path.join(modules,'@remotion','cli','remotion-cli.js'),'render','index.jsx','VidmyoAnimation',raw,`--props=${propsFile}`,'--crf=18','--color-space=bt709','--log=error','--concurrency=2'],{cwd:work,env:{ELECTRON_RUN_AS_NODE:'1'}});ensureRunning(project.dir);
    const temp=`${output}.tmp.mp4`;
    if(brief.narration){const ffmpeg=path.join(renderer.status().binDir,`ffmpeg${process.platform==='win32'?'.exe':''}`);await run(project.dir,ffmpeg,['-y','-v','error','-i',raw,'-map','0:v:0','-map','0:a:0','-c:v','copy','-af','loudnorm=I=-14:TP=-1:LRA=11','-c:a','aac','-b:a','192k',temp]);}
    else fs.copyFileSync(raw,temp);
    fs.renameSync(temp,output);await verifyOutput(output,props,audioDuration);return {output:relativeIn(project.dir,output),renderFingerprint,props};
  }

  async function produce(dir,{approve=false}={}){
    const mod=await core();const contract=await model();const project=await loadProject(dir);const manifest=project.manifest;
    manifest.brief=contract.validateCreativeBrief({...manifest.brief,script:manifest.script||manifest.brief.script});const brief=manifest.brief;manifest.production=manifest.production||{state:'draft'};
    if(manifest.production.state==='review-script'&&!approve)return;
    if(manifest.production.state==='review-voiceover'&&!approve)return;
    if(approve&&manifest.production.state==='review-script'){manifest.production.scriptApproved=true;project.save();}
    if(approve&&manifest.production.state==='review-voiceover'){manifest.production.voiceApproved=true;project.save();}
    if(manifest.production.state==='done'&&manifest.production.output&&fs.existsSync(path.resolve(project.dir,manifest.production.output)))return;
    const planFile=path.join(project.dir,'artifacts','animation-plan.json');
    const needsDirector=!manifest.script||!manifest.production.planFingerprint||!fs.existsSync(planFile);
    let needsImages=brief.style!=='documentary-map';
    if(needsImages&&fs.existsSync(planFile)){
      try{
        const cached=contract.validateAnimationPlan(readJson(planFile),{style:brief.style,characterAnimation:brief.characterAnimation});
        const source=mod.getCreativeImageSource(brief.imageSource);const imageModel=mod.resolveCreativeImageModel(source.id,brief.imageModel);
        needsImages=!cached.scenes.every((scene)=>{
          const targets=(brief.style==='editorial-collage'||brief.style==='paper-stop-motion')?scene.layers:[scene];
          return targets.length>0&&targets.every((target)=>{
            const layer=target===scene?null:target;
            const expected=contract.creativeAssetFingerprint(brief.style,brief.aspect,scene,{imageSource:source.id,imageModel,characterAnimation:brief.characterAnimation,layer});
            if(!target.asset||target.assetFingerprint!==expected)return false;
            try{fileIn(project.dir,target.asset);return true;}catch{return false;}
          });
        });
      }catch{needsImages=true;}
    }
    const needsVoice=brief.narration&&['elevenlabs','voicebox'].includes(brief.voiceProvider)&&!manifest.voiceover?.artifact;
    const initialImageSource=needsImages?mod.getCreativeImageSource(brief.imageSource):null;
    // Flow is a local hand-off to the user's Chrome extension, not a Vidmyo
    // image API request. It must not trigger API-key or paid-image consent.
    await consent(project,mod,{needsImages:needsImages&&!initialImageSource?.manual,needsDirector,needsVoice});let env=null;const directorEnv=async()=>env||(env=await providerEnv(brief));ensureRunning(dir);
    if(!manifest.script){setState(project,'writing','Writing your script');const response=await direct(project,'script',{},await directorEnv());const script=String(response?.script||'').trim();if(!script||script.length>30000)throw new Error('The agent returned an invalid script.');manifest.script=script;manifest.brief.script=script;manifest.production.scriptOrigin='generated';manifest.production.scriptFingerprint=contract.creativeFingerprint({topic:brief.topic,details:brief.details,durationSec:brief.durationSec,language:brief.language});project.save();}
    ensureRunning(dir);
    if(brief.reviewScript&&!manifest.production.scriptApproved){setState(project,'review-script','Your script is ready to review');return;}
    let totalDuration=brief.durationSec;let intervals=[];let audioDuration=null;
    if(brief.narration){
      const voiceFingerprint=contract.creativeFingerprint({script:manifest.script,language:brief.language,voiceProvider:brief.voiceProvider,voiceboxVoiceId:brief.voiceboxVoiceId||'',kokoroVoiceId:brief.kokoroVoiceId||'am_onyx'});
      let voiceValid=manifest.production.voiceFingerprint===voiceFingerprint&&manifest.voiceover?.artifact;try{if(voiceValid)fileIn(project.dir,manifest.voiceover.artifact);}catch{voiceValid=false;}
      if(!voiceValid){setState(project,'voiceover',brief.voiceProvider==='elevenlabs'?'Creating the multilingual voiceover':brief.voiceProvider==='voicebox'?'Creating the voiceover with local Voicebox':'Creating the voiceover locally');const output=path.join(project.dir,'voiceover.wav');
        if(brief.voiceProvider==='elevenlabs'){
          await renderer.ensure();ensureRunning(dir);const cfg=storyConfig();const result=deps.createElevenLabsNarration?await deps.createElevenLabsNarration({text:manifest.script,outWav:output,key:secret('elevenlabs'),approved:true,run:(cmd,args,opts)=>run(project.dir,cmd,args,opts),signal:ensureRunning(dir).controller.signal,voiceId:cfg.elevenLabsVoiceId,modelId:cfg.elevenLabsModelId}):await createElevenLabsNarration({text:manifest.script,outWav:output,key:secret('elevenlabs'),approved:true,run:(cmd,args,opts)=>run(project.dir,cmd,args,opts),signal:ensureRunning(dir).controller.signal,voiceId:cfg.elevenLabsVoiceId,modelId:cfg.elevenLabsModelId});
          manifest.voiceover={...manifest.voiceover,...result,artifact:relativeIn(project.dir,result.artifact)};
        }else if(brief.voiceProvider==='voicebox'){
          await renderer.ensure();ensureRunning(dir);const ffmpegPath=path.join(renderer.status().binDir,`ffmpeg${process.platform==='win32'?'.exe':''}`);const result=deps.createVoiceboxNarration?await deps.createVoiceboxNarration({text:manifest.script,outWav:output,voiceId:brief.voiceboxVoiceId,language:brief.language,approved:true,ffmpegPath,run:(cmd,args,opts)=>run(project.dir,cmd,args,opts),signal:ensureRunning(dir).controller.signal}):await createVoiceboxNarration({text:manifest.script,outWav:output,voiceId:brief.voiceboxVoiceId,language:brief.language,approved:true,ffmpegPath,run:(cmd,args,opts)=>run(project.dir,cmd,args,opts),signal:ensureRunning(dir).controller.signal});
          manifest.voiceover={...manifest.voiceover,...result,artifact:relativeIn(project.dir,result.artifact)};
        }else{const voice=contract.creativeVoiceForLanguage(brief.language,'kokoro',brief.kokoroVoiceId);const pipeline=deps.makePipeline?await deps.makePipeline():await makePipeline();pipeline.exec=async(cmd,args,opts)=>({stdout:await run(project.dir,cmd,args,opts),stderr:''});if(!pipeline.readiness().ok){setState(project,'voiceover','Preparing local voice tools');await pipeline.setupEnv();}const scriptFile=path.join(project.dir,'script.txt');fs.writeFileSync(scriptFile,manifest.script);await pipeline.tts(scriptFile,output,{voice:voice.voice,lang:voice.lang});manifest.voiceover={source:'kokoro',voiceId:voice.voice,artifact:relativeIn(project.dir,output),wordTimings:null};}
        ensureRunning(dir);manifest.production.voiceFingerprint=voiceFingerprint;manifest.production.voiceApproved=false;project.save();
      }
      if(brief.reviewVoiceover&&!manifest.production.voiceApproved){setState(project,'review-voiceover','Listen to your voiceover, then continue');return;}
      const wav=fileIn(project.dir,manifest.voiceover.artifact);audioDuration=contract.wavDurationSeconds(fs.readFileSync(wav));totalDuration=audioDuration;
      const beatFile=path.join(project.dir,'beats.json');if(!fs.existsSync(beatFile)||manifest.production.beatsFingerprint!==voiceFingerprint){setState(project,'planning','Timing scenes to the full narration');const pipeline=deps.makePipeline?await deps.makePipeline():await makePipeline();pipeline.exec=async(cmd,args,opts)=>({stdout:await run(project.dir,cmd,args,opts),stderr:''});await pipeline.detectBeats(wav,beatFile,{minLen:3,maxLen:12});manifest.production.beatsFingerprint=voiceFingerprint;project.save();}
      intervals=contract.sceneIntervalsFromBeats(readJson(beatFile).beats||[],audioDuration);
    }
    ensureRunning(dir);
    const planFingerprint=contract.creativeFingerprint({spec:contract.creativeSpecFingerprint(brief,manifest.script),intervals:intervals.map(({id,text,durationSec})=>({id,text,durationSec})),totalDuration});let plan=null;
    if(fs.existsSync(planFile)){try{plan=contract.validateAnimationPlan(readJson(planFile),{expectedSceneCount:intervals.length||null,style:brief.style,characterAnimation:brief.characterAnimation});}catch{plan=null;}}
    if(!plan||manifest.production.planFingerprint!==planFingerprint){setState(project,'planning','Designing scenes and motion');const raw=await direct(project,'plan',{script:manifest.script,beats:intervals.map(({id,text,durationSec})=>({id,text,durationSec}))},await directorEnv());plan=contract.validateAnimationPlan(raw,{expectedSceneCount:intervals.length||null,style:brief.style,characterAnimation:brief.characterAnimation});if(intervals.length)plan.scenes=plan.scenes.map((scene,index)=>({...scene,durationSec:intervals[index].durationSec}));else{const sum=plan.scenes.reduce((value,scene)=>value+scene.durationSec,0);plan.scenes=plan.scenes.map((scene)=>({...scene,durationSec:scene.durationSec/sum*brief.durationSec}));}plan=contract.validateAnimationPlan(plan,{expectedDurationSec:totalDuration,expectedSceneCount:intervals.length||null,style:brief.style,characterAnimation:brief.characterAnimation});if(plan.scenes.length>Math.ceil(totalDuration/3))throw new Error('Scene count exceeds the image budget. Reduce scene density and try again.');atomicJson(planFile,plan);manifest.production.planFingerprint=planFingerprint;manifest.production.assetsDone=false;project.save();}
    project._creativePlan=plan;
    const selectedImageSource=mod.getCreativeImageSource(brief.imageSource);const selectedImageModel=mod.resolveCreativeImageModel(selectedImageSource.id,brief.imageModel);
    if(brief.kind==='story'&&brief.style!=='documentary-map'&&selectedImageSource.id==='flow'){
      // Curio Flow Queue downloads to Downloads/<projectId>/images with sNNN
      // filenames, so a user can import the whole folder in one safe action.
      writeFlowQueue(project,plan,brief,mod);
      if(!flowImagesReady(project,plan,brief,selectedImageSource,selectedImageModel,contract)){
        const queueFile=project.manifest.production.flowQueue.fileName;
        setState(project,'flow-images',`Open the Chrome Extension and import ${queueFile}. When every image is ready, choose its downloaded images folder here.`);
        return;
      }
    }
    if(brief.style!=='documentary-map')for(let index=0;index<plan.scenes.length;index++){
      const scene=plan.scenes[index];const targets=(brief.style==='editorial-collage'||brief.style==='paper-stop-motion')?scene.layers:[scene];
      for(let layerIndex=0;layerIndex<targets.length;layerIndex++){
        ensureRunning(dir);setState(project,'images',`Creating scene ${index+1} of ${plan.scenes.length}, layer ${layerIndex+1} of ${targets.length}`);
        await generateSceneImage(project,scene,targets[layerIndex],planFile,mod,contract);
      }
    }
    manifest.production.assetsDone=true;project.save();ensureRunning(dir);setState(project,'rendering','Assembling your video');const rendered=await render(project,plan,totalDuration,audioDuration,contract);ensureRunning(dir);
    manifest.production.output=rendered.output;manifest.production.renderFingerprint=rendered.renderFingerprint;manifest.renders.push({path:rendered.output,finalPath:rendered.output,finalized:true,width:rendered.props.width,height:rendered.props.height,fps:rendered.props.fps,frames:rendered.props.totalFrames,at:new Date().toISOString()});setState(project,'done','Your video is ready');
  }

  function register(){
    if(registered)return false;registered=true;
    const handle=(name,fn)=>ipc.handle(`creative:${name}`,async(_event,...args)=>{try{return await fn(...args);}catch(error){return {ok:false,error:String(error?.message||error)};}});
    handle('pick-root',async()=>{const choice=await dialogs.showOpenDialog({title:'Where should Vidmyo save your videos?',properties:['openDirectory','createDirectory']});if(choice.canceled)return {ok:false,canceled:true};const dir=fs.realpathSync(choice.filePaths[0]);roots.add(dir);return {ok:true,dir};});
    handle('create',async({root,brief}={})=>{const mod=await core();const contract=await model();const normalized=contract.validateCreativeBrief(brief);const resolved=fs.realpathSync(root);if(!roots.has(resolved))throw new Error('Choose your output folder first.');const dir=path.join(resolved,`${mod.slugify(normalized.topic)}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`);const project=mod.Project.create(dir,{brief:normalized,style:normalized.style,aspect:normalized.aspect});project.manifest.script=normalized.script||null;project.manifest.production={state:'draft',message:'Ready to create',scriptOrigin:normalized.script?'supplied':null,scriptApproved:false,voiceApproved:false};project.save();opened.add(path.resolve(dir));remember(project);return snapshot(dir);});
    handle('open',async(dir)=>{if(!dir){const choice=await dialogs.showOpenDialog({title:'Open a Story or Animation project folder',properties:['openDirectory']});if(choice.canceled)return {ok:false,canceled:true};dir=choice.filePaths[0];}const project=await loadProject(dir,{interrupt:true});opened.add(path.resolve(project.dir));remember(project);return snapshot(project.dir);});
    handle('recent',async()=>({ok:true,projects:recents()}));
    handle('save-tracker-template',async()=>{
      if(!fs.existsSync(trackerTemplate))throw new Error('The Vidmyo Tracker template is missing from this installation.');
      const choice=await dialogs.showSaveDialog({title:'Save the Vidmyo Tracker template',defaultPath:'Vidmyo Video Tracker.csv',filters:[{name:'CSV spreadsheet',extensions:['csv']}]});
      if(choice.canceled||!choice.filePath)return {ok:false,canceled:true};
      fs.copyFileSync(trackerTemplate,choice.filePath);
      return {ok:true,path:choice.filePath};
    });
    handle('voicebox-status',async()=>deps.voiceboxStatus?deps.voiceboxStatus():voiceboxStatus());
    handle('get',async(dir)=>snapshot(check(dir)));
    handle('import-flow-images',async(dir)=>{
      dir=check(dir);if(active.has(dir))throw new Error('Wait for the current production operation to finish.');
      const mod=await core();const contract=await model();const project=await loadProject(dir);const brief=contract.validateCreativeBrief({...project.manifest.brief,script:project.manifest.script||project.manifest.brief.script});
      if(brief.kind!=='story'||mod.getCreativeImageSource(brief.imageSource).id!=='flow')throw new Error('Choose Google Flow in a Story project before importing Flow images.');
      const planFile=path.join(project.dir,'artifacts','animation-plan.json');const plan=contract.validateAnimationPlan(readJson(planFile),{style:brief.style,characterAnimation:brief.characterAnimation});
      if(brief.style==='documentary-map'||plan.scenes.some((scene)=>scene.layers?.length))throw new Error('This Flow import supports the one-image-per-scene Story workflow.');
      project.manifest.brief=brief;project._creativePlan=plan;const queue=writeFlowQueue(project,plan,brief,mod);
      const choice=await dialogs.showOpenDialog({title:'Choose Curio Flow Queue images',message:`Choose the images folder downloaded for ${queue.projectId}, or select individual sNNN images.`,properties:['openFile','openDirectory','multiSelections'],filters:[{name:'Flow images',extensions:['png','jpg','jpeg','webp']} ]});
      if(choice.canceled)return {ok:false,canceled:true};
      const files=collectFlowImages(choice.filePaths||[],queue);const source=mod.getCreativeImageSource('flow');const imageModel=mod.resolveCreativeImageModel(source.id,brief.imageModel);
      let copied=0;const missing=[];
      for(const scene of plan.scenes){
        const input=files.get(scene.id);if(!input){missing.push(scene.id);continue;}
        const ext=path.extname(input).toLowerCase();const output=path.join(project.dir,'images',`flow-${scene.id}${ext}`);fs.mkdirSync(path.dirname(output),{recursive:true});fs.copyFileSync(input,output);
        scene.asset=relativeIn(project.dir,output);scene.assetFingerprint=expectedAssetFingerprint(brief,scene,scene,source,imageModel,contract);delete scene.jobId;copied+=1;
      }
      atomicJson(planFile,{version:1,scenes:plan.scenes});project.manifest.production.assetsDone=missing.length===0;
      const message=missing.length?`Imported ${copied} image${copied===1?'':'s'}. Still missing: ${missing.join(', ')}.`:`Imported ${copied} Flow images. Continue to render your video.`;
      setState(project,'flow-images',message);
      return snapshot(project.dir);
    });
    handle('save',async(dir,brief)=>{dir=check(dir);if(active.has(dir))throw new Error('Stop production before editing.');const contract=await model();const project=await loadProject(dir);const old=project.manifest.brief;const normalized=contract.validateCreativeBrief(brief);const priorScript=project.manifest.script||'';const nextScript=normalized.script||'';const wasScriptReview=project.manifest.production?.state==='review-script';const generatedInputsChanged=!same([old.topic,old.details,old.durationSec,old.language,old.provider],[normalized.topic,normalized.details,normalized.durationSec,normalized.language,normalized.provider]);
      if(nextScript!==priorScript){project.manifest.script=nextScript||null;project.manifest.production.scriptOrigin=nextScript?'supplied':null;clearArtifacts(project,{voice:true,plan:true});project.manifest.production.scriptApproved=false;if(wasScriptReview&&nextScript){project.manifest.production.state='review-script';project.manifest.production.message='Your edited script is ready to approve';}}
      else if(project.manifest.production.scriptOrigin==='generated'&&generatedInputsChanged)clearArtifacts(project,{script:true});
      else{const voiceChanged=!same([old.language,old.narration,old.voiceProvider,old.voiceboxVoiceId,old.kokoroVoiceId],[normalized.language,normalized.narration,normalized.voiceProvider,normalized.voiceboxVoiceId,normalized.kokoroVoiceId]);const visualChanged=!same([old.style,old.aspect,old.durationSec,old.characterAnimation,old.characterDesign],[normalized.style,normalized.aspect,normalized.durationSec,normalized.characterAnimation,normalized.characterDesign]);const imageChanged=!same([old.imageSource,old.imageModel],[normalized.imageSource,normalized.imageModel]);if(voiceChanged)clearArtifacts(project,{voice:true});else if(visualChanged||generatedInputsChanged)clearArtifacts(project,{plan:true});else if(imageChanged){const planFile=path.join(project.dir,'artifacts','animation-plan.json');try{const plan=readJson(planFile);for(const scene of plan.scenes||[]){for(const target of [scene,...(scene.layers||[])]){delete target.asset;delete target.assetFingerprint;delete target.jobId;}}atomicJson(planFile,plan);}catch{}try{fs.unlinkSync(path.join(project.dir,'artifacts','flow-image-queue.json'));}catch{}project.manifest.production.flowQueue=null;project.manifest.production.assetsDone=false;project.manifest.production.output=null;project.manifest.production.renderFingerprint=null;project.manifest.production.state='draft';project.manifest.production.message='Ready to create';}}
      project.manifest.brief={...normalized,script:project.manifest.script||''};project.manifest.style=normalized.style;project.manifest.aspect=normalized.aspect;project.save();remember(project);return snapshot(dir);});
    handle('start',async(dir,options={})=>{dir=check(dir);if(active.has(dir))throw new Error('This video is already being created.');const cancelFile=path.join(dir,'.vidmyo','creative.cancel');fs.mkdirSync(path.dirname(cancelFile),{recursive:true});try{fs.unlinkSync(cancelFile);}catch{}const job={cancelled:false,child:null,cloud:null,cancelFile,controller:new AbortController()};active.set(dir,job);try{await produce(dir,options);}catch(error){const project=await loadProject(dir);if(error instanceof Cancelled||job.cancelled)setState(project,'cancelled',error.message||'Production stopped.',{resumeState:project.manifest.production?.state});else if(!String(project.manifest.production?.state).startsWith('review-'))setState(project,'error',error.message,{resumeState:project.manifest.production?.state});}finally{active.delete(dir);try{fs.unlinkSync(cancelFile);}catch{}}return snapshot(dir);});
    handle('cancel',async(dir)=>{dir=check(dir);const job=active.get(dir);if(job){job.cancelled=true;job.controller.abort();fs.writeFileSync(job.cancelFile,'cancel');if(job.cloud){const saved=job.cloud.store.get(job.cloud.id);if(saved&&['queued','running'].includes(saved.state))job.cloud.store.cancel(job.cloud.id);}job.child?.kill('SIGTERM');emit(dir,'Stopping after the current provider operation');}return {ok:true};});
    handle('reveal',async(dir)=>{dir=check(dir);await (deps.shell||shell).openPath(dir);return {ok:true};});
    return true;
  }
  function stop(){for(const [dir,job] of active){job.cancelled=true;job.controller.abort();try{fs.writeFileSync(job.cancelFile,'cancel');}catch{}if(job.cloud){try{const saved=job.cloud.store.get(job.cloud.id);if(saved&&['queued','running'].includes(saved.state))job.cloud.store.cancel(job.cloud.id);}catch{}}job.child?.kill('SIGTERM');active.delete(dir);}media.close?.();}
  return {register,stop,snapshot,authorizeRoot:(dir)=>roots.add(fs.realpathSync(dir)),authorizeProject:(dir)=>opened.add(path.resolve(dir))};
}

let singleton;
function register(){singleton=createCreativeBridge();singleton.register();}
function stop(){singleton?.stop();}
module.exports={createCreativeBridge,register,stop};
