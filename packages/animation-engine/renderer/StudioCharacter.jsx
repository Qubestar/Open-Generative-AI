import React from 'react';
import { characterPose } from './stickmanMotion.mjs';

const ink = '#263342';
const shirts = {blue:'#4689a5',red:'#cc6960',yellow:'#e7b551',green:'#649780',gray:'#849099'};
const skins = {paper:'#fff4de',light:'#edbd95',medium:'#ba815d',dark:'#78513f'};
// Identity is derived from a persistent cast ID, never from scene/frame order.
export function castAppearance(id) {
  let seed = 2166136261;
  for (const letter of id) seed = Math.imul(seed ^ letter.charCodeAt(0), 16777619);
  seed ^= seed >>> 16; seed = Math.imul(seed, 0x7feb352d);
  seed ^= seed >>> 15; seed = Math.imul(seed, 0x846ca68b);
  seed ^= seed >>> 16;
  return {hair:(seed >>> 0) % 3, glasses:((seed >>> 3) % 4) === 0, jacket:((seed >>> 7) % 2) === 0};
}

function StickHand({x,y}) {
  return <path d={`M ${x} ${y} l -5 6 m 5 -6 l 0 8 m 0 -8 l 5 6`} fill="none" stroke={ink} strokeWidth="3"/>;
}

