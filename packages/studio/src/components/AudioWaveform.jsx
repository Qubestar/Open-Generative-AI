import {useEffect,useRef,useState} from 'react';
export default function AudioWaveform({sourceUrl,load,sourcePosition,duration}) {
  const [result,setResult]=useState(null);
  const [status,setStatus]=useState('');
  const loader=useRef(load);loader.current=load;
  useEffect(()=>{
    let canceled=false;setResult(null);
    if(!sourceUrl||!loader.current){setStatus('');return;}
    setStatus('Reading local audio waveform…');
    const loadThisSource=loader.current;
    Promise.resolve().then(()=>loadThisSource()).then(response=>{
      if(canceled)return;
      const value=response?.waveform;
      if(!response?.ok||!Array.isArray(value?.peaks)||value.peaks.length>2000||!value.peaks.length||value.peaks.some(p=>!Number.isFinite(p)||p<0||p>1))throw Error('Waveform unavailable');
      setResult(value);setStatus('');
    }).catch(()=>{if(!canceled)setStatus('Waveform unavailable. Video review and export still work.');});
    return()=>{canceled=true;};
  },[sourceUrl]);
  if(!result)return status?<p role="status" style={{fontSize:12,color:'var(--vm-muted)'}}>{status}</p>:null;
  const count=result.peaks.length;
  return <div style={{margin:'10px 0'}}>
    <svg role="img" aria-label="Original recording audio waveform with source playhead" viewBox={`0 0 ${count} 64`} preserveAspectRatio="none" style={{width:'100%',height:64,display:'block',background:'var(--vm-raised)',borderRadius:5}}>
      <line x1="0" x2={count} y1="32" y2="32" stroke="var(--vm-line)"/>
      <path d={result.peaks.map((p,i)=>`M${i+.5} ${32-p*30}V${32+p*30}`).join(' ')} stroke="var(--vm-accent)" strokeWidth="1"/>
      <line x1={Math.max(0,Math.min(count,count*sourcePosition/(duration||1)))} x2={Math.max(0,Math.min(count,count*sourcePosition/(duration||1)))} y1="0" y2="64" stroke="var(--vm-text)" strokeWidth="2"/>
    </svg>
    <p style={{fontSize:11,color:'var(--vm-muted)',marginTop:5}}>Original audio · playhead follows source time, including during cleaned playback</p>
  </div>;
}
