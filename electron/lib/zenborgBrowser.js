// Talks to the installed Zenborg MCP runner; Vidmyo never reads its credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
function resolveZenborgRuntime({repoRoot,config={},env=process.env,platform=process.platform,home=os.homedir(),exists=fs.existsSync}={}){
  const explicit=config.script||env.VIDMYO_ZENBORG_MCP;
  const dataOverride=config.dataDir||env.ZENBORG_DATA_DIR||env.MAIOX_DATA_DIR;
  const makeEnv=dataDir=>({...env,...(dataDir?{ZENBORG_DATA_DIR:dataDir,MAIOX_DATA_DIR:dataDir}:{}),ELECTRON_RUN_AS_NODE:'1'});
  if(explicit){
    if(!path.isAbsolute(explicit)||!exists(explicit))throw new Error('The configured Zenborg connector was not found. Locate Zenborg again.');
    return {command:process.execPath,args:[explicit],env:makeEnv(dataOverride),kind:'configured',dataDir:dataOverride||null};
  }
  if(platform==='darwin'){
    const resources='/Applications/Zenborg.app/Contents/Resources';
    const runner=path.join(resources,'bin/zenborg-node-runner');
    const appRoot=path.join(resources,'app.asar.unpacked/dist-desktop/staged-node');
    const script=path.join(appRoot,'scripts/zenborg-mcp.jsc');
    const dataDir=dataOverride||path.join(home,'Library/Application Support/Zenborg');
    if(exists(runner)&&exists(script)&&exists(path.join(dataDir,'collab/cli-credential'))){
      return {command:runner,args:[script],env:{...makeEnv(dataDir),ZENBORG_NODE_RUNNER:runner,ZENBORG_APP_ROOT:appRoot},kind:'installed-app',dataDir};
    }
  }
  const script=path.resolve(repoRoot,'../Maiox/scripts/zenborg-mcp.js');
  if(exists(script))return {command:process.execPath,args:[script],env:makeEnv(dataOverride),kind:'source-checkout',dataDir:dataOverride||null};
  throw new Error('Zenborg was not found. Install/start Zenborg, or locate its connector.');
}
function atomicJson(file,value){const temp=`${file}.${crypto.randomUUID()}.tmp`;fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,file);}
function readReceipt(file,phase){
  if(!fs.existsSync(file))return undefined;
  let saved;try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  const knownStates=['submitting','dispatched','invalid-result','retry-ready','rejected','needs-user-action','resolving'];
  const valid=saved&&typeof saved==='object'&&!Array.isArray(saved)&&saved.version===1&&saved.phase===phase&&/^[a-f0-9]{64}$/.test(saved.fingerprint)&&knownStates.includes(saved.state);
  const rejectionValid=['HARNESS_DISABLED','PROFILE_DISABLED','PROFILE_NOT_FOUND'].includes(saved?.rejectionCode);
  const recoveryValid=saved?.state==='retry-ready'&&['BROWSER_NOT_SENT','NEEDS_USER_ACTION'].includes(saved.retryReason)&&typeof saved.previousRunId==='string';
  const idsValid=recoveryValid||saved?.state==='submitting'||(saved?.state==='resolving'&&typeof saved.sessionId==='string'&&(typeof saved.submissionMessageId==='string'||typeof saved.turnId==='string'))||(['rejected','retry-ready'].includes(saved?.state)&&rejectionValid)||((saved?.sessionId==null||(typeof saved.sessionId==='string'&&saved.sessionId.length>0&&saved.sessionId.length<=160))&&Array.isArray(saved?.runIds)&&saved.runIds.length>0&&saved.runIds.length<=20&&saved.runIds.every(id=>typeof id==='string'&&id.length>0&&id.length<=160));
  if(!valid||!idsValid)throw new Error('The Zenborg dispatch receipt is unreadable or invalid. Inspect the existing session before retrying; no new task was submitted.');
  return saved;
}

