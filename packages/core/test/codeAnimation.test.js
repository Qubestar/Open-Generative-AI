import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Project, ANIMATION_STYLES, animationStyle, validateCreativeBrief, codeAnimationTask, produceCodeAnimation,
  creativeFingerprint, acquireAnimationLock, assertAnimationIdle, JobStore } from '../index.js';
import { createAnimationMcpService } from '../../../mcp/lib/animationService.js';
const require = createRequire(import.meta.url);
const { createZenborgBrowser, resolveZenborgRuntime, parseReply } = require('../../../electron/lib/zenborgBrowser.js');
const { createCreativeBridge } = require('../../../electron/lib/creativeBridge.js');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-code-test-'));
const html = '<!doctype html><html><body><canvas id="c"></canvas><script>window.renderFrame=function(t){document.body.style.background=t>1?"red":"blue"}</script></body></html>';
const brief = () => validateCreativeBrief({ kind:'animation', style:7, topic:'How a tree grows', aspect:'16:9', durationSec:5, provider:{id:'hermes'}, narration:false });
const create = () => { const dir=temp(); const b=brief(); const p=Project.create(dir,{brief:b,style:b.style});p.manifest.script='A tree starts with a seed.';p.manifest.production={state:'draft'};p.save();return p; };
const evidence = settings => { fs.writeFileSync(settings.output,Buffer.alloc(200));fs.writeFileSync(path.join(path.dirname(settings.codeFile),'code-render-evidence.json'),JSON.stringify({ok:true,exitCode:0,renderToken:settings.renderToken,durationSec:settings.durationSec,audio:!!settings.voice})); };

