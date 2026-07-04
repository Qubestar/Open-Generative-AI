#!/usr/bin/env node
// M2 acceptance: drive ONE real image job through @vidmyo/core with no UI.
//
//   FAL_KEY=... node scripts/live-image-test.mjs "a red fox in doodle style"
//
// Costs one fal.ai generation on your key (~$0.01–0.05 for flux/schnell).
// On success it prints the job record path and the artifact path.

import path from 'node:path';
import os from 'node:os';
import { JobStore, runJob, falAdapter } from '../packages/core/index.js';

const key = process.env.FAL_KEY;
if (!key) {
  console.error('Set FAL_KEY (fal.ai API key) — this test performs one paid generation.');
  process.exit(1);
}
const prompt = process.argv[2] || 'a red fox trotting through snow, minimal doodle style';
const model = process.env.FAL_MODEL || 'fal-ai/flux/schnell';

const store = new JobStore();
const outDir = path.join(os.homedir(), '.vidmyo', 'artifacts');
const job = store.create({ type: 'image', provider: 'fal', params: { prompt } });
console.log(`job ${job.id} → ${model} :: "${prompt}"`);

const done = await runJob(store, job.id, falAdapter({ model, key }), { outDir, pollMs: 1500 });
console.log(`state: ${done.state}`);
if (done.state === 'done') {
  console.log(`artifact: ${done.artifacts[0].path}`);
  console.log(`job file: ${path.join(store.dir, done.id + '.json')}`);
} else {
  console.error(`error: ${done.error}`);
  process.exit(1);
}
