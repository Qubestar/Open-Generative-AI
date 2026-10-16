import React from 'react';
import Stickman from './Stickman';
import {
  AbsoluteFill, Audio, Composition, Easing, Img, Sequence,
  interpolate, registerRoot, spring, staticFile, useCurrentFrame, useVideoConfig,
} from 'remotion';
import world from './world.json';
import {decodeTopology, projectPoint, projectedRingPath, projectedRoutePath, shortestLongitude} from './geo.mjs';

const FPS = 30;
const WORLD = decodeTopology(world);
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};
const fade = (frame, frames) => Math.min(
  interpolate(frame, [0, Math.min(12, frames / 3)], [0, 1], clamp),
  interpolate(frame, [Math.max(0, frames - 10), frames], [1, 0], clamp),
);
const paperTexture = {
  backgroundImage: 'radial-gradient(rgba(40,25,10,.09) .7px, transparent .8px), radial-gradient(rgba(255,255,255,.35) .7px, transparent .8px)',
  backgroundPosition: '0 0, 7px 9px', backgroundSize: '13px 13px, 17px 17px',
};
const Asset = ({src, style}) => src ? <Img src={staticFile(src)} style={style} /> : null;
const layerOrder = {support: 0, hero: 1, foreground: 2};
const visualLayers = (scene) => {
  const supplied = (scene.layers || []).filter((layer) => layer.asset)
    .map((layer, index) => ({...layer, sourceIndex: index}))
    .sort((a, b) => layerOrder[a.kind] - layerOrder[b.kind] || a.sourceIndex - b.sourceIndex);
  return supplied.length ? supplied : scene.asset ? [{kind: 'hero', description: scene.visual, asset: scene.asset, sourceIndex: 0}] : [];
};

function EditorialCutout({layer,index,frame,fps,width,height,portrait}) {
  const slots = portrait ? {
    support: [{left:'2%',top:'25%',width:'47%',height:'35%'},{right:'1%',top:'50%',width:'48%',height:'32%'}],
    hero: [{left:'11%',top:'28%',width:'78%',height:'49%'}],
    foreground: [{left:'-5%',bottom:'-4%',width:'64%',height:'30%'},{right:'-6%',bottom:'1%',width:'55%',height:'27%'}],
  } : {
    support: [{left:'38%',top:'4%',width:'32%',height:'43%'},{right:'0%',top:'37%',width:'34%',height:'42%'}],
    hero: [{right:'7%',top:'12%',width:'54%',height:'70%'}],
    foreground: [{left:'31%',bottom:'-8%',width:'46%',height:'35%'},{right:'-7%',bottom:'-4%',width:'38%',height:'31%'}],
  };
  const sameKind=index.filter((candidate)=>candidate.kind===layer.kind);const ordinal=sameKind.indexOf(layer);
  const box=slots[layer.kind][Math.max(0,ordinal)%slots[layer.kind].length];
  const enter=spring({fps,frame:Math.max(0,frame-(5+layer.sourceIndex*6)),durationInFrames:24,config:{damping:14,stiffness:105,mass:.85}});
  const direction=layer.sourceIndex%2?-1:1;const rotation=(layer.sourceIndex%3-1)*3;
  const transform=`translate(${direction*(1-enter)*Math.max(70,width*.07)}px,${(1-enter)*Math.max(45,height*.08)}px) rotate(${rotation+(1-enter)*direction*9}deg) scale(${.82+.18*enter})`;
  const image={position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'contain'};
  return <div style={{position:'absolute',...box,transform,zIndex:10+layerOrder[layer.kind]*10+layer.sourceIndex,filter:'drop-shadow(10px 14px 7px rgba(30,22,17,.34))'}}>
    {layer.kind==='hero'&&<Asset src={layer.asset} style={{...image,transform:'translate(13px,13px)',filter:'brightness(0) saturate(100%) invert(39%) sepia(49%) saturate(1617%) hue-rotate(329deg) brightness(91%) contrast(87%)',opacity:.92}}/>}
    <Asset src={layer.asset} style={image}/>
  </div>;
}

