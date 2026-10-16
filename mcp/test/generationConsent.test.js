import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationConsent } from '../lib/generationConsent.js';
import { registerTools } from '../lib/tools.js';
const request=()=>({kind:'image',provider:'fal',model:'fal/mock',params:{prompt:'Fox',aspect_ratio:'1:1'}});
test('paid MCP generation fails closed without trusted human approval',async()=>{
  await assert.rejects(createGenerationConsent()(request()),/human confirmation/);
  for(const answer of [false,undefined,{approved:true}]) await assert.rejects(createGenerationConsent(async()=>answer)(request()),/not approved/);
});

test('pending review blocks concurrent prompt flooding and releases after denial',async()=>{
  let resolve; const guard=createGenerationConsent(()=>new Promise(r=>{resolve=r;}));
  const first=guard(request());
  await assert.rejects(guard(request()),/awaiting human review/);
  resolve(false);await assert.rejects(first,/not approved/);
});

test('actual generic MCP tools deny paid submissions before creating jobs or adapters',async()=>{
  const tools=new Map();let reviews=0;
  registerTools({tool:(name,description,schema,handler)=>tools.set(name,handler),registerTool:()=>{}}, {
    secrets:()=> 'mock-not-a-real-key',
    confirmGeneration:async r=>{reviews++;assert.equal(r.provider,'fal');return false;},
    repurposeService:{},cleanerService:{},
  });
  for(const name of ['generate_image','generate_video']) {
    const result=await tools.get(name)({prompt:'Fox',source:'fal',aspect:'16:9'});
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/not approved/);
  }
  assert.equal(reviews,2);
});
test('every generation prompts separately and approves exact request once',async()=>{
  let prompts=0;
  const guard=createGenerationConsent(async r=>{prompts++;assert.equal(r.params.prompt,'Fox');return true;});
  await guard(request());await guard(request());assert.equal(prompts,2);
});
test('mutation during review, callback errors and invalid requests cannot submit',async()=>{
  const original=request();
  await assert.rejects(createGenerationConsent(async()=>{original.model='changed';return true;})(original),/changed/);
  await assert.rejects(createGenerationConsent(async snapshot=>{snapshot.params.prompt='changed';return true;})(request()),/changed/);
  await assert.rejects(createGenerationConsent(async()=>{throw Error('dialog unavailable');})(request()),/dialog unavailable/);
  await assert.rejects(createGenerationConsent(async()=>true)({...request(),provider:'unknown'}),/unsupported/);
});
