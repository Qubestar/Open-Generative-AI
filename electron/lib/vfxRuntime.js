// App-owned renderer preparation. Never asks users to manage npm or tool paths.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// VFX and Animations share one app-owned runtime, including first-time setup.
const preparations = new Map();

function createVfxRuntime({engine, root, run, npmCli}) {
  const runtimeKey = path.resolve(root);
  const signature = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(engine,'renderer/package.json'))).update(fs.readFileSync(path.join(engine,'renderer/setup.mjs'))).update(fs.existsSync(path.join(engine,'renderer/package-lock.json'))?fs.readFileSync(path.join(engine,'renderer/package-lock.json')):'').update(`${process.platform}-${process.arch}`).digest('hex');
  const marker = path.join(root,'.vidmyo-vfx-ready.json');
  function status() {
    try {
      const doc=JSON.parse(fs.readFileSync(marker,'utf8'));
      if(doc.signature!==signature() || !path.isAbsolute(doc.binDir) || !doc.binDir.startsWith(root+path.sep))return null;
      const suffix=process.platform==='win32'?'.exe':'';
      for(const tool of ['ffmpeg','ffprobe'])if(!fs.existsSync(path.join(doc.binDir,tool+suffix)))return null;
      if(!fs.existsSync(path.join(root,'renderer/node_modules/@remotion/cli/remotion-cli.js')) || !fs.existsSync(path.join(root,'renderer/node_modules/.remotion')))return null;
      return doc;
    } catch {return null;}
  }
  function ensure() {
    if(status())return Promise.resolve({ok:true});
    if(preparations.has(runtimeKey))return preparations.get(runtimeKey);
    const pending=(async()=> {
      const ownership=path.join(root,'.vidmyo-vfx-runtime.json');
      if(fs.existsSync(path.join(root,'renderer'))&&!fs.existsSync(ownership))throw new Error('The VFX storage folder contains unrelated files. Reinstall Vidmyo or contact support to repair its storage.');
      fs.mkdirSync(root,{recursive:true});fs.writeFileSync(ownership,JSON.stringify({version:1}));
      fs.cpSync(engine,root,{recursive:true,filter:p=>!p.split(path.sep).includes('node_modules')});
      const target=path.join(root,'renderer');
      const result=JSON.parse(await run('setup',process.execPath,[path.join(target,'setup.mjs')],{cwd:target,env:{ELECTRON_RUN_AS_NODE:'1',VIDMYO_NPM_CLI:npmCli || path.join(path.dirname(require.resolve('npm/package.json')),'bin/npm-cli.js')}}));
      const doc={signature:signature(),binDir:result.binDir};
      const temp=marker+'.tmp';fs.writeFileSync(temp,JSON.stringify(doc));fs.renameSync(temp,marker);
      if(!status())throw new Error('VFX preparation did not finish. Try preparation again.');
      return {ok:true};
    })().finally(()=>{preparations.delete(runtimeKey);});
    preparations.set(runtimeKey,pending);
    return pending;
  }
  return {ensure,status,root};
}
module.exports={createVfxRuntime};