function parseReply(value) {
  if (value?.isError) {
    const text=(value.content||[]).filter(item=>item.type==='text').map(item=>item.text).join('\n');
    if(/rejected MCP authentication|AUTH_REQUIRED/i.test(text))throw new Error('Zenborg refused the connector credential (HTTP 401). Vidmyo and the running Zenborg must use the same installation and data directory. No browser task was started.');
    if(/Harness browser-agent is disabled|HARNESS_DISABLED/i.test(text)){
      const error=new Error('Connected to Zenborg, but this version rejects browser-agent tasks (HARNESS_DISABLED). The Zenborg maintainer must enable a supported browser dispatch adapter. ChatGPT was not contacted.');
      error.code='HARNESS_DISABLED';error.definitiveRejected=true;throw error;
    }
    if(/NEEDS_USER_ACTION/.test(text))throw needsUserAction();
    throw new Error('Zenborg could not complete this request. Check the connection and browser sign-in in Zenborg.');
  }
  if (value?.structuredContent) return value.structuredContent;
  const text = (value?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  try { return JSON.parse(text); } catch { throw new Error('Zenborg returned an unreadable response.'); }
}

function waitForPoll(signal, ms) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();};
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason||new Error('Cancelled'));};
    const timer=setTimeout(finish,ms);signal?.addEventListener('abort',abort,{once:true});
  });
}
function needsUserAction() {
  const error = new Error('Sign in to ChatGPT in Zenborg (Browser Workers), or complete the requested verification there. Then choose Resume browser task in Vidmyo to start the new attempt authorized by Zenborg’s recovery contract.');
  error.code = 'NEEDS_USER_ACTION';
  return error;
}
function runValue(response) { return response?.run || response; }
function runErrorCode(run) { return run?.error?.code || run?.result?.error?.code || run?.code; }
function safeRecovery(run) {
  const code=runErrorCode(run);
  if(code==='BROWSER_NOT_SENT')return 'BROWSER_NOT_SENT';
  // Maintainer explicitly confirmed this legacy detail means Send was never clicked.
  if(code==='BROWSER_FAILED'&&/^ChatGPT never showed the sent message in the conversation within \d+(?:\.\d+)?\s*(?:min|s) — the prompt was not submitted \(attachment upload or send failed\)$/.test(run?.error?.detail||''))return 'BROWSER_NOT_SENT';
  if(code==='NEEDS_USER_ACTION')return 'NEEDS_USER_ACTION';
  return null;
}
function browserPrompt(task) {
  let payload=task;
  if(task.contract?.includes('renderFrame')&&task.style) {
    const guide=task.style.guide||'';
    const visual=task.style.number===171
      ? 'Real procedural3D village/rooms, perspective projection and moving camera; flat2D cartoon people inside the world. Ink #351f22, painted warm colours, cel shading, contact shadows, layered depth. Large round pale heads, fringe hair, small pear torso, thin limbs; blink, breathe and gesture. Detailed geometry, no cardboard facades or title-card slideshow. Physical action follows narration. In-world labels only. No external libraries available; use raw WebGL or project real3D vertices with Canvas2D.'
      : guide.replace(/\s+/g,' ').slice(0,1400);
    payload={output:'Return only JSON {"html":"<!doctype html>..."}. Complete offline HTML. Implement window.renderFrame(t) deterministically for arbitrary seek times. Inline geometry/assets only; no network, imports, packages, audio, timers or animation loops. Host supplies narration and renders each frame.',style:{name:task.style.name,guide:visual},width:task.width,height:task.height,durationSec:task.durationSec,script:task.script,beats:task.beats?.map(b=>({start:b.start,end:b.end,text:b.text})),topic:task.topic,details:task.details};
  }
  const message='Vidmyo creative task. Return only the requested JSON. No publishing or unrelated browsing.\n'+JSON.stringify(payload);
  if(message.length>20000)throw new Error('The browser brief exceeds20,000 characters. Shorten the topic/details or narration before creating a new browser job.');
  return message;
}
function answerText(run, response) {
  if (typeof response?.answer?.body === 'string') return response.answer.body;
  const result = run?.result;
  if (typeof result === 'string') return result;
  if (typeof result?.text === 'string') return result.text;
  if (typeof result?.output === 'string') return result.output;
  return null;
}

function parseCreativeJson(text) {
  const raw=String(text||'').trim();
  if (Buffer.byteLength(raw) > 3 * 1024 * 1024) throw new Error('Zenborg returned an oversized animation.');
  const fence=raw.match(/```[^\r\n]*\r?\n([\s\S]*?)```/);
  const input=fence?fence[1].trim():raw;
  try { return JSON.parse(input); } catch { throw new Error('The browser agent did not return the requested animation data. Open its Zenborg session to inspect the result.'); }
}

