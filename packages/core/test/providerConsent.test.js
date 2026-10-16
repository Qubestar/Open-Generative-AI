import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {confirmProviderGeneration}=require('../../../electron/lib/providerConsent.js');
const request={kind:'video',provider:'fal',model:'mock',params:{prompt:'Test',image:'data:image/png;base64,PRIVATE_BYTES'}};
test('provider native confirmation defaults to cancel and does not expose source bytes',async()=>{
  const approved=await confirmProviderGeneration({showMessageBox:async options=>{
    assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);
    assert.match(options.detail,/source media will be uploaded/);
    assert.doesNotMatch(options.detail,/PRIVATE_BYTES/);
    assert.match(options.detail,/separate API credits/);
    return {response:0};
  }},request);
  assert.equal(approved,false);
});
test('provider native confirmation accepts only the explicit approve button',async()=>{
  for(const response of [undefined,-1,2])assert.equal(await confirmProviderGeneration({showMessageBox:async()=>({response})},request),false);
  assert.equal(await confirmProviderGeneration({showMessageBox:async()=>({response:1})},request),true);
});
test('independent HTTP callers cannot open concurrent approval dialogs',async()=>{
  let finish;
  let calls=0;
  const dialog={showMessageBox:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
  const first=confirmProviderGeneration(dialog,request);
  assert.equal(await confirmProviderGeneration(dialog,request),false);
  assert.equal(calls,1);
  finish({response:0});
  assert.equal(await first,false);
  assert.equal(await confirmProviderGeneration({showMessageBox:async()=>({response:1})},request),true);
});
test('native dialog failure releases the shared approval lock',async()=>{
  await assert.rejects(confirmProviderGeneration({showMessageBox:async()=>{throw new Error('dialog unavailable');}},request),/unavailable/);
  assert.equal(await confirmProviderGeneration({showMessageBox:async()=>({response:0})},request),false);
});