function PaperCutout({layer,index,frame,fps,width,height,portrait,assemblyEnd,hold}) {
  const slots=portrait?{
    support:[{left:'3%',top:'23%',width:'43%',height:'34%'},{right:'1%',top:'49%',width:'43%',height:'34%'},{left:'8%',bottom:'5%',width:'42%',height:'27%'}],
    hero:[{left:'12%',top:'28%',width:'76%',height:'48%'}],
    foreground:[{right:'-4%',bottom:'-2%',width:'54%',height:'31%'}],
  }:{
    support:[{left:'30%',top:'8%',width:'28%',height:'38%'},{right:'1%',top:'40%',width:'31%',height:'37%'},{left:'31%',bottom:'3%',width:'30%',height:'31%'}],
    hero:[{right:'7%',top:'13%',width:'55%',height:'72%'}],
    foreground:[{right:'-3%',bottom:'-4%',width:'42%',height:'34%'}],
  };
  const sameKind=index.filter((candidate)=>candidate.kind===layer.kind);const ordinal=sameKind.indexOf(layer);const box=slots[layer.kind][Math.max(0,ordinal)%slots[layer.kind].length];
  const delay=Math.round(assemblyEnd*(.16+layer.sourceIndex*.13));
  const enter=spring({fps,frame:Math.max(0,frame-delay),durationInFrames:Math.max(9,assemblyEnd-delay),config:{damping:12,stiffness:110,mass:.85}});
  const direction=layer.sourceIndex%2?-1:1;const breathe=layer.kind==='hero'?1+Math.sin(hold/11)*.008:1+Math.sin((hold+layer.sourceIndex*8)/17)*.004;
  return <div style={{position:'absolute',...box,zIndex:10+layerOrder[layer.kind]*10+layer.sourceIndex,transform:`translate(${direction*(1-enter)*width*.1}px,${(1-enter)*height*.18}px) rotate(${direction*(1-enter)*16+(layer.sourceIndex-1)*2}deg) scale(${(.72+.28*enter)*breathe})`,filter:'drop-shadow(8px 10px 0 rgba(82,54,31,.42)) drop-shadow(16px 21px 11px rgba(42,28,17,.30))'}}>
    <Asset src={layer.asset} style={{width:'100%',height:'100%',objectFit:'contain'}}/>
  </div>;
}

function Editorial({scene}) {
  const frame = useCurrentFrame(); const {width, height, fps} = useVideoConfig();
  const portrait = height > width; const enter = spring({fps, frame, durationInFrames: 24, config: {damping: 15, stiffness: 95}});
  const stroke = interpolate(frame, [8, 34], [0, 1], clamp); const opacity = fade(frame, scene.frames);
  const layers=visualLayers(scene);
  return <AbsoluteFill style={{background: '#e8dfcf', overflow: 'hidden', opacity, ...paperTexture, fontFamily: 'Arial, Helvetica, sans-serif'}}>
    <div style={{position:'absolute',inset:'4%',border:'2px solid rgba(31,28,24,.18)'}} />
    <div style={{position:'absolute',left:'-8%',top:'8%',width:'38%',height:'22%',background:'#f5f0e7',transform:`translateX(${(1-enter)*-180}px) rotate(-4deg)`,boxShadow:'0 8px 20px #4b392333'}} />
    <div style={{position:'absolute',right:'5%',top:'10%',width:portrait?'88%':'58%',height:portrait?'68%':'76%',background:'#cf4f3d',transform:`translate(12px,14px) rotate(2.4deg) scale(${.85+.15*enter})`,clipPath:'polygon(3% 1%,97% 4%,100% 94%,4% 100%)'}} />
    {layers.map((layer)=><EditorialCutout key={`${layer.kind}-${layer.sourceIndex}`} layer={layer} index={layers} frame={frame} fps={fps} width={width} height={height} portrait={portrait}/>)}
    {!layers.length&&<div style={{position:'absolute',right:'7%',top:'16%',width:'52%',height:'65%',background:'#25211d',color:'#eee',padding:'7%',boxSizing:'border-box',fontSize:height*.035,lineHeight:1.3}}>{scene.visual}</div>}
    <div style={{position:'absolute',left:portrait?'8%':'6%',top:portrait?'7%':'17%',width:portrait?'84%':'36%',transform:`translateY(${(1-enter)*30}px)`}}>
      <div style={{fontSize:height*.021,fontWeight:900,letterSpacing:6,color:'#c84435',textTransform:'uppercase'}}>Vidmyo editorial</div>
      <div style={{fontSize:portrait?width*.105:height*.092,fontWeight:950,lineHeight:.9,letterSpacing:-3,color:'#211f1b',marginTop:18,textTransform:'uppercase'}}>{scene.headline}</div>
      <div style={{height:8,background:'#ce4a38',marginTop:26,width:`${stroke*88}%`,transform:'rotate(-1deg)'}} />
    </div>
    <div style={{position:'absolute',left:'4%',bottom:'5%',width:'92%',height:'8%',background:'#23201c',clipPath:'polygon(0 42%,38% 8%,100% 28%,98% 100%,2% 88%)',transform:`translateY(${(1-enter)*120}px)`}} />
    {[0,1,2].map((n)=><div key={n} style={{position:'absolute',left:`${8+n*5}%`,bottom:`${9+n*2}%`,width:7,height:interpolate(frame,[12+n*4,35+n*4],[0,height*(.08+n*.045)],clamp),background:n===1?'#ce4a38':'#ece5d9'}} />)}
  </AbsoluteFill>;
}

