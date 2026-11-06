// Real offline render + narration mux + hostile-frame isolation check.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderCodeFilm } from '../../packages/core/pipelines/code-animation/render.mjs';
import { wavDurationSeconds } from '../../packages/core/src/animation.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dir = path.join(repo, '.tmp', 'animations-render-smoke');
fs.mkdirSync(dir, { recursive: true });
let requests = 0;
const server = http.createServer((_req, res) => { requests++; res.end('egress should be blocked'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const voice = process.env.VIDMYO_QA_NARRATION || path.join(dir, 'voiceover.wav');
if (!process.env.VIDMYO_QA_NARRATION) {
  const rate = 24000, samples = rate * 2, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i=0;i<samples;i++) wav.writeInt16LE(Math.round(Math.sin(i/rate*440*Math.PI*2)*1200),44+i*2);
  fs.writeFileSync(voice, wav);
}
const duration = wavDurationSeconds(fs.readFileSync(voice));
const html = `<!doctype html><html><body><canvas id="film" width="640" height="360"></canvas><script>
const c=document.getElementById('film'),g=c.getContext('2d');let checked=false;
function line(points,color,width){g.strokeStyle=color;g.lineWidth=width;g.lineCap='round';g.beginPath();points.forEach((p,i)=>i?g.lineTo(...p):g.moveTo(...p));g.stroke()}
window.renderFrame=async function(t){
 if(!checked){checked=true;let escaped=false;try{void parent.document.body;escaped=true}catch{}if(escaped)throw Error('Sandbox escaped');
 let network=false;try{await fetch('http://127.0.0.1:${server.address().port}/probe');network=true}catch{}if(network)throw Error('Network escaped');}
 const p=Math.min(1,t/${duration}),grow=Math.max(0,Math.min(1,(p-.15)/.75));
 g.fillStyle='#f5f0e4';g.fillRect(0,0,640,360);g.fillStyle='#777568';g.font='11px sans-serif';g.fillText('VIDMYO / CODE ANIMATION / LOCAL VOICEOVER',34,32);
 g.fillStyle='#26372c';g.font='bold 30px sans-serif';g.fillText('One seed. A whole forest.',34,77);
 line([[40,282],[600,282]],'#c7bba3',2);
 const root=Math.min(1,p*3);for(let i=0;i<5;i++){const x=320+(i-2)*26*root;line([[320,281],[x,285+38*root],[x+(i-2)*8,295+45*root]],'#ad895f',2)}
 g.fillStyle='#8e6242';g.beginPath();g.ellipse(320,280,12,6,-.2,0,7);g.fill();
 const top=276-grow*142;line([[320,279],[318,top+50],[324,top]],'#4c7658',5);
 for(let i=0;i<6;i++){const age=Math.max(0,Math.min(1,grow*2-i*.16));const x=320+(i%2?1:-1)*31*age,y=top+17+i*17;g.save();g.translate(x,y);g.rotate(i%2?.55:-.55);g.fillStyle=i%2?'#78966a':'#597b51';g.beginPath();g.ellipse(0,0,27*age,10*age,0,0,7);g.fill();g.restore()}
 g.fillStyle='#d8a947';g.beginPath();g.arc(518,140,22,0,7);g.fill();
 for(let i=0;i<7;i++){const a=i/7*6.28+t*.12;line([[518+Math.cos(a)*30,140+Math.sin(a)*30],[518+Math.cos(a)*38,140+Math.sin(a)*38]],'#d8a947',2)}
 g.fillStyle='#52694f';g.font='14px sans-serif';g.fillText(p<.32?'01 / Take root':p<.7?'02 / Reach for the light':'03 / Turn sunlight into growth',34,327);
 g.fillStyle='#4f7159';g.fillRect(34,342,572*p,3);
};</script></body></html>`;
const codeFile = path.join(dir, 'code-animation.json');
fs.writeFileSync(codeFile, JSON.stringify({ html }));
try {
  const evidence = await renderCodeFilm({ width: 640, height: 360, fps: 12, durationSec: duration, codeFile, voice, output: path.join(dir, 'animation.mp4') });
  assert.equal(requests, 0, 'Generated code contacted a network endpoint');
  assert(evidence.audio); assert.equal(evidence.width, 640); assert.equal(evidence.height, 360);
  const frames = fs.readdirSync(dir).filter(name => /^code-preview-\d+\.png$/.test(name));
  const hashes = frames.map(name => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex'));
  assert.equal(new Set(hashes).size, 3, 'The generated film must contain changing frames');
  const result = { exitCode: 0, ...evidence, networkRequests: requests, differentPreviewFrames: hashes.length, file: path.join(dir, 'animation.mp4') };
  fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify({ exitCode: 1, error: error.message }));
  throw error;
} finally { await new Promise(resolve => server.close(resolve)); }
