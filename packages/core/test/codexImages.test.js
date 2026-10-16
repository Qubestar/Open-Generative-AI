import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {CREATIVE_IMAGE_SOURCES,getCreativeImageSource} from '../src/creativeImages.js';
import {IMAGE_SOURCES} from '../src/story.js';
const {generateCodexImage}=createRequire(import.meta.url)('../../../electron/lib/codexImages.js');
const png=()=>{const b=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.write('IHDR',12);b.writeUInt32BE(1024,16);b.writeUInt32BE(1536,20);return b;};
const agents={detectAll:async()=>[{id:'codex',path:'/codex',installed:true,subscriptionReady:true}]};

test('subscription source stays separate from legacy API catalog',()=>{
 assert(CREATIVE_IMAGE_SOURCES.some(s=>s.id==='codex-images'));
 assert(!IMAGE_SOURCES.some(s=>s.id==='codex-images'));
 assert.equal(getCreativeImageSource('codex-images').subscription,true);
});
test('native Codex image request isolates workspace, removes API key and reuses saved output',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-images-'));let submits=0;
 try{
  const options={projectDir:root,fingerprint:'a'.repeat(64),prompt:'empty room',agents,run:async(_dir,_exe,args,opts)=>{
   if(args[0]==='features')return 'image_generation stable true\n';
   submits++;assert(args.includes('--ignore-user-config'));assert(args.includes('workspace-write'));assert.equal(opts.env.OPENAI_API_KEY,undefined);
   fs.writeFileSync(path.join(opts.cwd,'image.png'),png());return '';
  }};
  const file=await generateCodexImage(options);assert(fs.existsSync(file));await generateCodexImage(options);assert.equal(submits,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('interrupted native image request never silently spends allowance again',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-images-'));let submits=0;
 try{
  const options={projectDir:root,fingerprint:'b'.repeat(64),prompt:'room',agents,run:async(_dir,_exe,args)=>{if(args[0]==='features')return 'image_generation stable true';submits++;throw Error('interrupted');}};
  await assert.rejects(generateCodexImage(options),/interrupted/);
  await assert.rejects(generateCodexImage(options),/already started/);assert.equal(submits,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