function PaperStopMotion({scene}) {
  const frame=useCurrentFrame(); const {width,height,fps}=useVideoConfig(); const portrait=height>width;
  const assemblyEnd=Math.max(10,Math.round(scene.frames*.7)); const hold=Math.max(0,frame-assemblyEnd);
  const pop=(delay)=>spring({fps,frame:Math.max(0,frame-delay),durationInFrames:Math.max(8,assemblyEnd-delay),config:{damping:13,stiffness:105,mass:.8}});
  const back=pop(0), support=pop(Math.round(assemblyEnd*.2)), title=pop(Math.round(assemblyEnd*.58));
  const opacity=fade(frame,scene.frames);const layers=visualLayers(scene);
  return <AbsoluteFill style={{background:'#c7aa78',overflow:'hidden',opacity,...paperTexture,fontFamily:'Georgia, serif'}}>
    <div style={{position:'absolute',inset:'5%',background:'#ead8b5',transform:`scale(${.86+.14*back}) rotate(${(1-back)*-3}deg)`,boxShadow:'0 18px 0 #8b6b40, 0 30px 40px #49371d66',clipPath:'polygon(2% 1%,98% 3%,100% 96%,3% 100%)',...paperTexture}} />
    <div style={{position:'absolute',left:portrait?'5%':'27%',top:portrait?'19%':'8%',width:portrait?'35%':'22%',aspectRatio:'1',borderRadius:'50%',background:'#bd593f',transform:`translate(${-90*(1-support)}px,${-120*(1-support)}px) rotate(${(1-support)*-35}deg)`,boxShadow:'8px 10px 0 #7f382b, 15px 18px 22px #4c2c2055'}} />
    <div style={{position:'absolute',right:'7%',bottom:'7%',width:portrait?'34%':'24%',height:'18%',background:'#557b70',clipPath:'polygon(0 22%,87% 0,100% 82%,13% 100%)',transform:`translate(${130*(1-support)}px,${100*(1-support)}px) rotate(${(1-support)*25}deg)`,boxShadow:'8px 10px 0 #35534c, 13px 16px 18px #4c2c2055'}} />
    {layers.map((layer)=><PaperCutout key={`${layer.kind}-${layer.sourceIndex}`} layer={layer} index={layers} frame={frame} fps={fps} width={width} height={height} portrait={portrait} assemblyEnd={assemblyEnd} hold={hold}/>)}
    {!layers.length&&<div style={{position:'absolute',right:'8%',top:'18%',width:'52%',height:'62%',background:'#e9c860',clipPath:'polygon(8% 3%,95% 9%,100% 85%,17% 100%,0 41%)',display:'grid',placeItems:'center',fontSize:height*.035,padding:'8%',boxSizing:'border-box',textAlign:'center',boxShadow:'11px 15px 0 rgba(85,55,32,.42)'}}>{scene.visual}</div>}
    <div style={{position:'absolute',left:portrait?'10%':'8%',top:portrait?'8%':'19%',width:portrait?'80%':'31%',transform:`translateY(${(1-title)*-80}px) rotate(${(1-title)*-5}deg)`,color:'#332719'}}>
      <div style={{fontFamily:'Arial,sans-serif',fontSize:height*.017,fontWeight:800,letterSpacing:5,textTransform:'uppercase',color:'#8b3f31'}}>Hand assembled</div>
      <div style={{fontSize:portrait?width*.095:height*.075,fontWeight:900,lineHeight:.96,marginTop:15}}>{scene.headline}</div>
    </div>
  </AbsoluteFill>;
}