test('catalog preserves originals and provides unique stable numbers and actual source previews',()=>{
  assert.equal(ANIMATION_STYLES.length,170);assert.equal(new Set(ANIMATION_STYLES.map(s=>s.id)).size,170);
  assert.deepEqual(ANIMATION_STYLES.slice(0,3).map(s=>s.id),['editorial-collage','documentary-map','paper-stop-motion']);
  for(const [i,s] of ANIMATION_STYLES.entries()){assert.equal(s.number,i+1);assert.equal(animationStyle(s.number).id,s.id);if(s.engine==='code'){assert.match(s.preview,/^https:\/\//);assert(fs.existsSync(path.join(root,'packages/core/assets/animation-guides',s.id+'.md')));}}
});

test('Zenborg discovery uses the installed runner and matching app data before a source checkout',()=>{
  const runtime=resolveZenborgRuntime({repoRoot:'/fixture/Vidmyo',platform:'darwin',home:'/fixture/home',env:{},exists:()=>true});
  assert.equal(runtime.kind,'installed-app');assert.match(runtime.command,/Resources\/bin\/zenborg-node-runner$/);
  assert.equal(runtime.env.ZENBORG_DATA_DIR,'/fixture/home/Library/Application Support/Zenborg');
  assert.equal(runtime.env.MAIOX_DATA_DIR,runtime.env.ZENBORG_DATA_DIR);assert.match(runtime.args[0],/staged-node\/scripts\/zenborg-mcp.jsc$/);
  const explicit=resolveZenborgRuntime({repoRoot:'/fixture/Vidmyo',platform:'darwin',env:{VIDMYO_ZENBORG_MCP:'/chosen/zenborg-mcp.js',ZENBORG_DATA_DIR:'/chosen/data'},exists:()=>true});
  assert.equal(explicit.kind,'configured');assert.equal(explicit.env.ZENBORG_DATA_DIR,'/chosen/data');
  const fallback=resolveZenborgRuntime({repoRoot:'/fixture/Vidmyo',platform:'darwin',env:{},exists:file=>file==='/fixture/Maiox/scripts/zenborg-mcp.js'});
  assert.equal(fallback.kind,'source-checkout');assert.equal(fallback.dataDir,null);
});

test('a definitive unsupported browser route is reported distinctly and never blindly resubmitted',async()=>{
  let rejection;try{parseReply({isError:true,content:[{type:'text',text:'Harness browser-agent is disabled.'}]});}catch(error){rejection=error;}
  assert.equal(rejection.code,'HARNESS_DISABLED');assert.equal(rejection.definitiveRejected,true);
  assert.match(rejection.message,/ChatGPT was not contacted/);
  const p=create();p.manifest.brief.provider={id:'zenborg',model:'browser-profile'};let submits=0;
  const zenborg=createZenborgBrowser({repoRoot:root,configFile:path.join(p.dir,'config.json'),connectImpl:async()=>({close:async()=>{},call:async(name)=>{
    if(name==='zenborg_agents')return {agents:[{id:'browser-profile',harness:'browser-agent'}]};
    if(name==='zenborg_ask'){submits++;throw rejection;}
  }})});
  const args={project:p,phase:'script',task:{output:'script',durationSec:5}};
  await assert.rejects(zenborg.generate(args),/HARNESS_DISABLED/);assert.equal(submits,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir,'artifacts/zenborg-script.json'))).state,'rejected');
  await assert.rejects(zenborg.generate(args),/rejected the previous/);assert.equal(submits,1);
  const reset=await zenborg.retryFailed(p);assert.equal(reset.ok,true);
  await assert.rejects(zenborg.generate(args),/HARNESS_DISABLED/);assert.equal(submits,2);
});
test('code brief auto-selects Not needed and validates Zenborg profiles without changing legacy defaults',()=>{
  assert.equal(brief().imageSource,'not-needed');assert.equal(animationStyle(7).name,'Whiteboard Explainer');
  const b=brief();assert.equal(validateCreativeBrief({...b,provider:{id:'zenborg',model:'browser-chatgpt'}}).provider.model,'browser-chatgpt');
  assert.throws(()=>validateCreativeBrief({...b,style:'documentary-map',provider:{id:'zenborg',model:'browser-chatgpt'}}),/code animation/);
  assert.equal(validateCreativeBrief({...b,style:'paper-stop-motion',narration:undefined}).narration,false);
});
test('completion requires measured evidence, retry reuses code, and stale code is regenerated',async()=>{
  const p=create();let calls=0;
  const args={project:p,durationSec:5,direct:async()=>{calls++;return {html}},run:async()=>{},setState:(state)=>{p.manifest.production.state=state;p.save()}};
  await assert.rejects(produceCodeAnimation({...args,renderer:async s=>fs.writeFileSync(s.output,Buffer.alloc(200))}),/evidence/);
  assert.notEqual(p.manifest.production.state,'done');
  await assert.rejects(produceCodeAnimation({...args,renderer:async s=>{evidence(s);const file=path.join(path.dirname(s.codeFile),'code-render-evidence.json');const bad=JSON.parse(fs.readFileSync(file));bad.ok=false;fs.writeFileSync(file,JSON.stringify(bad));}}),/did not match/);
  await produceCodeAnimation({...args,renderer:evidence});assert.equal(calls,1);assert.equal(Project.load(p.dir).manifest.production.state,'done');
  p.manifest.brief.details='Different opening action';await produceCodeAnimation({...args,renderer:evidence});assert.equal(calls,2);
});
test('cross-process lock blocks a second writer and releases only its own nonce',()=>{
  const p=create(),release=acquireAnimationLock(p.dir);assert.throws(()=>assertAnimationIdle(p.dir),/already/);
  const module=fileURLToPath(new URL('../src/animationLock.js',import.meta.url));
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import {acquireAnimationLock} from ${JSON.stringify(module)};try{acquireAnimationLock(${JSON.stringify(p.dir)});process.exit(0)}catch{process.exit(3)}`],{encoding:'utf8'});
  assert.equal(result.status,3);release();assert.doesNotThrow(()=>assertAnimationIdle(p.dir));
});
test('MCP script writes read back expected state and invalidate stale render, with shared lock protection',()=>{
  const p=create(),service=createAnimationMcpService({store:new JobStore(path.join(temp(),'jobs'))});
  service.setScript(p.dir,'A new, original script.');assert.equal(Project.load(p.dir).manifest.script,'A new, original script.');
  const release=acquireAnimationLock(p.dir);assert.throws(()=>service.setScript(p.dir,'Blocked edit'),/already/);release();
  service.submitCode(p.dir,{html});assert.equal(Project.load(p.dir).manifest.production.codeFingerprint,creativeFingerprint(codeAnimationTask(p.manifest.brief,{durationSec:5,script:'A new, original script.',beats:[]})));
  service.setScript(p.dir,'Replacement script.');assert.equal(Project.load(p.dir).manifest.production.codeFingerprint,undefined);assert.equal(service.get(p.dir).output,null);
});
test('MCP cancellation of an old completed job cannot abort a newer render',async()=>{
  const p=create(),store=new JobStore(path.join(temp(),'jobs'));let finish;
  const service=createAnimationMcpService({store,renderImpl:async settings=>{await new Promise(resolve=>{finish=resolve});evidence(settings)}});
  const old=store.create({type:'animation-render',project:p.manifest.id,params:{projectDir:p.dir}});store.setState(old.id,'running',{admit:false});store.setState(old.id,'done');
  service.submitCode(p.dir,{html});const current=service.render(p.dir);
  while(!finish)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(service.cancel(old.id).state,'done');assert.equal(store.get(current.job_id).state,'running');finish();
  for(let i=0;i<100&&store.get(current.job_id).state==='running';i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(store.get(current.job_id).state,'done');
});

test('MCP recovers a dead process as interrupted without losing the script or creating another job',()=>{
  const p=create(),store=new JobStore(path.join(temp(),'jobs')),service=createAnimationMcpService({store});
  const job=store.create({type:'animation-render',project:p.manifest.id,params:{projectDir:p.dir,ownerPid:999999999}});store.setState(job.id,'running',{admit:false});
  const recovered=service.job(job.id);assert.equal(recovered.state,'error');assert.equal(recovered.project.state,'interrupted');
  assert.equal(Project.load(p.dir).manifest.script,'A tree starts with a seed.');assert.equal(store.list().length,1);
});
test('Zenborg durable receipt preserves the original run across local retries and failures',async()=>{
  const p=create();p.manifest.brief.provider={id:'zenborg',model:'browser-profile'};let submits=0,remoteState='completed';
  const zenborg=createZenborgBrowser({repoRoot:root,configFile:path.join(p.dir,'settings.json'),pollMs:1,connectImpl:async()=>({close:async()=>{},call:async(name,args)=>{
    if(name==='zenborg_agents')return {agents:[{id:'browser-profile',harness:'browser-agent',enabled:true}]};
    if(name==='zenborg_ask'){submits++;return {sessionId:'s1',runIds:['r1']};}
    if(name==='zenborg_run_status')return {run:{state:remoteState}};
    if(name==='zenborg_session_read')return {messages:[{runId:'r1',authorType:'agent',body:JSON.stringify({html})}]};
    throw Error(name);
  }})});
  const task={durationSec:5};const first=await zenborg.generate({project:p,phase:'code',task});assert.equal(first.html,html);
  await zenborg.generate({project:p,phase:'code',task});assert.equal(submits,1);
  remoteState='running';assert.equal((await zenborg.retryFailed(p)).ok,true);
  remoteState='failed';await assert.rejects(zenborg.generate({project:p,phase:'code',task}),/stopped/);assert.equal(submits,1);
  await zenborg.retryFailed(p);remoteState='completed';await zenborg.generate({project:p,phase:'code',task});assert.equal(submits,1);
  p.manifest.production={state:'error',resumeState:'rendering',codeFingerprint:'cached',planFingerprint:'cached',output:'old.mp4'};
  await zenborg.retryFailed(p);assert.equal(p.manifest.production.codeFingerprint,'cached');assert.equal(p.manifest.production.output,'old.mp4');
  await zenborg.generate({project:p,phase:'code',task});assert.equal(submits,1);
  for(const corrupt of ['{interrupted','null','{}','[]']){
    fs.writeFileSync(path.join(p.dir,'artifacts/zenborg-code.json'),corrupt);
    await assert.rejects(zenborg.generate({project:p,phase:'code',task}),/unreadable/);assert.equal(submits,1);
  }
  fs.writeFileSync(path.join(p.dir,'artifacts/zenborg-code.json'),JSON.stringify({version:1,phase:'code',fingerprint:'0'.repeat(64),state:'submitting'}));
  await assert.rejects(zenborg.generate({project:p,phase:'code',task}),/could not be confirmed/);assert.equal(submits,1);
});

test('completed but invalid Zenborg output cannot cause a second ask',async()=>{
  const p=create();p.manifest.brief.provider={id:'zenborg',model:'browser-profile'};let valid=false,submits=0;
  const zenborg=createZenborgBrowser({repoRoot:root,configFile:path.join(p.dir,'settings.json'),connectImpl:async()=>({close:async()=>{},call:async name=>{
    if(name==='zenborg_agents')return {agents:[{id:'browser-profile',harness:'browser-agent'}]};
    if(name==='zenborg_ask'){submits++;return {sessionId:'s1',runIds:['r1']};}
    if(name==='zenborg_run_status')return {run:{state:'completed'}};
    if(name==='zenborg_session_read')return {messages:[{runId:'r1',authorType:'agent',body:JSON.stringify(valid?{html}:{html:'incomplete'})}]};
  }})});
  const args={project:p,phase:'code',task:{durationSec:5}};
  await assert.rejects(zenborg.generate(args),/invalid animation code/);await assert.rejects(zenborg.generate(args),/invalid animation code/);assert.equal(submits,1);
  await assert.rejects(zenborg.retryFailed(p),/invalid/);valid=true;assert.equal((await zenborg.generate(args)).html,html);assert.equal(submits,1);
});

test('desktop code style uses the new renderer and never asks an image provider or legacy renderer',async()=>{
  const dir=temp(),handlers=new Map();let coded=0,rendered=0;
  const bridge=createCreativeBridge({repoRoot:root,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},app:{isPackaged:false,getPath:()=>dir},
    BrowserWindow:{getAllWindows:()=>[]},media:{grant:async file=>'fixture:'+file,close(){}},
    dialog:{showMessageBox:async()=>{throw Error('Unexpected image or API consent')},showOpenDialog:async()=>({canceled:true})},
    agents:{detectAll:async()=>[{id:'hermes',installed:true,authed:true,subscriptionReady:true,path:'/fixture/hermes'}]},getSecret:()=>null,
    renderer:{ensure:async()=>({ok:true}),status:()=>({binDir:dir})},
    codeDirector:async()=>{coded++;return {html}},codeRenderer:async settings=>{rendered++;evidence(settings)},
    renderVideo:async()=>{throw Error('Legacy renderer called')},generateImage:async()=>{throw Error('Image provider called')},
  });
  bridge.register();bridge.authorizeRoot(dir);
  const created=await handlers.get('creative:create')({}, {root:dir,brief:{...brief(),script:'A tree starts as a seed.'}});assert(created.ok,created.error);
  const mcpProject=Project.load(created.dir);mcpProject.manifest.production.state='planning';mcpProject.save();
  const release=acquireAnimationLock(created.dir);
  const beforeOpen=fs.readFileSync(path.join(created.dir,'project.json'),'utf8');
  const opened=await handlers.get('creative:open')({},created.dir);assert(opened.ok);assert.equal(opened.busy,true);assert.equal(opened.manifest.production.state,'planning');assert.equal(fs.readFileSync(path.join(created.dir,'project.json'),'utf8'),beforeOpen);
  const denied=await handlers.get('creative:zenborg-retry')({},created.dir);assert.equal(denied.ok,false);assert.match(denied.error,/already/);release();
  const finished=await handlers.get('creative:start')({},created.dir,{});assert(finished.ok,finished.error);
  assert.equal(finished.manifest.production.state,'done',finished.manifest.production.message);assert.equal(coded,1);assert.equal(rendered,1);assert.match(finished.previewUrl,/code-animation.mp4$/);
  await handlers.get('creative:start')({},created.dir,{});assert.equal(coded,1);assert.equal(rendered,1);bridge.stop();
});

for (const shape of ['string','text']) test('Zenborg new succeeded contract returns '+shape+' result without session lookup',async()=>{
  const p=create();p.manifest.brief.provider={id:'zenborg',model:'browser-profile'};let submits=0,polls=0;
  const zenborg=createZenborgBrowser({repoRoot:root,pollMs:1,connectImpl:async()=>({close:async()=>{},call:async(name)=>{
    if(name==='zenborg_agents')return {agents:[{id:'browser-profile',harness:'browser-agent'}]};
    if(name==='zenborg_ask'){submits++;return {runId:'durable-run'};}
    if(name==='zenborg_run_status'){polls++;return {run:{state:polls===1?'running':'succeeded',result:shape==='string'?JSON.stringify({html}):{text:JSON.stringify({html})}}};}
    throw Error('Unexpected session lookup or tool: '+name);
  }})});
  const args={project:p,phase:'code',task:{durationSec:5}};assert.equal((await zenborg.generate(args)).html,html);
  const receipt=JSON.parse(fs.readFileSync(path.join(p.dir,'artifacts/zenborg-code.json')));assert.equal(receipt.runId,'durable-run');
  await zenborg.retryFailed(p);await zenborg.generate(args);assert.equal(submits,1);assert.ok(polls>=3);
  await assert.rejects(zenborg.generate({...args,task:{durationSec:6}}),/different brief/);assert.equal(submits,1);
});

test('Zenborg NEEDS_USER_ACTION preserves run across restart and resumes polling without dispatch',async()=>{
  const p=create();p.manifest.brief.provider={id:'zenborg',model:'browser-profile'};let submits=0,needsLogin=true;
  const connectImpl=async()=>({close:async()=>{},call:async(name)=>{
    if(name==='zenborg_agents')return {agents:[{id:'browser-profile',harness:'browser-agent'}]};
    if(name==='zenborg_ask'){submits++;return {runId:'login-run'};}
    if(name==='zenborg_run_status')return {run:needsLogin?{state:'failed',error:{code:'NEEDS_USER_ACTION'}}:{state:'succeeded',result:JSON.stringify({script:'Narration after sign-in.'})}};
    throw Error(name);
  }});
  const args={project:p,phase:'script',task:{topic:'Example'}};const first=createZenborgBrowser({repoRoot:root,connectImpl});
  await assert.rejects(first.generate(args),e=>e.code==='NEEDS_USER_ACTION'&&/Browser Workers/.test(e.message));
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir,'artifacts/zenborg-script.json'))).state,'needs-user-action');
  const restarted=createZenborgBrowser({repoRoot:root,connectImpl});await restarted.retryFailed(p);needsLogin=false;
  assert.equal((await restarted.generate(args)).script,'Narration after sign-in.');assert.equal(submits,1);
});
