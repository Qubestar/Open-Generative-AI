import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createElevenLabsNarration,splitNarration}=createRequire(import.meta.url)('../../../electron/lib/creativeNarration.js');

test('Multilingual narration requires explicit host approval before any provider request',async()=>{
 let calls=0;
 await assert.rejects(createElevenLabsNarration({text:'Dzień dobry',outWav:'/tmp/voice.wav',key:'test',fetchImpl:async()=>{calls++;}}),/Approve/);
 assert.equal(calls,0);
});

test('Completed narration response survives failed conversion without another paid request',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'creative-narration-'));let calls=0,fail=true;
 const input={text:'Dzień dobry. To opowieść o rzekach.',outWav:path.join(dir,'voiceover.wav'),key:'test-key',approved:true,
  fetchImpl:async(_url,opts)=>{calls++;assert.equal(JSON.parse(opts.body).model_id,'eleven_multilingual_v2');return {ok:true,arrayBuffer:async()=>Buffer.alloc(100)};},
  run:async(_cmd,args)=>{if(fail)throw new Error('converter unavailable');fs.writeFileSync(args.at(-1),Buffer.alloc(100));}};
 try {await assert.rejects(createElevenLabsNarration(input),/converter unavailable/);fail=false;const result=await createElevenLabsNarration(input);assert.equal(calls,1);assert.equal(result.source,'elevenlabs');assert(fs.existsSync(input.outWav));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Narration abort prevents network activity and invalid voice IDs are rejected',async()=>{
 let calls=0;const controller=new AbortController();controller.abort();
 const input={text:'Hello',outWav:'/tmp/voice.wav',key:'test',approved:true,run:async()=>{},fetchImpl:async()=>{calls++;}};
 await assert.rejects(createElevenLabsNarration({...input,signal:controller.signal}),/abort/i);
 await assert.rejects(createElevenLabsNarration({...input,voiceId:'../bad'}),/Invalid/);
 assert.equal(calls,0);
});

test('Long-form narration splits at sentence boundaries below API limits',()=>{
 const text=('A sentence about a river. ').repeat(900);
 const chunks=splitNarration(text);
 assert(chunks.length>1);assert(chunks.every(c=>c.length<=9000));
 assert.equal(chunks.join(' '),text.trim());
});

test('A partial long narration resumes only the missing chunks and concatenates in order',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'creative-narration-chunks-'));let requests=0,fail=true;
 const text='First sentence. '.repeat(700);const count=splitNarration(text).length;
 const input={text,outWav:path.join(dir,'voiceover.wav'),key:'test-key',approved:true,
  fetchImpl:async()=>{requests++;if(fail&&requests===2)return {ok:false,status:503};return {ok:true,arrayBuffer:async()=>Buffer.alloc(100)};},
  run:async(_cmd,args)=>{assert.equal(args.filter(a=>a==='-i').length,count);assert(args.includes(`[0:a][1:a]concat=n=${count}:v=0:a=1[a]`));fs.writeFileSync(args.at(-1),Buffer.alloc(100));}};
 try {await assert.rejects(createElevenLabsNarration(input),/HTTP 503/);fail=false;await createElevenLabsNarration(input);assert.equal(requests,count+1);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
