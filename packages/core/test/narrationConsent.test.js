import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
const require=createRequire(import.meta.url);
const {confirmNarration}=require('../../../electron/lib/narrationConsent.js');
const request={modelId:'mock-model',voiceId:'mock-voice',text:'Test script'};
test('native narration confirmation is cancel-default and requires explicit approval',async()=>{
  for(const response of [0,undefined,-1])await assert.rejects(confirmNarration({showMessageBox:async options=>{assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);assert.match(options.detail,/separate ElevenLabs API credits/);return {response};}},request),/not approved/);
  await confirmNarration({showMessageBox:async()=>({response:1})},request);
});
test('narration dialog failure denies execution and backend checks before paid fetch',async()=>{
  await assert.rejects(confirmNarration({showMessageBox:async()=>{throw Error('dialog unavailable');}},request),/dialog unavailable/);
  const source=fs.readFileSync(new URL('../../../electron/lib/storyBridge.js',import.meta.url),'utf8');
  assert.ok(source.indexOf('await confirmNarration(dialog') < source.indexOf('const res = await fetch(`https://api.elevenlabs.io'));
});