function DocumentaryMap({scene, previousLocation}) {
  const frame=useCurrentFrame(); const {width,height}=useVideoConfig(); const portrait=height>width;
  const progress=Easing.inOut(Easing.cubic)(interpolate(frame,[0,Math.max(1,scene.frames-1)],[0,1],clamp));
  const points=scene.locations?.length?scene.locations:[{name:'World',lat:10,lon:0}];
  const first=previousLocation||points[0],last=points.at(-1);
  const camera={lon:shortestLongitude(first.lon,last.lon,progress),lat:first.lat+(last.lat-first.lat)*progress,zoom:portrait?2.05:1.35};
  const route=[...(previousLocation?[previousLocation]:[]),...points]; const routePath=projectedRoutePath(route,camera,width,height);
  const opacity=fade(frame,scene.frames); const routeReveal=interpolate(frame,[8,Math.max(9,Math.min(scene.frames-8,45))],[0,1],clamp);
  const activeLabel=Math.min(points.length-1,Math.floor(progress*points.length));
  const markerRadius=Math.max(4,Math.min(13,height*.009));const labelSize=Math.max(10,Math.min(30,height*.021));
  return <AbsoluteFill style={{background:'#071d2c',overflow:'hidden',opacity,fontFamily:'Arial,Helvetica,sans-serif'}}>
    <svg width={width} height={height} style={{position:'absolute',inset:0}}>
      <rect width={width} height={height} fill="#0b2b3d" />
      {[...Array(7)].map((_,n)=><line key={`lat-${n}`} x1="0" x2={width} y1={height*n/6} y2={height*n/6} stroke="#9fd1d0" strokeOpacity=".08" />)}
      {[...Array(9)].map((_,n)=><line key={`lon-${n}`} y1="0" y2={height} x1={width*n/8} x2={width*n/8} stroke="#9fd1d0" strokeOpacity=".08" />)}
      <g>{WORLD.map((polygon,index)=><path key={index} d={polygon.flatMap((ring)=>[-1,0,1].map((shift)=>projectedRingPath(ring,camera,width,height,shift))).join(' ')} fill="#c3b997" stroke="#061822" strokeWidth={Math.max(1,width/1200)} />)}</g>
      {routePath&&<><path d={routePath} fill="none" stroke="#061822" strokeWidth={12} strokeLinecap="round" opacity=".4"/><path d={routePath} fill="none" stroke="#efbb55" strokeWidth={6} strokeLinecap="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1-routeReveal}/></>}
      {points.map((location,index)=>{const [x,y]=projectPoint(location,camera,width,height);const appear=interpolate(frame,[8+index*5,18+index*5],[0,1],clamp);return <g key={`${location.name}-${index}`} transform={`translate(${x} ${y}) scale(${appear})`}><circle r={markerRadius} fill="#efbb55"/><circle r={markerRadius*1.9} fill="none" stroke="#efbb55" strokeWidth={Math.max(1,height*.002)} opacity=".55"/>{(points.length===1||index===activeLabel)&&<text y={-markerRadius*2.6} textAnchor="middle" fill="#fff7df" fontSize={labelSize} fontWeight="800" style={{paintOrder:'stroke',stroke:'#071d2c',strokeWidth:Math.max(3,labelSize*.3)}}>{location.name}</text>}</g>})}
    </svg>
    <div style={{position:'absolute',left:'5%',right:'5%',top:portrait?'7%':'8%',display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
      <div style={{maxWidth:portrait?'90%':'55%',background:'#071d2cdd',borderLeft:`${Math.max(7,width*.006)}px solid #efbb55`,padding:`${height*.025}px ${width*.025}px`,boxShadow:'0 12px 35px #0008'}}>
        <div style={{fontSize:height*.017,textTransform:'uppercase',letterSpacing:5,color:'#8dc7c7',fontWeight:800}}>Documentary atlas</div>
        <div style={{fontSize:portrait?width*.09:height*.072,lineHeight:.97,color:'#fff7df',fontWeight:900,marginTop:12}}>{scene.headline}</div>
      </div>
      <div style={{color:'#efbb55',fontWeight:900,fontSize:height*.022}}>{scene.id.toUpperCase()}</div>
    </div>
  </AbsoluteFill>;
}

function Doodle({scene}) {
  const frame=useCurrentFrame();const {width,height,fps}=useVideoConfig();const portrait=height>width;
  const enter=spring({fps,frame,durationInFrames:25,config:{damping:16,stiffness:100}});const opacity=fade(frame,scene.frames);
  return <AbsoluteFill style={{background:'#fff',overflow:'hidden',opacity,fontFamily:'Arial,Helvetica,sans-serif',backgroundImage:'linear-gradient(#5d8fc010 1px,transparent 1px),linear-gradient(90deg,#5d8fc010 1px,transparent 1px)',backgroundSize:'40px 40px'}}>
    <div style={{position:'absolute',left:'5%',right:'5%',top:'6%',height:'88%',border:'5px solid #1e2630',borderRadius:portrait?45:32,transform:`rotate(${Math.sin(frame/18)*.25}deg)`}} />
    <div style={{position:'absolute',left:portrait?'9%':'7%',top:portrait?'9%':'15%',width:portrait?'82%':'37%',transform:`translateX(${(1-enter)*-100}px)`}}><div style={{color:'#f5820d',fontWeight:900,letterSpacing:4,fontSize:height*.018}}>EXPLAINED SIMPLY</div><div style={{fontSize:portrait?width*.105:height*.083,lineHeight:.95,fontWeight:950,color:'#1e2630',marginTop:15}}>{scene.headline}</div><div style={{height:10,width:`${enter*75}%`,background:'#f5c518',marginTop:25,border:'3px solid #1e2630',transform:'rotate(-2deg)'}} /></div>
    <div style={{position:'absolute',left:portrait?'10%':'48%',top:portrait?'34%':'10%',width:portrait?'80%':'46%',height:portrait?'50%':'78%',transform:`translateY(${(1-enter)*120}px) scale(${1+frame/scene.frames*.025})`,filter:'drop-shadow(8px 10px 0 #2d5fbf)'}}><Asset src={scene.asset} style={{width:'100%',height:'100%',objectFit:'contain'}} />{!scene.asset&&<div style={{width:'100%',height:'100%',display:'grid',placeItems:'center',border:'6px solid #1e2630',borderRadius:'50%',background:'#6eb5e8',padding:'15%',boxSizing:'border-box',textAlign:'center',fontSize:height*.034,fontWeight:800}}>{scene.visual}</div>}</div>
    {[['#d94040',8,82],['#3a9e3a',88,18],['#f5820d',88,82]].map(([color,left,top],i)=><div key={color} style={{position:'absolute',left:`${left}%`,top:`${top}%`,width:22,height:22,borderRadius:i===1?0:'50%',background:color,border:'4px solid #1e2630',transform:`scale(${enter}) rotate(${frame*2}deg)`}} />)}
  </AbsoluteFill>;
}

function Scene({scene,style,previousLocation,characterAnimation,characterDesign,speechEnvelope}) {
  if(style==='doodle-v1' && characterAnimation==='animated')return <Stickman characterDesign={characterDesign} scene={scene} speechEnvelope={speechEnvelope}/>;
  if(style==='documentary-map')return <DocumentaryMap scene={scene} previousLocation={previousLocation}/>;
  if(style==='paper-stop-motion')return <PaperStopMotion scene={scene}/>;
  if(style==='editorial-collage')return <Editorial scene={scene}/>;
  return <Doodle scene={scene}/>;
}

function Video({style='editorial-collage',scenes=[],audio,characterAnimation='static',characterDesign='classic',speechEnvelope=[]}) {
  return <AbsoluteFill style={{background:'#000'}}>
    {scenes.map((scene,index)=><Sequence key={scene.id} from={scene.startFrame??scenes.slice(0,index).reduce((n,s)=>n+s.frames,0)} durationInFrames={scene.frames} premountFor={Math.min(30,scene.frames)}><Scene scene={scene} style={style} characterAnimation={characterAnimation} characterDesign={characterDesign} speechEnvelope={speechEnvelope} previousLocation={scenes[index-1]?.locations?.at(-1)}/></Sequence>)}
    {audio?<Audio src={staticFile(audio)}/>:null}
  </AbsoluteFill>;
}

const defaults={style:'editorial-collage',width:1920,height:1080,fps:FPS,scenes:[{id:'s001',headline:'Vidmyo',visual:'A visual story',frames:90,startFrame:0,locations:[],layers:[]}],audio:null};
function Root(){return <Composition id="VidmyoAnimation" component={Video} width={1920} height={1080} fps={FPS} durationInFrames={90} defaultProps={defaults} calculateMetadata={({props})=>({width:props.width,height:props.height,fps:props.fps||FPS,durationInFrames:props.totalFrames||props.scenes.reduce((n,s)=>Math.max(n,(s.startFrame||0)+s.frames),1)})}/>}
registerRoot(Root);
