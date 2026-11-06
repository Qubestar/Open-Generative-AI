import test from 'node:test';
import assert from 'node:assert/strict';
import { registerAnimationTools } from '../lib/animationTools.js';

test('animation MCP exposes the complete no-prompt-copying workflow and forwards explicit style numbers',async()=>{
  const definitions=new Map();let created;
  const service={styles:args=>({styles:[{number:7,name:'Whiteboard Explainer'}]}),create:args=>{created=args;return {id:'fixture'}},get:()=>({}),setScript:()=>({}),prepare:()=>({}),codeTask:()=>({}),submitCode:()=>({}),render:()=>({}),job:()=>({}),cancel:()=>({})};
  registerAnimationTools({registerTool:(name,schema,fn)=>definitions.set(name,{schema,fn})},service);
  assert.equal(definitions.size,10);assert(definitions.has('animations_get_job'));assert(definitions.has('animations_submit_code'));
  const result=await definitions.get('animations_create').fn({project_dir:'/fixture/project',topic:'Seed',style:7});assert(!result.isError);assert.equal(created.style,7);
  assert.equal(definitions.get('animations_create').schema.inputSchema.duration_seconds.parse(1800),1800);
});
test('animation MCP reports failure without claiming output or exposing common token forms',async()=>{
  const definitions=new Map();registerAnimationTools({registerTool:(name,schema,fn)=>definitions.set(name,fn)},{render:()=>{throw Error('Bearer fake-test-token must not appear')}});
  const result=await definitions.get('animations_render')({project_dir:'/fixture'});assert.equal(result.isError,true);assert(!result.content[0].text.includes('fake-test-token'));
});
