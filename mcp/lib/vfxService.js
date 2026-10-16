import {formatVfxRunLog} from '../../packages/core/index.js';
// Direct agent workflow: inspect a desktop-created project and submit editorial
// intent. Human review/render stays in the VFX desktop section.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {DEFAULT_REPURPOSE_ENGINE_DIR, DEFAULT_REPURPOSE_PYTHON} from '../../packages/core/index.js';
const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/vfx-engine');
export function createVfxMcpService({python=DEFAULT_REPURPOSE_PYTHON,repurposeEngineDir=DEFAULT_REPURPOSE_ENGINE_DIR,vfxEngineDir=engineDir,execute=execFile}={}) {
  const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
  function open(projectDir) {
    if(typeof projectDir!=='string'||!path.isAbsolute(projectDir))throw new Error('project_dir must be absolute');
    const dir=path.resolve(projectDir),manifest=read(path.join(dir,'vfx.json'));
    if(manifest.kind!=='vfx'||manifest.version!==1)throw new Error('Not a VFX project');
    const intake=read(path.join(dir,'artifacts/vfx-intake.json'));
    const transcript=read(path.join(dir,'artifacts/transcript-artifact.v1.json'));
    let spec=null;try{spec=read(path.join(dir,'artifacts/vfx-spec.json'));}catch{}
    return {dir,manifest,intake,transcript,spec,director:path.join(vfxEngineDir,'director/DIRECTOR.md'),motion:path.join(vfxEngineDir,'director/MOTION.md'),schema:path.join(vfxEngineDir,'schemas/edit-decision-spec.schema.json'),referenceBoard:path.join(vfxEngineDir,'themes/boards',`${manifest.brand.theme}-board.png`),next:'Read the director and motion rules and inspect shot thumbnails. Submit a complete plan; the human reviews and renders in VFX. No nested agent/API call is made.'};
  }
  return {open,async submitPlan(projectDir,spec) {
    const current=open(projectDir);
    if(!current.intake.reviewed)throw new Error('Confirm shots and cuts in VFX first');
    if(JSON.stringify(spec).length>200000)throw new Error('Plan is too large');
    const input=path.join(current.dir,'artifacts',`vfx-mcp-input-${Date.now()}.json`);
    fs.writeFileSync(input,JSON.stringify(spec),{mode:0o600});
    try {
      await new Promise((resolve,reject)=>execute(python,['-m','vidmyo_repurpose.vfx','validate','--project',current.dir,'--engine',vfxEngineDir,'--input',input],{env:{...process.env,PYTHONPATH:path.join(repurposeEngineDir,'src')},timeout:60000,maxBuffer:1024*1024},(error,stdout,stderr)=>error?reject(new Error(String(stderr||error.message).slice(0,1000))):resolve(stdout)));
      const manifest={...current.manifest,state:'plan',output:null};const temp=path.join(current.dir,'vfx.json.tmp');fs.writeFileSync(temp,JSON.stringify(manifest,null,2),{mode:0o600});fs.renameSync(temp,path.join(current.dir,'vfx.json'));
      fs.writeFileSync(path.join(current.dir,'run-log.md'),formatVfxRunLog(manifest,current.intake,read(path.join(current.dir,'artifacts/vfx-spec.json'))),{mode:0o600});
      return {ok:true,eventCount:spec.events.length,next:'Refresh/open this project in the VFX tab, review the beat chart and use Approve plan and render.'};
    } finally {fs.unlinkSync(input);}
  }};
}
