// Real browser UI test; the connected scenario stubs only Electron boundaries.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const dir=path.join(repo,'output/playwright/animation-qa');fs.mkdirSync(dir,{recursive:true});
const url=process.env.VIDMYO_QA_UI_URL||'http://localhost:4325/studio/animations';
if(!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('UI checks require an isolated loopback server.');
const logs=[];
function cli(...args){const x=spawnSync('npx',['--yes','--package','@playwright/cli','playwright-cli','-s=animation-qa',...args],{cwd:repo,encoding:'utf8',timeout:120000});logs.push(x.stdout+x.stderr);if(x.status!==0||/### Error\n/.test(x.stdout))throw Error((x.stdout+x.stderr).slice(-2500));return x.stdout;}
let result;
try{
  cli('open',url);cli('snapshot');
  const code=`async(page)=>{
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.getByLabel('Find a style').fill('7');
    await page.getByRole('button',{name:/Whiteboard Explainer reference frame/}).click();
    const provider=page.getByRole('combobox',{name:'Image provider',exact:true});
    if(await provider.inputValue()!=='not-needed'||!await provider.isDisabled())throw Error('Code style did not select Not needed');
    if(await page.locator('.animation-gallery-card').count()!==1)throw Error('Number search is not exact');
    await page.getByRole('button',{name:'▶ Watch example',exact:true}).click();
    const video=page.locator('.animation-reference video');await video.waitFor();
    await page.waitForFunction(()=>document.querySelector('.animation-reference video')?.readyState>=2,null,{timeout:20000});
    await page.waitForFunction(()=>{const b=document.querySelector('.animation-reference video')?.getBoundingClientRect();return b&&b.top>=0&&b.bottom<=innerHeight+1},null,{timeout:5000});
    await page.screenshot({path:${JSON.stringify(path.join(dir,'style-07.png'))}});
    if(await page.locator('.creative-provider').filter({hasText:'Zenborg Browser'}).count())throw Error('Disconnected browser director must stay hidden');
    await page.getByRole('button',{name:'Connect Zenborg',exact:true}).click();
    await page.getByText('Open Vidmyo desktop to connect Zenborg Browser.').waitFor();
    await page.getByLabel('Find a style').fill('1');
    await page.getByRole('button',{name:/#01 · Documentary Editorial collage/}).click();
    const options=await provider.locator('option').allTextContents();
    if(options.some(x=>/agnes|not needed/i.test(x)))throw Error('Original image options include a removed provider');
    await page.setViewportSize({width:390,height:844});
    await page.getByLabel('Find a style').fill('7');
    await page.getByRole('button',{name:/Whiteboard Explainer reference frame/}).click();
    await page.getByRole('heading',{name:'Choose your animation style'}).scrollIntoViewIfNeeded();
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error('Mobile horizontal overflow');
    await page.screenshot({path:${JSON.stringify(path.join(dir,'mobile-390.png'))}});
    await page.addInitScript(()=>{window.creative={isElectron:true,recent:async()=>({ok:true,projects:[]}),onProgress:()=>()=>{},zenborgStatus:async()=>({ok:true,connected:true,agents:[{id:'ui-fixture-chatgpt',name:'ChatGPT Browser Architect',model:'chatgpt'}]})};});
    await page.reload();
    const browserDirector=page.getByRole('button',{name:/ChatGPT Browser Architect/});
    try { await browserDirector.waitFor(); } catch(e) { throw Error(JSON.stringify({message:e.message,pageErrors:errors,state:await page.evaluate(()=>({creative:!!window.creative?.isElectron,providers:[...document.querySelectorAll('.creative-provider')].map(x=>x.textContent),statuses:[...document.querySelectorAll('[role=status]')].map(x=>x.textContent)}))})); }
    await browserDirector.click();
    if(await browserDirector.getAttribute('aria-pressed')!=='true')throw Error('Browser director was not selected in one click');
    if(await page.getByRole('combobox',{name:'Browser agent',exact:true}).count())throw Error('Browser selection requires a redundant dropdown');
    await page.getByLabel('Find a style').fill('7');
    await page.getByRole('button',{name:/Whiteboard Explainer reference frame/}).click();
    if(await browserDirector.getAttribute('aria-pressed')!=='true')throw Error('Code animation lost its selected director');
    await page.setViewportSize({width:1280,height:900});
    await page.getByLabel('Find a style').fill('171');
    await page.getByRole('button',{name:/Ink World Stories.*reference frame/}).click();
    if(await provider.inputValue()!=='not-needed'||!await provider.isDisabled())throw Error('New3D style requires an image provider');
    await page.getByRole('button',{name:'▶ Watch example',exact:true}).click();
    await page.waitForFunction(()=>{const v=document.querySelector('.animation-reference video');return v?.getAttribute('src')?.includes('ink-world-story')&&v.readyState>=2},null,{timeout:20000});
    await page.getByText('Original Vidmyo demonstration, authored locally from this style guide.',{exact:false}).waitFor();
    await page.screenshot({path:"/Volumes/My Lexar/AI Projects/Vidmyo/output/playwright/animation-qa/style-171.png"});
    if(errors.length)throw Error(errors.join('; '));
    return {ok:true,checks:['style-number','not-needed','reference-playback','preview-visible','zenborg-disconnected','zenborg-auto-discovery','zenborg-one-click','code-keeps-director','new-style171','new-style-no-images','local-preview-playback','agnes-removed','mobile-overflow'],pageErrors:errors};
  }`;
  const text=cli('run-code',code);
  if(!text.includes('"ok": true')&&!text.includes('"ok":true'))throw Error('UI test did not return success.');
  result={exitCode:0,ok:true,url,artifacts:['style-07.png','mobile-390.png','style-171.png'],checks:13};
}catch(error){result={exitCode:1,ok:false,error:error.message};}
finally{try{cli('close')}catch{}fs.writeFileSync(path.join(dir,'cli.log'),logs.join('\n'));}
fs.writeFileSync(path.join(dir,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=result.exitCode;
