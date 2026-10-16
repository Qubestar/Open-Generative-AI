// Portable audit log for VFX projects. No provider, process or filesystem access.
export function vfxBeatRows(spec) {
  const rows=[];let cursor=0;
  for(const event of spec.events) {
    if(event.startSec>cursor+.001)rows.push({startSec:cursor,endSec:event.startSec,move:'TALKING_HEAD',notes:'Original footage, clean on purpose'});
    rows.push(event);cursor=event.endSec;
  }
  if(cursor<spec.source.durationSec-.001)rows.push({startSec:cursor,endSec:spec.source.durationSec,move:'TALKING_HEAD',notes:'Original footage, clean on purpose'});
  return rows;
}
export function formatVfxRunLog(manifest,intake,spec,parity=null) {
  const cell=value=>String(value || '').replaceAll('|','\\|').replace(/[\r\n]+/g,' ');
  const cuts=intake.shots.slice(1).map(s=>s.startSec);
  const boundary=time=>cuts.some(t=>Math.abs(t-time)<.001)?`${time.toFixed(3)} (cut)`:`${time.toFixed(3)} (natural)`;
  const lines=[`# VFX — ${cell(manifest.name)}`,'',`Status: ${manifest.state}`,`Source: ${manifest.source.uri}`,`Director: ${manifest.analysis.provider}${manifest.analysis.model?` / ${manifest.analysis.model}`:''}`,`Theme: ${manifest.brand.theme}`,'',`Source: ${spec.source.width} × ${spec.source.height}, ${spec.source.fps} fps, ${spec.source.frameCount} frames`,'','| # | Time | Spoken anchor | Shot | Treatment | Boundaries | Reason |','|---|---|---|---|---|---|---|'];
  vfxBeatRows(spec).forEach((e,i)=>lines.push(`| ${i+1} | ${e.startSec.toFixed(3)}–${e.endSec.toFixed(3)} | ${cell(e.anchor?.transcript)} | ${cell(e.anchor?.shot)} | ${cell(e.move)} ${cell(e.payload?.variant)} ${cell(e.payload?.kind)} ${cell([e.payload?.text || e.payload?.label || e.payload?.title, ...(e.payload?.items || []).map(item=>`${item.text}${item.value !== undefined ? ` (${item.value})` : ''}${item.revealSec !== undefined ? ` at ${item.revealSec}s` : ''}`)].filter(Boolean).join('; '))} | ${boundary(e.startSec)} → ${boundary(e.endSec)} | ${cell(e.notes)} |`));
  if(parity)lines.push('','## Export verification','',`Frames: ${parity.frames ? 'PASS' : 'FAIL'} · Audio: ${parity.audio ? 'PASS' : 'FAIL'} · BT.709: ${parity.color ? 'PASS' : 'FAIL'}`,parity.psnr?`Clean footage PSNR: ${parity.psnr.meanDb.toFixed(2)} dB`:'No long clean stretch available for PSNR measurement.',`Visual review: ${manifest.state==='complete'?'Accepted by user':'Required: watch output and inspect event/cut frames'}`);
  return lines.join('\n')+'\n';
}