export function StudioCharacter({character,frame=0,fps=30,frames=180,width=1080,height=1920,speech=0}) {
  const p=characterPose(character,frame,fps,frames,speech);
  const look=castAppearance(character.id);
  const skin=skins[character.skin] || skins.paper;
  const shirt=shirts[character.shirt] || shirts.blue;
  const flip=character.facing==='left'?-1:1;
  const scale=height*character.scale/320;
  const happy=character.expression==='happy';
  const concerned=character.expression==='concerned';
  const surprise=character.expression==='surprised';
  const t=frame/fps;
  // Gestures have anticipation, a readable hold, and a return to rest.
  const beat=t%4.6;
  const ease=x=>{const v=Math.max(0,Math.min(1,x));return v*v*(3-2*v);};
  const gesture=ease((beat-.3)/.6)*(1-ease((beat-2.8)/.8));
  const rightArm=character.action==='wave' ? (-115+Math.sin(t*7)*12)*gesture : character.action==='point' ? -85*gesture : p.rightArm;
  return <g transform={`translate(${width*p.x} ${height*character.y}) scale(${scale})`}>
    <ellipse cy="4" rx="47" ry="7" fill="#273341" opacity=".16"/>
    <g transform={`scale(${flip} 1)`} stroke={ink} strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round">
      {/* Feet remain planted during idle breathing; only walkers lift them. */}
      {[-1,1].map((side,i)=><g key={side} transform={`rotate(${i?p.rightLeg:p.leftLeg} ${side*13} -112)`}>
        <path d={`M ${side*13} -120 L ${side*18} -63 L ${side*23} -6 L ${side*35} -5`} fill="none" strokeWidth="5"/>
      </g>)}
      <g transform={`translate(0 ${p.bob})`}>
        <g transform={`rotate(${p.leftArm} -27 -215)`}>
          <path d="M -27 -215 L -43 -172 L -48 -133" strokeWidth="5" fill="none"/>
          <StickHand x={-48} y={-133}/>
        </g>
        <path d="M -15 -232 L -15 -216 Q 0 -202 15 -216 L 15 -235" fill={skin}/>
        <path d="M -23 -219 Q -33 -218 -35 -202 L -28 -121 Q 0 -113 28 -121 L 35 -202 Q 31 -218 21 -219 Q 0 -204 -23 -219 Z" fill={shirt}/>
        {look.jacket ? <g fill="none"><path d="M -16 -217 L -8 -197 L -13 -123 M 16 -217 L 8 -197 L 13 -123" stroke="#fff8e3" strokeWidth="5"/><path d="M -19 -167 L -9 -165 M 9 -165 L 19 -167" strokeWidth="2"/></g> : <path d="M -18 -212 Q 0 -198 18 -212 M -26 -130 Q 0 -124 26 -130" fill="none" opacity=".4" strokeWidth="2"/>}
        <g transform={`rotate(${rightArm} 28 -211)`}>
          <path d="M 28 -211 L 43 -173 L 40 -135" strokeWidth="5" fill="none"/>
          <StickHand x={40} y={-135}/>
        </g>
        <g transform={`rotate(${p.head} 0 -230)`}>
          {look.hair===2 && <path d="M -39 -271 Q -47 -241 -36 -225 L 34 -225 Q 49 -251 34 -280 Z" fill="#493c38"/>}
          <ellipse cx="-36" cy="-267" rx="8" ry="12" fill={skin}/><ellipse cx="37" cy="-267" rx="7" ry="12" fill={skin}/>
          <path d="M -36 -281 Q -37 -309 0 -311 Q 38 -308 38 -279 L 33 -249 Q 23 -230 2 -229 Q -24 -230 -33 -250 Z" fill={skin}/>
          <path d={look.hair===0 ? 'M -36 -275 L -39 -289 Q -40 -314 -11 -313 Q 3 -331 22 -315 Q 42 -314 39 -289 L 33 -278 L 27 -297 Q 3 -288 -18 -299 L -29 -289 L -29 -275 Z' : look.hair===1 ? 'M -36 -275 L -39 -293 Q -31 -320 1 -315 Q 36 -320 40 -291 L 34 -277 L 28 -296 Q 0 -298 -26 -292 L -29 -274 Z' : 'M -36 -272 Q -44 -309 -17 -316 Q 13 -328 35 -304 L 40 -274 L 30 -282 L 23 -299 Q 6 -277 -29 -282 L -29 -270 Z'} fill={look.hair===1?'#725344':'#393b40'}/>
          <g strokeWidth="2.5" fill="none"><path d={concerned?'M -23 -282 L -10 -288 M 10 -288 L 25 -282':surprise?'M -23 -289 Q -16 -295 -9 -289 M 11 -289 Q 18 -295 25 -289':'M -24 -286 Q -17 -289 -10 -286 M 11 -286 Q 18 -289 25 -286'}/></g>
          {p.blink ? <path d="M -22 -272 Q -16 -268 -10 -272 M 12 -272 Q 18 -268 24 -272" fill="none" strokeWidth="2.5"/> : <g stroke="none" fill={ink}><ellipse cx={-15+p.gaze} cy="-273" rx="3.4" ry={surprise?6:4.8}/><ellipse cx={19+p.gaze} cy="-273" rx="3.4" ry={surprise?6:4.8}/><circle cx={-14+p.gaze} cy="-275" r="1" fill="white"/><circle cx={20+p.gaze} cy="-275" r="1" fill="white"/></g>}
          {look.glasses && <g fill="none" strokeWidth="2.5"><rect x="-28" y="-281" width="24" height="18" rx="6"/><rect x="7" y="-281" width="24" height="18" rx="6"/><path d="M -4 -274 L 7 -274 M -34 -277 L -28 -276"/></g>}
          <path d="M 3 -272 L 6 -261 L 1 -259" fill="none" strokeWidth="2" opacity=".55"/>
          <ellipse cx="-25" cy="-258" rx="6" ry="3" fill="#d58678" stroke="none" opacity=".28"/>
          {p.mouth>.08 ? <g><ellipse cx="3" cy="-247" rx={6+p.mouth*4} ry={2+p.mouth*7} fill="#673e43" strokeWidth="2"/>{p.mouth>.5 && <path d="M -3 -250 L 8 -250" stroke="#fff7e9" strokeWidth="3"/>}</g> : <path d={happy?'M -8 -248 Q 3 -237 15 -250':concerned?'M -6 -244 Q 3 -250 12 -244':'M -6 -247 Q 4 -243 12 -248'} fill="none" strokeWidth="2.5"/>}
        </g>
      </g>
    </g>
  </g>;
}
