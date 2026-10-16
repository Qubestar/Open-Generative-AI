import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateCreativeBrief, validateAnimationPlan, creativeAssetFingerprint, normalizeCreativeManifest} from '../src/animation.js';
import {validateCharacters, speechEnvelopeFromPcm} from '../src/stickman.js';
import {characterPose} from '../../animation-engine/renderer/stickmanMotion.mjs';
import {mergeCreativeBrief} from '../../studio/src/creativeStudioModel.mjs';

const character = {id:'host',x:.3,endX:.7,y:.8,scale:.35,shirt:'blue',skin:'paper',facing:'right',expression:'happy',action:'talk'};
const scene = {id:'s001',headline:'Hello',visual:'An empty room',durationSec:5,locations:[],layers:[],characters:[character]};
const brief = {kind:'story',topic:'Hello',aspect:'9:16',durationSec:5,provider:{id:'codex'},characterAnimation:'animated'};

test('animation is opt-in and persists across validation and reopen without changing legacy project kind', () => {
  assert.equal(validateCreativeBrief(brief).characterAnimation, 'animated');
  assert.equal(validateCreativeBrief({...brief,characterAnimation:undefined}).characterAnimation, 'static');
  assert.equal(mergeCreativeBrief('story',brief).characterAnimation, 'animated');
  const manifest={version:1,name:'Hello',style:'doodle-v1',brief};
  normalizeCreativeManifest(manifest);
  assert.equal(manifest.brief.kind,'story');
  assert.equal(manifest.brief.characterAnimation,'animated');
  assert.throws(()=>validateCreativeBrief({...brief,characterAnimation:'remote-ai'}),/animated/);
});

test('character planning rejects malformed rigs, absent characters, unsafe placements and simultaneous speakers', () => {
  assert.deepEqual(validateAnimationPlan({scenes:[scene]},{style:'doodle-v1',characterAnimation:'animated'}).scenes[0].characters,validateCharacters([character]));
  for (const changes of [{x:NaN},{scale:4},{action:'eval'},{id:'../x'},{skin:'url(x)'},{y:'0.8'}]) {
    assert.throws(()=>validateCharacters([{...character,...changes}]),/character/i);
  }
  assert.throws(()=>validateCharacters([character,{...character,id:'guest'}]),/talking/);
  assert.throws(()=>validateCharacters([character,character]),/unique/);
  assert.throws(()=>validateAnimationPlan({scenes:[{...scene,characters:undefined}]},{characterAnimation:'animated'}),/1–3/);
});

test('animated backgrounds cannot reuse an existing complete illustration cache entry', () => {
  const args=['doodle-v1','9:16',scene];
  const old=creativeAssetFingerprint(...args);
  assert.equal(creativeAssetFingerprint(...args,{characterAnimation:'static'}),old);
  assert.notEqual(creativeAssetFingerprint(...args,{characterAnimation:'animated'}),old);
});

test('motion is deterministic, walking is bounded, and mouth stays closed without speech', () => {
  const quiet=characterPose(character,30,30,180,0);
  assert.equal(quiet.mouth,0);
  assert.deepEqual(quiet,characterPose(character,30,30,180,0));
  assert(characterPose(character,30,30,180,.8).mouth>0);
  assert.equal(characterPose({...character,action:'idle'},30,30,180,.8).mouth,0);
  const walk={...character,action:'walk'};
  assert.equal(characterPose(walk,0,30,180).x,.3);
  assert.equal(characterPose(walk,179,30,180).x,.7);
  assert.notEqual(characterPose(walk,4,30,180).leftLeg,characterPose(walk,10,30,180).leftLeg);
});

test('speech envelope follows final audio and keeps silence plus trailing frames closed', () => {
  const data=Buffer.alloc(8000*4);
  for(let i=2000;i<6000;i++)data.writeFloatLE(Math.sin(i*.2)*.2,i*4);
  const levels=speechEnvelopeFromPcm(data,60);
  assert.equal(levels.length,60);
  assert(levels.slice(0,7).every(value=>value===0));
  assert(levels.slice(8,21).every(value=>value>0));
  assert(levels.slice(23).every(value=>value===0));
  assert(levels.every(value=>Number.isFinite(value)&&value>=0&&value<=1));
});

test('studio design persists while legacy projects retain classic figures and cast colors stay stable', () => {
  assert.equal(validateCreativeBrief({...brief,characterDesign:'studio'}).characterDesign,'studio');
  assert.equal(validateCreativeBrief(brief).characterDesign,'classic');
  assert.throws(()=>validateCreativeBrief({...brief,characterDesign:'unknown'}),/design/);
  const plan=validateAnimationPlan({scenes:[scene,{...scene,id:'s002',characters:[{...character,shirt:'red',skin:'dark',expression:'concerned'}]}]},{characterAnimation:'animated'});
  assert.equal(plan.scenes[1].characters[0].shirt,'blue');
  assert.equal(plan.scenes[1].characters[0].skin,'paper');
  assert.equal(plan.scenes[1].characters[0].expression,'concerned');
});
