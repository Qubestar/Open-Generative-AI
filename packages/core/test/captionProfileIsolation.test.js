import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rasterizeCaptionPng } from '../src/rendererAdapter.js';

test('caption Chrome launches use separate disposable profiles and never reuse a user profile', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidmyo-caption-profile-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const log=path.join(dir,'arguments.jsonl'),fake=path.join(dir,'chrome-fixture');
  fs.writeFileSync(fake,`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const output=args.find(x=>x.startsWith('--screenshot=')).slice('--screenshot='.length);
fs.writeFileSync(output,'explicit test fixture');
`,{mode:0o755});
  for(let i=0;i<2;i++)assert.equal(rasterizeCaptionPng({text:'Caption',canvasWidth:640,canvasHeight:360,yPos:280,outputPath:path.join(dir,`caption-${i}.png`),chromeBin:fake}).ok,true);
  const args=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  const profiles=args.map(list=>list.find(x=>x.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length));
  assert(profiles.every(Boolean));assert.notEqual(profiles[0],profiles[1]);
  for(const profile of profiles){assert.equal(path.dirname(profile),dir);assert.equal(fs.existsSync(profile),false);}
});
