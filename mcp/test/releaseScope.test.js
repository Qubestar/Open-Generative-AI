import test from 'node:test';
import assert from 'node:assert/strict';
import {registerTools} from '../lib/tools.js';
test('release MCP omits all parked Video Delta engine and publishing tools',()=>{
  const names=new Set();
  registerTools({tool:name=>names.add(name),registerTool:name=>names.add(name)},{repurposeService:{},cleanerService:{}});
  for(const name of ['list_capabilities','create_video','create_film','reframe','publish_video','list_publish_status','insert_element','get_job'])assert.equal(names.has(name),false,name);
  for(const name of ['generate_image','generate_video','story_run_stage','cleaner_get'])assert.equal(names.has(name),true,name);
});
