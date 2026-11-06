// Offline browser executor. Generated code runs only in a sandboxed opaque frame.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { resolveChromeBinary } from '../../src/rendererAdapter.js';
import { validateCodeAnimation } from '../../src/codeAnimation.js';

export async function renderCodeFilm(settings) {
  // The MCP runtime ships outside app.asar, alongside the external core.
  const require = createRequire(import.meta.url);
  const mcpDir = fileURLToPath(new URL('../../../../mcp/', import.meta.url));
  const { chromium } = require(require.resolve('playwright-core', { paths: [mcpDir] }));
  const { width, height, durationSec, fps, codeFile, output, voice } = settings;
  if (![width, height, fps, durationSec].every(Number.isFinite) || width < 64 || height < 64 || width > 3840 || height > 3840 || durationSec <= 0 || durationSec > 3600 || fps < 1 || fps > 60) throw new Error('Invalid code render dimensions or timing.');
  if (fs.statSync(codeFile).size > 3 * 1024 * 1024) throw new Error('Code file exceeds the render limit.');
  const { html } = validateCodeAnimation(JSON.parse(fs.readFileSync(codeFile, 'utf8')));
  const executablePath = process.env.VIDMYO_CHROME || resolveChromeBinary();
  if (!executablePath) throw new Error('Install Chrome/Chromium before rendering code animation.');
  const ffmpeg = process.env.VIDMYO_FFMPEG || 'ffmpeg';
  const ffprobe = process.env.VIDMYO_FFPROBE || 'ffprobe';
  const temp = output.replace(/\.mp4$/, '.partial.mp4');
  const evidenceFile = path.join(path.dirname(codeFile), 'code-render-evidence.json');
  fs.rmSync(evidenceFile, { force: true });
  for(const file of fs.readdirSync(path.dirname(codeFile))){
    if(/^code-preview-\d+\.png$/.test(file))fs.rmSync(path.join(path.dirname(codeFile),file));
  }
  let browser, encoder;
  try {
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, args: ['--disable-background-networking', '--disable-extensions', '--no-first-run'] });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url === 'about:blank' || url === 'about:srcdoc' || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      return route.abort('blockedbyclient');
    });
    await page.setContent('<!doctype html><html><body style="margin:0;overflow:hidden"><iframe id="film" sandbox="allow-scripts" style="border:0;display:block"></iframe></body></html>');
    await page.evaluate(({ html, width, height }) => {
      const frame = document.getElementById('film');
      frame.width = width; frame.height = height;
      window.__filmReady = false;
      window.__filmResults = {};
      window.addEventListener('message', event => {
        if (event.source !== frame.contentWindow) return;
        if (event.data?.type === 'ready') window.__filmReady = true;
        if (event.data?.type === 'frame') window.__filmResults[event.data.id] = event.data;
      });
      const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'">`;
      // Trusted boundary precedes generated markup. Later policies cannot relax it.
      const bridge = `<script>window.addEventListener('message',async function(e){if(e.source!==parent||e.data.type!=='seek')return;try{if(typeof window.renderFrame!=='function')throw Error('Missing window.renderFrame');await window.renderFrame(e.data.time);parent.postMessage({type:'frame',id:e.data.id},'*')}catch(err){parent.postMessage({type:'frame',id:e.data.id,error:String(err.message).slice(0,400)},'*')}});window.addEventListener('load',function(){parent.postMessage({type:'ready'},'*')});<\/script>`;
      frame.srcdoc = '<!doctype html>' + policy + `<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}</style>` + bridge + html;
    }, { html, width, height });
    await page.waitForFunction(() => window.__filmReady, null, { timeout: 15000 });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const args = ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0'];
    if (voice) args.push('-i', voice, '-map', '0:v:0', '-map', '1:a:0', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k');
    args.push('-t', String(durationSec), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temp);
    encoder = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let encoderError = '', processError = null;
    encoder.stderr.on('data', chunk => { encoderError = (encoderError + chunk).slice(-2000); });
    encoder.on('error', error => { processError = error; });
    encoder.stdin.on('error', error => { processError ||= error; });
    const closed = new Promise(resolve => encoder.once('close', code => resolve(code)));
    const totalFrames = Math.ceil(durationSec * fps);
    for (let frame = 0; frame < totalFrames; frame++) {
      if (processError || encoder.exitCode !== null) throw new Error(encoderError || processError?.message || 'Video encoder stopped.');
      await page.evaluate(({ id, time }) => document.getElementById('film').contentWindow.postMessage({ type: 'seek', id, time }, '*'), { id: frame, time: frame / fps });
      await page.waitForFunction(id => window.__filmResults[id], frame, { timeout: 5000 });
      const error = await page.evaluate(id => { const result = window.__filmResults[id]; delete window.__filmResults[id]; return result.error; }, frame);
      if (error) throw new Error('Animation frame failed: ' + error);
      const png = await page.screenshot({ type: 'png', animations: 'disabled' });
      if (!encoder.stdin.write(png)) await once(encoder.stdin, 'drain');
      if (frame === 0 || frame === Math.floor(totalFrames / 2) || frame === totalFrames - 1) fs.writeFileSync(path.join(path.dirname(codeFile), `code-preview-${frame}.png`), png);
    }
    encoder.stdin.end();
    if (await closed !== 0) throw new Error(encoderError || processError?.message || 'Video encoding failed.');
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', temp], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    const audio = probe.streams.find(stream => stream.codec_type === 'audio');
    const actual = Number(probe.format.duration);
    const [rateNum, rateDen] = String(video?.avg_frame_rate || '0/1').split('/').map(Number);
    if (!video || video.width !== width || video.height !== height || video.codec_name !== 'h264' || Math.abs(rateNum / rateDen - fps) > 0.01 || Math.abs(actual - durationSec) > 0.2 || (voice && (!audio || Math.abs(Number(audio.duration) - durationSec) > 0.2))) throw new Error('Rendered video dimensions, duration or narration stream are incorrect.');
    fs.renameSync(temp, output);
    const evidence = { ok: true, exitCode: 0, renderToken: settings.renderToken, width, height, fps, frames: totalFrames, durationSec: actual, audio: !!audio, bytes: fs.statSync(output).size };
    fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    encoder?.kill('SIGTERM');
    await browser?.close();
    fs.rmSync(temp, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await renderCodeFilm(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))))); }
  catch (error) { console.error(String(error.message).slice(0, 2000)); process.exitCode = 1; }
}
