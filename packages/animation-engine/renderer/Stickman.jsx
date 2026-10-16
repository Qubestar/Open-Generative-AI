import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { StudioCharacter } from './StudioCharacter.jsx';
import { characterPose } from './stickmanMotion.mjs';

const shirts = { blue: '#4c91bd', red: '#db564e', yellow: '#e8b84d', green: '#609a77', gray: '#7d858b' };
const skins = { paper: '#fffdf6', light: '#f1c3a0', medium: '#bd8059', dark: '#774e39' };
const ink = '#222a30';

function Hand({x, y}) {
  return <path d={`M ${x} ${y} l -5 6 m 5 -6 l 0 8 m 0 -8 l 5 6`} fill="none" strokeWidth="3" />;
}

function Character({character, frame, fps, frames, width, height, speech}) {
  const p = characterPose(character, frame, fps, frames, speech);
  const scale = height * character.scale / 300;
  const facing = character.facing === 'left' ? -1 : 1;
  const skin = skins[character.skin];
  const happy = character.expression === 'happy';
  const surprised = character.expression === 'surprised';
  const worried = character.expression === 'concerned';
  return <g transform={`translate(${width*p.x} ${height*character.y}) scale(${scale})`}>
    <ellipse cy="3" rx="48" ry="8" fill="#000" opacity=".13" />
    <g transform={`scale(${facing} 1)`} stroke={ink} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
      <g transform={`translate(0 ${p.bob})`}>
        <path d="M -12 -119 L -20 -61 L -24 -5 L -8 -2" fill="none" transform={`rotate(${p.leftLeg} -12 -119)`}/>
        <path d="M 12 -119 L 23 -61 L 29 -5 L 43 -2" fill="none" transform={`rotate(${p.rightLeg} 12 -119)`}/>
        <g transform={`rotate(${p.leftArm} -26 -205)`}>
          <path d="M -26 -205 L -43 -158 L -48 -120" fill="none"/><Hand x={-48} y={-120}/>
        </g>
        <path d="M -23 -213 Q 0 -225 23 -213 L 33 -121 Q 0 -110 -33 -121 Z" fill={shirts[character.shirt]}/>
        <g transform={`rotate(${p.rightArm} 26 -205)`}>
          <path d="M 26 -205 L 42 -166 L 39 -125" fill="none"/><Hand x={39} y={-125}/>
        </g>
        <g transform={`rotate(${p.head} 0 -218)`}>
          <circle cy="-255" r="43" fill={skin}/>
          {p.blink ? <path d="M -18 -262 l 10 0 M 8 -262 l 10 0" fill="none" strokeWidth="3"/> : <g fill={ink} stroke="none"><ellipse cx="-13" cy="-263" rx="4" ry={surprised?8:6}/><ellipse cx="13" cy="-263" rx="4" ry={surprised?8:6}/></g>}
          <path d={worried?'M -22 -275 l 13 -5 M 8 -280 l 14 5':surprised?'M -21 -279 Q -13 -285 -6 -279 M 6 -279 Q 13 -285 21 -279':'M -20 -277 l 13 -1 M 7 -278 l 13 1'} fill="none" strokeWidth="2.5"/>
          {p.mouth > .08 ? <ellipse cy="-239" rx={7+p.mouth*5} ry={2+p.mouth*10} fill="#583337" strokeWidth="2.5"/> : surprised ? <ellipse cy="-239" rx="5" ry="7" fill={ink} strokeWidth="2"/> : <path d={happy?'M -14 -242 Q 0 -223 16 -242 Z':worried?'M -11 -237 Q 0 -243 11 -237':'M -10 -239 Q 1 -234 12 -240'} fill={happy?'white':'none'} strokeWidth="2.5"/>}
        </g>
      </g>
    </g>
  </g>;
}

export default function Stickman({scene, speechEnvelope = [], characterDesign = 'classic'}) {
  const frame = useCurrentFrame();
  const {width, height, fps} = useVideoConfig();
  const speech = speechEnvelope[(scene.startFrame || 0) + frame] || 0;
  return <AbsoluteFill style={{background:'#f4f1e8', overflow:'hidden'}}>
    {scene.asset && <Img src={staticFile(scene.asset)} style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}}/>}
    <svg width={width} height={height} style={{position:'absolute',inset:0}}>
      {(scene.characters || []).map(character => { const Figure = characterDesign === 'studio' ? StudioCharacter : Character; return <Figure key={character.id} {...{character,frame,fps,width,height,speech}} frames={scene.frames}/>; })}
    </svg>
    {scene.headline && <div style={{position:'absolute',left:'7%',right:'7%',top:'7%',textAlign:'center',fontFamily:'Arial,Helvetica,sans-serif',fontWeight:800,fontSize:Math.min(width*.055,height*.047),lineHeight:1.15,color:ink}}><span style={{background:'#fffdf6ef',padding:'.18em .42em',boxDecorationBreak:'clone',WebkitBoxDecorationBreak:'clone'}}>{scene.headline}</span></div>}
  </AbsoluteFill>;
}
