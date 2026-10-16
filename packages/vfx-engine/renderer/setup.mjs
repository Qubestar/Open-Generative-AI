// App bootstrap: Electron supplies Node/npm; app-owned packages supply media tools.
// No system npm, npx, ffmpeg or ffprobe is required. Safe to retry after failure.
import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, mkdirSync, writeFileSync, copyFileSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=dirname(fileURLToPath(import.meta.url));
function run(args, env={}) {
  const r=spawnSync(process.execPath,args,{cwd:ROOT,env:{...process.env,...env},encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});
  if(r.error||r.status!==0)throw new Error(String(r.stderr || r.error?.message || r.stdout || 'Preparation failed').trim());
}
try {
  const cli=process.env.VIDMYO_NPM_CLI;
  if(!cli||!existsSync(cli))throw new Error('The Vidmyo installation is missing its dependency installer. Reinstall Vidmyo.');
  // Scripts are unnecessary: compositor binaries are included in platform packages.
  // Running npm directly through Electron also avoids depending on a system Node.
  run([cli,'install','--ignore-scripts','--no-fund','--no-audit','--loglevel=error','--cache',join(ROOT,'..','.npm-cache')]);
  const modules=join(ROOT,'node_modules');
  const suffix=process.platform==='win32'?'.exe':'';
  const candidate=readdirSync(join(modules,'@remotion')).find(n=>n.startsWith(`compositor-${process.platform}-${process.arch}`)&&existsSync(join(modules,'@remotion',n,'ffmpeg'+suffix))&&existsSync(join(modules,'@remotion',n,'ffprobe'+suffix)));
  if(!candidate)throw new Error('This platform has no compatible VFX media tools.');
  // Remotion's reduced FFmpeg lacks scene/volume/PSNR filters used by inspection.
  // Run only this pinned package's download installer, never arbitrary npm scripts.
  const fullFfmpeg=join(modules,'ffmpeg-static','ffmpeg'+suffix);
  if(!existsSync(fullFfmpeg))run([join(modules,'ffmpeg-static/install.js')]);
  const compositorDir=join(modules,'@remotion',candidate);
  const binDir=join(ROOT,'..','tools');
  mkdirSync(binDir,{recursive:true});
  const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
  for(const name of ['ffmpeg','ffprobe']) {
    if(process.platform==='win32'){copyFileSync(name==='ffmpeg'?fullFfmpeg:join(compositorDir,name+suffix),join(binDir,name+suffix));for(const dll of readdirSync(compositorDir).filter(n=>n.endsWith('.dll')))copyFileSync(join(compositorDir,dll),join(binDir,dll));}
    if(process.platform!=='win32')writeFileSync(join(binDir,name),`#!/bin/sh\nexec env ${process.platform==='darwin'?'DYLD_LIBRARY_PATH':'LD_LIBRARY_PATH'}=${quote(compositorDir)} ${quote(name==='ffmpeg'?fullFfmpeg:join(compositorDir,name))} "$@"\n`,{mode:0o755});
    const r=spawnSync(join(binDir,name+suffix),['-version'],{encoding:'utf8',windowsHide:true});
    if(r.error||r.status!==0)throw new Error(`The VFX ${name} tool could not start.`);
  }
  run([join(modules,'@remotion/cli/remotion-cli.js'),'browser','ensure','--log=error']);
  rmSync(join(ROOT,'..','.npm-cache'),{recursive:true,force:true});
  process.stdout.write(JSON.stringify({binDir})+'\n');
} catch(e) {process.stderr.write('Could not prepare VFX: '+e.message+'\n');process.exit(1);}
