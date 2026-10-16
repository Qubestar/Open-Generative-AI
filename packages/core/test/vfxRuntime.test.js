import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createVfxRuntime}=createRequire(import.meta.url)('../../../electron/lib/vfxRuntime.js');
function harness() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vfx-auto-')),engine=path.join(dir,'engine'),root=path.join(dir,'app-data/vfx-runtime');
  fs.mkdirSync(path.join(engine,'renderer'),{recursive:true});fs.writeFileSync(path.join(engine,'renderer/package.json'),'{}');fs.writeFileSync(path.join(engine,'renderer/setup.mjs'),'// bootstrap');
  let calls=0,fail=false;
  const rt=createVfxRuntime({engine,root,npmCli:'/bundled/npm-cli.js',run:async()=>{
    calls++;await new Promise(resolve=>setImmediate(resolve));if(fail)throw new Error('offline');
    const modules=path.join(root,'renderer/node_modules'),binDir=path.join(modules,'@remotion/compositor');
    fs.mkdirSync(binDir,{recursive:true});fs.mkdirSync(path.join(modules,'@remotion/cli'),{recursive:true});fs.mkdirSync(path.join(modules,'.remotion'),{recursive:true});
    for(const name of ['ffmpeg','ffprobe'])fs.writeFileSync(path.join(binDir,name+(process.platform==='win32'?'.exe':'')),'tool');
    fs.writeFileSync(path.join(modules,'@remotion/cli/remotion-cli.js'),'cli');return JSON.stringify({binDir});
  }});
  return {rt,root,engine,calls:()=>calls,fail:value=>{fail=value;},close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('Automatic preparation shares concurrent work and reuses verified components',async()=>{const h=harness();try{await Promise.all([h.rt.ensure(),h.rt.ensure()]);assert.equal(h.calls(),1);assert(h.rt.status());await h.rt.ensure();assert.equal(h.calls(),1);}finally{h.close();}});
test('Failed preparation remains retryable without a new folder choice',async()=>{const h=harness();try{h.fail(true);await assert.rejects(h.rt.ensure(),/offline/);assert.equal(h.rt.status(),null);h.fail(false);await h.rt.ensure();assert(h.rt.status());assert.equal(h.calls(),2);}finally{h.close();}});
test('Missing tools and changed renderer invalidate readiness',async()=>{const h=harness();try{await h.rt.ensure();fs.unlinkSync(path.join(h.rt.status().binDir,'ffprobe'+(process.platform==='win32'?'.exe':'')));assert.equal(h.rt.status(),null);await h.rt.ensure();fs.writeFileSync(path.join(h.engine,'renderer/package.json'),'{"version":2}');assert.equal(h.rt.status(),null);await h.rt.ensure();assert.equal(h.calls(),3);}finally{h.close();}});
test('Preparation protects unrelated storage contents',async()=>{const h=harness();try{fs.mkdirSync(path.join(h.root,'renderer'),{recursive:true});await assert.rejects(h.rt.ensure(),/unrelated/);assert.equal(h.calls(),0);}finally{h.close();}});

test('Independent studios share one preparation for the same runtime folder',async()=>{
  const h=harness();try{
    const second=createVfxRuntime({engine:h.engine,root:h.root,run:async()=>{throw new Error('Duplicate preparation');}});
    await Promise.all([h.rt.ensure(),second.ensure()]);
    assert.equal(h.calls(),1);assert(second.status());
  }finally{h.close();}
});
