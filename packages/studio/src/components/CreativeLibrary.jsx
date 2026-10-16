import { useEffect, useState } from 'react';
import { collectionName, jobMetadata } from '../creativeLibrary.mjs';
const field = { background:'var(--vm-input)',color:'var(--vm-text)',border:'1px solid var(--vm-line)',borderRadius:7,padding:'7px 9px',fontSize:12,maxWidth:'100%' };
export function LibraryFilter({ library, value, onChange }) {
  const names = [...new Set(Object.values(library).map(r=>r.collection).filter(Boolean))].sort();
  return <label style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',fontSize:12,marginBottom:12}}>Show
    <select aria-label="Filter creative history" style={field} value={value} onChange={e=>onChange(e.target.value)}>
      <option value="all">All results</option><option value="favorites">Favorites</option><option value="unfiled">Unfiled</option>
      {names.map(name=><option key={name} value={`collection:${name}`}>{name}</option>)}
    </select>
  </label>;
}
export function LibraryEntry({ library, kind, jobId, onChange }) {
  const metadata = jobMetadata(library,kind,jobId);
  const [draft,setDraft] = useState(metadata.collection);
  useEffect(()=>setDraft(metadata.collection),[metadata.collection,jobId]);
  return <div style={{display:'flex',gap:7,alignItems:'center',flexWrap:'wrap',marginTop:9}}>
    <button type="button" aria-pressed={metadata.favorite} onClick={()=>onChange(jobId,{favorite:!metadata.favorite})} style={field}>{metadata.favorite?'★ Favorited':'☆ Favorite'}</button>
    <input aria-label={`Collection for ${jobId}`} placeholder="Collection name" value={draft} maxLength={80} onChange={e=>setDraft(e.target.value)} style={{...field,minWidth:0,width:160}} />
    <button type="button" style={field} disabled={collectionName(draft)===metadata.collection} onClick={()=>onChange(jobId,{collection:draft})}>Save collection</button>
    {metadata.sourceImageJobId&&<span style={{color:'var(--vm-muted)',fontSize:12,overflowWrap:'anywhere'}}>Source image · {metadata.sourceImageJobId}</span>}
  </div>;
}