let browserQueue = Promise.resolve();
function createZenborgBrowser({ repoRoot, mcpDir = path.join(repoRoot, 'mcp'), configFile, connectImpl, workspaceDir = null, pollMs = 5000, timeoutMs = 1800000 } = {}) {
  if(workspaceDir!==null&&!path.isAbsolute(workspaceDir))throw new Error('Zenborg workspace must be an absolute directory.');
  async function connect() {
    if (connectImpl) return connectImpl();
    let config={};try{config=JSON.parse(fs.readFileSync(configFile,'utf8'));}catch{}
    const runtime=resolveZenborgRuntime({repoRoot,config});
    const sdk = name => require(require.resolve(`@modelcontextprotocol/sdk/client/${name}`, { paths: [mcpDir] }));
    const { Client } = sdk('index.js');
    const { StdioClientTransport } = sdk('stdio.js');
    // Production prompts are self-contained. Do not inherit a diagnostic/chat
    // session whose history could overflow the browser composer or cross jobs.
    const env={...runtime.env};delete env.ZENBORG_SESSION;delete env.MAIOX_SESSION;
    const transport = new StdioClientTransport({ command: runtime.command, args: runtime.args, env, stderr: 'pipe' });
    const client = new Client({ name: 'Vidmyo Animations', version: '1.0.0' }, { capabilities: {} });
    try { await client.connect(transport); }
    catch { await transport.close().catch(() => {}); throw new Error('Cannot connect to Zenborg. Start Zenborg and reconnect Vidmyo in its Settings.'); }
    return { call: async (name, args) => parseReply(await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 })), close: () => client.close(),runtime:{kind:runtime.kind,dataDir:runtime.dataDir} };
  }
  async function status() {
    let connection;
    try {
      connection = await connect();
      const result = await connection.call('zenborg_agents', {});
      const agents = (result.agents || []).filter(agent => agent.enabled !== false && agent.harness === 'browser-agent').map(agent => ({ id: agent.id, name: agent.name, model: agent.model }));
      return { ok: true, connected: true, agents, runtime:connection.runtime, message: agents.length ? 'Connected to Zenborg. Choose a browser agent; sign-in and usage limits are managed by Zenborg.' : 'No browser agents found. Add a ChatGPT or Gemini browser agent in Zenborg, then refresh.' };
    } catch (error) { return { ok: false, connected: false, agents: [], message: error.message }; }
    finally { await connection?.close(); }
  }
  function configure(script) {
    if (!path.isAbsolute(script) || !['zenborg-mcp.js', 'maiox-mcp.js'].includes(path.basename(script)) || !fs.statSync(script).isFile()) throw new Error('Choose the Zenborg MCP connector script.');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ script }), { mode: 0o600 });
  }
  async function generate(args) {
    const previous=browserQueue;let release;browserQueue=new Promise(resolve=>{release=resolve;});
    try {
      if (args.signal) await new Promise((resolve,reject)=>{
        const abort=()=>reject(args.signal.reason||new Error('Cancelled'));
        args.signal.addEventListener('abort',abort,{once:true});
        previous.then(()=>{args.signal.removeEventListener('abort',abort);resolve();});
        if(args.signal.aborted)abort();
      }); else await previous;
      args.signal?.throwIfAborted();
      return await generateTask(args);
    } finally { previous.then(release); }
  }
  async function generateTask({ project, phase, task, signal, onProgress = () => {} }) {
    const agentId = project.manifest.brief.provider.model;
    if (!agentId || agentId === 'configured-default') throw new Error('Choose a Zenborg browser agent first.');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ agentId, phase, task })).digest('hex');
    const receipt = path.join(project.dir, 'artifacts', `zenborg-${phase}.json`);
    let saved=readReceipt(receipt,phase);
    if(saved?.state==='submitting')throw new Error('Zenborg submission could not be confirmed. Inspect its session before creating another browser task.');
    if(saved?.state==='rejected')throw new Error('Zenborg rejected the previous request before dispatch ('+saved.rejectionCode+'). After fixing the Zenborg integration, choose Resume browser task.');
    const connection = await connect();
    try {
      const profiles = (!saved || saved.state === 'retry-ready' && !saved.runIds?.length) ? await connection.call('zenborg_agents', {}) : null;
      if (profiles && !profiles.agents?.some(agent => agent.id === agentId && agent.harness === 'browser-agent' && agent.enabled !== false)) throw new Error('The selected Zenborg browser agent is unavailable.');
      if (saved?.fingerprint !== undefined && saved.fingerprint !== fingerprint) throw new Error('This browser job already belongs to a different brief. Create a new project to change the task; the existing run will not be resubmitted.');
      if (!saved || (saved.state === 'retry-ready' && !saved.runIds?.length)) {
        signal?.throwIfAborted();
        if(saved)atomicJson(path.join(project.dir,'artifacts',`zenborg-${phase}-attempt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`),saved);
        // Persist dispatch intent before submission: an uncertain transport error
        // cannot silently resubmit and spend another browser turn on retry.
        const message=browserPrompt(task);
        saved = { version:1, fingerprint, phase, state: 'submitting' };
        fs.mkdirSync(path.dirname(receipt), { recursive: true });
        atomicJson(receipt, saved);
        let result;
        try { result = await connection.call('zenborg_ask', { cwd: workspaceDir||project.dir, recipients: [agentId], mode: 'manual', wait: false,
          message }); }
        catch(error){if(error.definitiveRejected){saved={...saved,state:'rejected',rejectionCode:error.code};atomicJson(receipt,saved);}throw error;}
        const runIds = result.runId ? [result.runId] : (result.runIds || []).filter(Boolean);
        const validIds = runIds.length === 1 && typeof runIds[0] === 'string' && runIds[0].length > 0 && runIds[0].length <= 160;
        const submissionMessageId = result.message?.id;
        const turnId = result.turnId || result.message?.metadata?.turnId;
        if (!validIds && !(typeof result.sessionId === 'string' && (typeof submissionMessageId === 'string' || typeof turnId === 'string'))) throw new Error('Zenborg submission could not be confirmed. Inspect its session; no duplicate will be submitted automatically.');
        saved = { version:1, fingerprint, phase, state: validIds ? 'dispatched' : 'resolving', sessionId: result.sessionId || null, submissionMessageId, turnId, runId: validIds ? runIds[0] : null, runIds: validIds ? runIds : [] };
        atomicJson(receipt, saved);
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (!saved.runIds?.length) {
          const session = await connection.call('zenborg_session_read', { sessionId: saved.sessionId, limit: 200 });
          const messages = session.messages || session.session?.messages || [];
          const candidates = messages.filter(message => typeof message.runId === 'string' && ((saved.submissionMessageId && message.replyTo === saved.submissionMessageId) || (saved.turnId && (message.metadata?.turnId || message.metadata?.turn?.turnId) === saved.turnId)));
          const ids = [...new Set(candidates.map(message => message.runId))];
          if (ids.length > 1) throw new Error('Zenborg returned several runs for this single-agent task. Inspect its session; no replacement task will be sent.');
          if (ids.length === 1) { saved={...saved,state:'dispatched',runId:ids[0],runIds:ids};atomicJson(receipt,saved); }
          else { onProgress('Zenborg accepted the task. Waiting for its run ID; no second prompt will be sent.');await waitForPoll(signal,pollMs);continue; }
        }
        let runs;
        try { runs = await Promise.all(saved.runIds.map(runId => connection.call('zenborg_run_status', { runId }))); }
        catch (error) { if (error.code === 'NEEDS_USER_ACTION') { saved.state='needs-user-action';atomicJson(receipt,saved);onProgress(error.message); } throw error; }
        if (runs.some(response => runErrorCode(runValue(response)) === 'NEEDS_USER_ACTION' || runValue(response)?.state === 'needs_user_action')) {
          saved.state='needs-user-action';atomicJson(receipt,saved);const error=needsUserAction();onProgress(error.message);throw error;
        }
        const failed = runs.find(result => ['failed', 'cancelled', 'interrupted'].includes(runValue(result)?.state));
        if (failed) {
          const code = runErrorCode(runValue(failed)) || (runValue(failed)?.state === 'cancelled' ? 'CANCELLED' : 'BROWSER_FAILED');
          const error = new Error(code === 'BROWSER_NOT_SENT' ? 'Zenborg did not send the prompt. Choose Resume browser task to create a safe new attempt.' : code === 'BROWSER_FAILED' && safeRecovery(runValue(failed))==='BROWSER_NOT_SENT' ? 'Zenborg did not submit the prompt (BROWSER_FAILED). Choose Resume browser task to create a safe new attempt.' : code === 'PROMPT_TOO_LARGE' ? 'Zenborg rejected a prompt that exceeded the browser composer limit. Create a new project with a shorter brief; the saved run will not be resent.' : code === 'BROWSER_UNRESOLVED' ? 'Zenborg cannot confirm whether the previous prompt finished (BROWSER_UNRESOLVED). Inspect its browser conversation and ask the user before creating a new job. No prompt will be resent.' : code === 'BROWSER_QUOTA' ? 'The browser account reached its usage limit. Check Zenborg before resuming this saved run.' : code === 'MODEL_UNAVAILABLE' ? 'The selected browser model is unavailable in Zenborg. The saved run is preserved.' : code === 'BROWSER_UNAVAILABLE' ? 'Zenborg Browser Workers are unavailable. Start them in Zenborg, then resume the saved run.' : code === 'TIMEOUT' ? 'Zenborg browser work timed out. The saved run is preserved; Resume checks it without sending another prompt.' : code === 'CANCELLED' ? 'Zenborg browser work was cancelled. The saved run is preserved; a new project is required for a new task.' : 'Zenborg browser work stopped. Check its session for recovery instructions; Vidmyo will not send another prompt for this task.');
          error.code = code;throw error;
        }
        if (runs.every(result => ['succeeded','completed'].includes(runValue(result)?.state))) {
          let text = answerText(runValue(runs[0]), runs[0]);
          // Older completed runs stored their response only in session messages.
          if (text === null && runValue(runs[0])?.state === 'completed' && saved.sessionId) {
            const session = await connection.call('zenborg_session_read', { sessionId: saved.sessionId, limit: 100 });
            const messages = session.messages || session.session?.messages || [];
            text = messages.filter(message => saved.runIds.includes(message.runId) && message.authorType === 'agent').at(-1)?.body;
          }
          try {
            if (typeof text !== 'string') throw new Error('Zenborg finished without a readable creative result. Open its session.');
            const result=parseCreativeJson(text);
            if(phase==='script'&&(typeof result.script!=='string'||!result.script.trim()||result.script.length>30000))throw new Error('The browser agent returned an invalid narration script.');
            if(phase==='code'&&(typeof result.html!=='string'||Buffer.byteLength(result.html)>2*1024*1024||result.html.length<100||!result.html.includes('renderFrame')))throw new Error('The browser agent returned invalid animation code.');
            return result;
          } catch(error) { saved.state='invalid-result';atomicJson(receipt,saved);throw error; }
        }
        onProgress('Zenborg Browser is working. If sign-in or verification is needed, complete it in Zenborg; this task will resume.');
        await waitForPoll(signal,pollMs);
      }
      throw new Error('Zenborg is still working. Resume this project later; the existing browser task will be reused.');
    } finally { await connection.close(); }
  }
  async function retryFailed(project) {
    const connection = await connect();
    let reset = 0;
    try {
      for (const phase of ['script','code']) {
        const file = path.join(project.dir,'artifacts',`zenborg-${phase}.json`);
        const saved=readReceipt(file,phase);if(!saved)continue;
        if(saved.state==='rejected'){
          atomicJson(path.join(project.dir,'artifacts',`zenborg-${phase}-attempt-${Date.now()}.json`),saved);
          atomicJson(file,{...saved,state:'retry-ready'});reset++;continue;
        }
        if (!saved.runIds?.length) continue;
        const response=await connection.call('zenborg_run_status',{runId:saved.runIds[0]});
        const run=runValue(response),reason=safeRecovery(run);
        if(reason&&['failed','cancelled','interrupted','needs_user_action'].includes(run?.state)){
          atomicJson(path.join(project.dir,'artifacts',`zenborg-${phase}-attempt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`),{...saved,recoveryEvidence:response});
          atomicJson(file,{...saved,state:'retry-ready',previousRunId:saved.runIds[0],retryReason:reason,runId:null,runIds:[]});reset++;continue;
        }
        if(runErrorCode(run)==='BROWSER_UNRESOLVED')throw new Error('Zenborg cannot confirm the previous send. Ask the user before creating a new job; no automatic repeat is allowed.');
        if (saved.state === 'invalid-result') throw new Error('The browser result is invalid. Create a new project for a new task; this run will not be submitted again.');

      }
      return {ok:true,message:reset?'Safe browser recovery prepared. After any required sign-in, choose Resume to submit a new attempt.':'Choose Resume to check the saved browser run. No new prompt will be sent.'};
    } finally { await connection.close(); }
  }
  return { status, configure, generate, retryFailed };
}
module.exports = { createZenborgBrowser, resolveZenborgRuntime, parseCreativeJson, parseReply, browserPrompt };
