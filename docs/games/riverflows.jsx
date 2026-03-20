import { useState, useCallback, useMemo, useRef } from 'react';

const S = 34, SQ3 = Math.sqrt(3), RAD = 2;
const DIRS = [[0,-1],[1,-1],[1,0],[0,1],[-1,1],[-1,0]];
const EN = ['N','NE','SE','S','SW','NW'];

const h2p = (q,r) => ({ x:S*1.5*q, y:S*SQ3*(r+q/2) });
const hk = (q,r) => `${q},${r}`;
const opp = e => (e+3)%6;
const nbr = (q,r,e) => ({ q:q+DIRS[e][0], r:r+DIRS[e][1] });

// Mirror: reflect across N-S axis, then rotate
const mirE = e => (6-e)%6;
const rp = (pe, rot, mir) => mir ? (mirE(pe)+rot)%6 : (pe+rot)%6;

function vtx(cx,cy,i) {
  const a=(Math.PI/3)*i;
  return { x:cx+S*Math.cos(a), y:cy-S*Math.sin(a) };
}
function hexPts(cx,cy) {
  return Array.from({length:6},(_,i)=>{const v=vtx(cx,cy,i);return `${v.x.toFixed(1)},${v.y.toFixed(1)}`;}).join(' ');
}
const EV=[[1,2],[0,1],[5,0],[4,5],[3,4],[2,3]];
function eMid(cx,cy,e){const[a,b]=EV[e];const va=vtx(cx,cy,a),vb=vtx(cx,cy,b);return{x:(va.x+vb.x)/2,y:(va.y+vb.y)/2};}
function eNorm(e){const[a,b]=EV[e];const va=vtx(0,0,a),vb=vtx(0,0,b);const mx=(va.x+vb.x)/2,my=(va.y+vb.y)/2;const l=Math.sqrt(mx*mx+my*my);return{x:mx/l,y:my/l};}
function genGrid(rad){const h=[];for(let q=-rad;q<=rad;q++)for(let r=-rad;r<=rad;r++)if(Math.abs(q+r)<=rad)h.push({q,r});return h;}

// ─── Tiles ───
const T = {
  glacial:     {name:'Glacial Spring',s:'Glacial',l:'3W',cat:'src',w:3,ports:[{e:2,d:'o'}],fill:'#3A5060',str:'#4C6272',band:'#3A7CA5'},
  snowmelt:    {name:'Snowmelt Spring',s:'Snowmelt',l:'2W',cat:'src',w:2,ports:[{e:2,d:'o'}],fill:'#344858',str:'#465A6A',band:'#3A7CA5'},
  underground: {name:'Underground Spring',s:'U.Ground',l:'1W',cat:'src',w:1,ports:[{e:2,d:'o'}],fill:'#2E4250',str:'#405462',band:'#3A7CA5'},
  well:        {name:'Well',s:'Well',l:'1W?',cat:'src',w:1,ports:[{e:2,d:'o'}],isWell:true,fill:'#2A3E4C',str:'#3C505E',band:'#3A7CA5'},

  // Wire: River=120° wide curve NW→SE, Creek=60° tight NW→NE, Bend=180° hairpin NW→SW
  river: {name:'River 120',s:'River',l:'120',cat:'wire',ports:[{e:5,d:'i'},{e:2,d:'o'}],fill:'#344050',str:'#465262',band:'#8B7020'},
  creek: {name:'Creek 60',s:'Creek',l:'60',cat:'wire',ports:[{e:5,d:'i'},{e:1,d:'o'}],fill:'#344050',str:'#465262',band:'#8B7020'},
  bend:  {name:'Bend 180',s:'Bend',l:'180',cat:'wire',ports:[{e:5,d:'i'},{e:4,d:'o'}],fill:'#344050',str:'#465262',band:'#8B7020'},
  canal: {name:'Canal 120',s:'Canal',l:'C120',cat:'wire',ports:[{e:5,d:'b'},{e:2,d:'b'}],bidir:true,fill:'#3A4858',str:'#4C5A6A',band:'#8B7020'},

  tributary:{name:'Tributary',s:'Split',l:'Y',cat:'wire',
    ports:[{e:0,d:'i'},{e:2,d:'o'},{e:4,d:'o'}],gate:'split',fill:'#384858',str:'#4A5A6A',band:'#8B7020'},
  bridge:{name:'Stone Bridge',s:'Bridge',l:'X',cat:'wire',
    ports:[{e:5,d:'i'},{e:2,d:'o'},{e:0,d:'i2'},{e:3,d:'o2'}],gate:'cross',fill:'#4A4A48',str:'#5C5C58',band:'#8B7020'},

  crevasse: {name:'Crevasse',s:'Crevasse',l:'>1',cat:'mod',clamp:1,ports:[{e:5,d:'i'},{e:2,d:'o'}],fill:'#443E38',str:'#564E48',band:'#7A6050'},
  waterfall:{name:'Waterfall',s:'W.Fall',l:'>3',cat:'mod',amp:3,ports:[{e:0,d:'i'},{e:3,d:'o'}],fill:'#2E4E5A',str:'#40606C',band:'#7A6050'},
  narrows:  {name:'Rocky Narrows',s:'Narrows',l:'-1',cat:'mod',red:1,ports:[{e:5,d:'i'},{e:2,d:'o'}],fill:'#3E3C38',str:'#504E48',band:'#7A6050'},
  rapids:   {name:'White Rapids',s:'Rapids',l:'-2',cat:'mod',red:2,ports:[{e:5,d:'i'},{e:2,d:'o'}],fill:'#464440',str:'#585650',band:'#7A6050'},

  dry_riverbed:{name:'Dry Riverbed',s:'AND',l:'AND',cat:'gate',gate:'and_min',
    ports:[{e:5,d:'i'},{e:4,d:'i'},{e:2,d:'o'}],fill:'#4A4238',str:'#5C544A',band:'#B84030'},
  confluence:{name:'Confluence',s:'OR+',l:'OR+',cat:'gate',gate:'or_add',
    ports:[{e:5,d:'i'},{e:4,d:'i'},{e:2,d:'o'}],fill:'#344858',str:'#465A6A',band:'#B84030'},
  dammed:{name:'Dammed Spring',s:'NOT',l:'NOT',cat:'gate',gate:'not',notPow:2,
    ports:[{e:5,d:'i'},{e:2,d:'o'}],fill:'#443C34',str:'#564E46',band:'#B84030'},
  karst:{name:'Karst Cave',s:'NAND',l:'NAND',cat:'gate',gate:'nand',notPow:2,
    ports:[{e:5,d:'i'},{e:4,d:'i'},{e:2,d:'o'}],fill:'#3A3830',str:'#4C4A42',band:'#B84030'},
  artesian:{name:'Artesian Well',s:'NOR',l:'NOR',cat:'gate',gate:'nor',notPow:2,
    ports:[{e:5,d:'i'},{e:4,d:'i'},{e:2,d:'o'}],fill:'#2E3840',str:'#404A52',band:'#B84030'},
  seesaw:{name:'Seesaw Falls',s:'XOR',l:'XOR',cat:'gate',gate:'xor',
    ports:[{e:5,d:'i'},{e:4,d:'i'},{e:2,d:'o'}],fill:'#3A4040',str:'#4C5252',band:'#B84030'},
  delta:{name:'River Delta',s:'Delta',l:'DLT',cat:'gate',gate:'delta',
    ports:[{e:0,d:'i'},{e:1,d:'o'},{e:2,d:'o'},{e:3,d:'o'},{e:4,d:'o'},{e:5,d:'o'}],
    fill:'#3A4A44',str:'#4C5C56',band:'#B84030'},

  sinkhole:{name:'Sinkhole',s:'Sink',l:'SNK',cat:'util',ports:[{e:0,d:'i'}],fill:'#282828',str:'#3A3A3A',band:'#606068'},
  beaver:{name:'Beaver Dam',s:'MUX',l:'MUX',cat:'util',gate:'mux',
    ports:[{e:0,d:'i'},{e:2,d:'o'},{e:4,d:'o'}],fill:'#4A4030',str:'#5C5242',band:'#606068'},

  barren:   {name:'Barren',s:'Barren',l:'..',cat:'ter',ports:[],fill:'#2E2E2C',str:'#404040',band:'#5A7A4A'},
  scrubland:{name:'Scrubland',s:'Scrub',l:',,',cat:'ter',ports:[],fill:'#3A4230',str:'#4C5442',band:'#5A7A4A'},
  grassland:{name:'Grassland',s:'Grass',l:'///',cat:'ter',ports:[],fill:'#304A22',str:'#425C34',band:'#5A7A4A'},
  forest:   {name:'Forest',s:'Forest',l:'TTT',cat:'ter',ports:[],fill:'#243E1C',str:'#36502E',band:'#5A7A4A'},
  oldgrowth:{name:'Old Growth',s:'Ancient',l:'OOO',cat:'ter',ports:[],fill:'#1C3218',str:'#2E442A',band:'#5A7A4A'},
  wetland:  {name:'Wetland',s:'Wetland',l:'~~~',cat:'ter',ports:[],fill:'#2A3A30',str:'#3C4C42',band:'#5A7A4A'},
  pond:     {name:'Pond',s:'Pond',l:'o',cat:'ter',ports:[],fill:'#283848',str:'#3A4A5A',band:'#5A7A4A'},
  lake:     {name:'Lake',s:'Lake',l:'O',cat:'ter',ports:[],fill:'#1E3050',str:'#304262',band:'#5A7A4A'},
};

const CATS=[
  {id:'src',label:'Source',c:'#3A7CA5',t:['glacial','snowmelt','underground','well']},
  {id:'wire',label:'Wire',c:'#8B7020',t:['river','creek','bend','canal','tributary','bridge']},
  {id:'mod',label:'Mod',c:'#7A6050',t:['crevasse','narrows','rapids','waterfall']},
  {id:'gate',label:'Gate',c:'#B84030',t:['dry_riverbed','confluence','dammed','karst','artesian','seesaw','delta']},
  {id:'util',label:'Util',c:'#606068',t:['sinkhole','beaver']},
  {id:'ter',label:'Land',c:'#5A7A4A',t:['barren','scrubland','grassland','forest','oldgrowth','wetland','pond','lake']},
];

// ─── Flow ───
function resolveFlow(board,wells,muxCfg) {
  const fl={}, vis=new Set();
  function gf(k){if(!fl[k])fl[k]={edges:{},draws:[],_gi:{},_notIn:false,_anyIn:false};return fl[k];}

  // Resolve port edge with mirror+rotation
  function tp(tile,pe) { return rp(pe, tile.rotation, tile.mirror); }

  function trace(q,r,outE,tok) {
    if(tok<=0) return;
    const k=hk(q,r), vk=`${k}:${outE}`;
    if(vis.has(vk)) return;
    vis.add(vk);
    const f=gf(k);
    f.edges[outE]=Math.max(f.edges[outE]||0,tok);

    const n=nbr(q,r,outE), nk=hk(n.q,n.r), nt=board[nk];
    if(!nt) return;
    const nd=T[nt.type], ie=opp(outE), nf=gf(nk);
    nf.edges[ie]=Math.max(nf.edges[ie]||0,tok);

    if(nd.cat==='ter') return;

    // Sinkhole
    if(nd.cat==='util'&&!nd.gate){
      const ai=tp(nt,nd.ports.find(p=>p.d==='i').e);
      if(ai===ie) nf.draws.push({from:ie,to:-1,tokens:tok});
      return;
    }

    // NOT
    if(nd.gate==='not'){
      if(tp(nt,nd.ports.find(p=>p.d==='i').e)===ie) nf._notIn=true;
      return;
    }

    // NAND
    if(nd.gate==='nand'){
      const ins=nd.ports.filter(p=>p.d==='i').map(p=>tp(nt,p.e));
      if(!ins.includes(ie)) return;
      nf._gi[ie]=tok; nf._anyIn=true;
      if(ins.every(i2=>nf._gi[i2]>0)) nf._notIn=true;
      return;
    }

    // NOR
    if(nd.gate==='nor'){
      const ins=nd.ports.filter(p=>p.d==='i').map(p=>tp(nt,p.e));
      if(!ins.includes(ie)) return;
      nf._anyIn=true;
      return;
    }

    // XOR
    if(nd.gate==='xor'){
      const ins=nd.ports.filter(p=>p.d==='i').map(p=>tp(nt,p.e));
      const ao=tp(nt,nd.ports.find(p=>p.d==='o').e);
      if(!ins.includes(ie)) return;
      nf._gi[ie]=tok;
      const present=ins.filter(i2=>nf._gi[i2]>0);
      nf.draws=nf.draws.filter(d=>d.to!==ao);
      if(present.length===1){
        const val=nf._gi[present[0]];
        nf.draws.push({from:present[0],to:ao,tokens:val});
        vis.delete(`${nk}:${ao}`);
        trace(n.q,n.r,ao,val);
      }
      return;
    }

    // AND min
    if(nd.gate==='and_min'){
      const ins=nd.ports.filter(p=>p.d==='i').map(p=>tp(nt,p.e));
      const ao=tp(nt,nd.ports.find(p=>p.d==='o').e);
      if(!ins.includes(ie)) return;
      nf._gi[ie]=tok;
      if(ins.every(i2=>nf._gi[i2]>0)){
        const mv=Math.min(...ins.map(i2=>nf._gi[i2]));
        nf.draws=nf.draws.filter(d=>d.to!==ao);
        ins.forEach(i2=>nf.draws.push({from:i2,to:ao,tokens:mv}));
        trace(n.q,n.r,ao,mv);
      }
      return;
    }

    // OR add
    if(nd.gate==='or_add'){
      const ins=nd.ports.filter(p=>p.d==='i').map(p=>tp(nt,p.e));
      const ao=tp(nt,nd.ports.find(p=>p.d==='o').e);
      if(!ins.includes(ie)) return;
      nf._gi[ie]=tok;
      const sum=Math.min(3,Object.values(nf._gi).reduce((a,b)=>a+b,0));
      nf.draws=nf.draws.filter(d=>d.to!==ao);
      Object.keys(nf._gi).forEach(i2=>nf.draws.push({from:parseInt(i2),to:ao,tokens:sum}));
      vis.delete(`${nk}:${ao}`);
      trace(n.q,n.r,ao,sum);
      return;
    }

    // Delta
    if(nd.gate==='delta'){
      const ai=tp(nt,nd.ports.find(p=>p.d==='i').e);
      if(ai!==ie||tok<1) return;
      nd.ports.filter(p=>p.d==='o').forEach(op=>{
        const ao=tp(nt,op.e);
        nf.draws.push({from:ie,to:ao,tokens:1});
        nf.edges[ao]=Math.max(nf.edges[ao]||0,1);
        trace(n.q,n.r,ao,1);
      });
      return;
    }

    // Splitter
    if(nd.gate==='split'){
      const ai=tp(nt,nd.ports.find(p=>p.d==='i').e);
      if(ai!==ie) return;
      const outs=nd.ports.filter(p=>p.d==='o').map(p=>tp(nt,p.e));
      const hi=Math.ceil(tok/2),lo=Math.floor(tok/2);
      if(outs[0]!==undefined&&hi>0){nf.draws.push({from:ie,to:outs[0],tokens:hi});nf.edges[outs[0]]=Math.max(nf.edges[outs[0]]||0,hi);trace(n.q,n.r,outs[0],hi);}
      if(outs[1]!==undefined&&lo>0){nf.draws.push({from:ie,to:outs[1],tokens:lo});nf.edges[outs[1]]=Math.max(nf.edges[outs[1]]||0,lo);trace(n.q,n.r,outs[1],lo);}
      return;
    }

    // Bridge (crossover)
    if(nd.gate==='cross'){
      const pA_i=tp(nt,5),pA_o=tp(nt,2),pB_i=tp(nt,0),pB_o=tp(nt,3);
      if(ie===pA_i){nf.draws.push({from:ie,to:pA_o,tokens:tok});trace(n.q,n.r,pA_o,tok);}
      else if(ie===pB_i){nf.draws.push({from:ie,to:pB_o,tokens:tok});trace(n.q,n.r,pB_o,tok);}
      return;
    }

    // MUX
    if(nd.gate==='mux'){
      const ai=tp(nt,nd.ports.find(p=>p.d==='i').e);
      if(ai!==ie) return;
      const outs=nd.ports.filter(p=>p.d==='o').map(p=>tp(nt,p.e));
      const cfg=muxCfg[nk]||0;
      if(cfg===0||cfg===2){if(outs[0]!==undefined){const v=cfg===2?Math.ceil(tok/2):tok;nf.draws.push({from:ie,to:outs[0],tokens:v});trace(n.q,n.r,outs[0],v);}}
      if(cfg===1||cfg===2){if(outs[1]!==undefined){const v=cfg===2?Math.floor(tok/2):tok;nf.draws.push({from:ie,to:outs[1],tokens:v});trace(n.q,n.r,outs[1],v);}}
      return;
    }

    // Bidir
    if(nd.bidir){
      const acts=nd.ports.filter(p=>p.d==='b').map(p=>tp(nt,p.e));
      if(!acts.includes(ie)) return;
      const ao=acts.find(a=>a!==ie);
      if(ao===undefined) return;
      nf.draws.push({from:ie,to:ao,tokens:tok});
      trace(n.q,n.r,ao,tok);
      return;
    }

    // Standard wire/modifier
    for(const port of nd.ports){
      if(port.d==='i'){
        const ai=tp(nt,port.e);
        if(ai===ie){
          const op=nd.ports.find(p=>p.d==='o');
          if(!op) return;
          let out=tok;
          if(nd.clamp!==undefined) out=Math.min(out,nd.clamp);
          if(nd.amp!==undefined&&tok>=1) out=nd.amp;
          if(nd.red!==undefined) out=Math.max(0,out-nd.red);
          if(out<=0) return;
          const ao=tp(nt,op.e);
          nf.draws.push({from:ie,to:ao,tokens:out});
          trace(n.q,n.r,ao,out);
        }
      }
    }
  }

  // Sources
  for(const[k,tile]of Object.entries(board)){
    const d=T[tile.type];
    if(d.cat!=='src') continue;
    if(d.isWell&&!wells[k]) continue;
    const[q,r]=k.split(',').map(Number);
    const ao=tp(tile,d.ports.find(p=>p.d==='o').e);
    const f=gf(k);
    f.draws.push({from:-1,to:ao,tokens:d.w});
    trace(q,r,ao,d.w);
  }

  // Dams Respond
  for(const[k,tile]of Object.entries(board)){
    const d=T[tile.type],nf=gf(k);
    const[q,r]=k.split(',').map(Number);
    if(d.gate==='not'&&!nf._notIn){
      const ao=tp(tile,d.ports.find(p=>p.d==='o').e);
      nf.draws.push({from:-1,to:ao,tokens:d.notPow});trace(q,r,ao,d.notPow);
    }
    if(d.gate==='nand'&&!nf._notIn){
      const ao=tp(tile,d.ports.find(p=>p.d==='o').e);
      nf.draws.push({from:-1,to:ao,tokens:d.notPow});trace(q,r,ao,d.notPow);
    }
    if(d.gate==='nor'&&!nf._anyIn){
      const ao=tp(tile,d.ports.find(p=>p.d==='o').e);
      nf.draws.push({from:-1,to:ao,tokens:d.notPow});trace(q,r,ao,d.notPow);
    }
  }
  return fl;
}

function getAdj(board,fl){
  const adj={};
  for(const[k,tile]of Object.entries(board)){
    if(T[tile.type].cat!=='ter') continue;
    const[q,r]=k.split(',').map(Number);
    let flowing=false,direct=0;
    for(let e=0;e<6;e++){
      const n=nbr(q,r,e),nk=hk(n.q,n.r),nf=fl[nk];
      if(nf?.draws?.some(d=>d.tokens>0&&d.to>=0)) flowing=true;
      if(nf)for(const d of nf.draws){if(d.to===opp(e)&&d.tokens>0)direct=Math.max(direct,d.tokens);}
    }
    adj[k]={flowing,direct};
  }
  return adj;
}

function growTerrain(board,adj){
  const ch={};
  for(const[k,info]of Object.entries(adj)){
    const tile=board[k];if(!tile)continue;
    const ty=tile.type,{flowing,direct}=info;
    if(direct>0){
      if(['barren','scrubland','grassland','forest','oldgrowth'].includes(ty)){
        ch[k]=direct>=3?'lake':direct>=2?'pond':'wetland';
      }
      continue;
    }
    if(flowing){
      if(ty==='barren')ch[k]='scrubland';
      else if(ty==='scrubland')ch[k]='grassland';
      else if(ty==='grassland')ch[k]='forest';
      else if(ty==='forest')ch[k]='oldgrowth';
    } else {
      if(ty==='oldgrowth')ch[k]='forest';
      else if(ty==='forest')ch[k]='grassland';
    }
  }
  return ch;
}

function harvest(board){
  let seed=0,wood=0,wisdom=0,reed=0;
  for(const tile of Object.values(board)){
    const t=tile.type;
    if(t==='scrubland')seed+=1;else if(t==='grassland')seed+=2;
    else if(t==='forest')wood+=1;else if(t==='oldgrowth'){wood+=2;wisdom+=1;}
    else if(t==='wetland'||t==='pond'||t==='lake')reed+=1;
  }
  return{seed,wood,wisdom,reed};
}

// ─── Drawing ───
function Arr({cx,cy,edge,dir}){
  const m=eMid(cx,cy,edge),n=eNorm(edge);
  const isOut=dir==='o'||dir==='b';
  const col=dir==='o'?'#90C0E0':dir==='b'?'#D0C060':'#5080A0';
  if(isOut){
    const tx=m.x+n.x*9,ty=m.y+n.y*9,bx=m.x-n.x*2,by=m.y-n.y*2;
    const px=-n.y,py=n.x;
    return <g>
      <line x1={bx} y1={by} x2={tx} y2={ty} stroke={col} strokeWidth={1.8} strokeLinecap="round" opacity={0.85}/>
      <polygon points={`${tx},${ty} ${tx-n.x*4.5+px*2.8},${ty-n.y*4.5+py*2.8} ${tx-n.x*4.5-px*2.8},${ty-n.y*4.5-py*2.8}`} fill={col} opacity={0.85}/>
    </g>;
  }
  return <circle cx={m.x-n.x*3} cy={m.y-n.y*3} r={2.5} fill="none" stroke={col} strokeWidth={1.5} opacity={0.7}/>;
}

function wPath(cx,cy,from,to){
  if(to<0) return '';
  const t=eMid(cx,cy,to),f=from<0?{x:cx,y:cy}:eMid(cx,cy,from);
  const mx=(f.x+t.x)/2+(cy-(f.y+t.y)/2)*0.15;
  const my=(f.y+t.y)/2+((f.x+t.x)/2-cx)*0.15;
  return `M${f.x},${f.y} Q${mx},${my} ${t.x},${t.y}`;
}
const wCol=n=>n>=3?'#2090FF':n>=2?'#50AAFF':'#80CCFF';
const wWid=n=>n>=3?5:n>=2?3.5:2;

// ─── Main ───
export default function RiverFlows(){
  const[board,setBoard]=useState({});
  const[sel,setSel]=useState(null);
  const[bSel,setBSel]=useState(null);
  const[fl,setFl]=useState({});
  const[adj,setAdj]=useState({});
  const[rm,setRm]=useState(false);
  const[wells,setWells]=useState({});
  const[muxCfg,setMuxCfg]=useState({});
  const[cat,setCat]=useState('src');
  const[turn,setTurn]=useState(0);
  const[res,setRes]=useState({seed:0,wood:0,wisdom:0,reed:0});
  const[log,setLog]=useState([]);
  const svgRef=useRef(null);
  const hexes=useMemo(()=>genGrid(RAD),[]);

  const pad=S*2.5;
  const allPx=hexes.map(h=>h2p(h.q,h.r));
  const x0=Math.min(...allPx.map(p=>p.x))-pad;
  const x1=Math.max(...allPx.map(p=>p.x))+pad;
  const y0=Math.min(...allPx.map(p=>p.y))-pad;
  const y1=Math.max(...allPx.map(p=>p.y))+pad;
  const vW=x1-x0,vH=y1-y0;

  const s2h=useCallback((cx,cy)=>{
    const svg=svgRef.current;if(!svg)return null;
    const r=svg.getBoundingClientRect();
    const sx=x0+((cx-r.left)/r.width)*vW,sy=y0+((cy-r.top)/r.height)*vH;
    let best=null,bd=S*0.88;
    for(const h of hexes){const p=h2p(h.q,h.r);const d=Math.sqrt((p.x-sx)**2+(p.y-sy)**2);if(d<bd){best=h;bd=d;}}
    return best;
  },[hexes,x0,y0,vW,vH]);

  const tap=useCallback((q,r)=>{
    const k=hk(q,r);
    if(rm){setBoard(p=>{const n={...p};delete n[k];return n;});setBSel(null);setFl({});setAdj({});return;}
    if(board[k]){setBSel(p=>p===k?null:k);setSel(null);}
    else if(sel){setBoard(p=>({...p,[k]:{type:sel,rotation:0,mirror:false}}));setBSel(null);setFl({});setAdj({});}
  },[board,sel,rm]);

  const rot=useCallback(dir=>{
    if(!bSel||!board[bSel])return;
    setBoard(p=>({...p,[bSel]:{...p[bSel],rotation:(p[bSel].rotation+(dir==='cw'?1:5))%6}}));
    setFl({});setAdj({});
  },[bSel,board]);

  const mirror=useCallback(()=>{
    if(!bSel||!board[bSel])return;
    setBoard(p=>({...p,[bSel]:{...p[bSel],mirror:!p[bSel].mirror}}));
    setFl({});setAdj({});
  },[bSel,board]);

  const click=useCallback(e=>{const h=s2h(e.clientX,e.clientY);if(h)tap(h.q,h.r);},[s2h,tap]);
  const tRef=useRef({x:0,y:0,m:false});
  const ts=useCallback(e=>{if(e.touches.length===1)tRef.current={x:e.touches[0].clientX,y:e.touches[0].clientY,m:false};},[]);
  const tm=useCallback(e=>{if(e.touches.length===1){const dx=e.touches[0].clientX-tRef.current.x,dy=e.touches[0].clientY-tRef.current.y;if(Math.abs(dx)>10||Math.abs(dy)>10)tRef.current.m=true;}},[]);
  const te=useCallback(e=>{if(!tRef.current.m&&e.changedTouches.length===1){const t2=e.changedTouches[0];const h=s2h(t2.clientX,t2.clientY);if(h)tap(h.q,h.r);}},[s2h,tap]);

  const runFlow=useCallback(()=>{const f=resolveFlow(board,wells,muxCfg);setFl(f);setAdj(getAdj(board,f));},[board,wells,muxCfg]);

  const endTurn=useCallback(()=>{
    const f=resolveFlow(board,wells,muxCfg);setFl(f);
    const a=getAdj(board,f);setAdj(a);
    const ch=growTerrain(board,a);const msgs=[];
    if(Object.keys(ch).length>0){
      const nb2={...board};
      for(const[k,nt]of Object.entries(ch)){msgs.push(`${T[nb2[k].type].s}>${T[nt].s}`);nb2[k]={...nb2[k],type:nt};}
      setBoard(nb2);
      const f2=resolveFlow(nb2,wells,muxCfg);setFl(f2);setAdj(getAdj(nb2,f2));
    }
    const h=harvest(board);
    setRes(p=>({seed:p.seed+h.seed,wood:p.wood+h.wood,wisdom:p.wisdom+h.wisdom,reed:p.reed+h.reed}));
    const pts=[];
    if(h.seed)pts.push(`+${h.seed}sd`);if(h.wood)pts.push(`+${h.wood}wd`);
    if(h.wisdom)pts.push(`+${h.wisdom}wi`);if(h.reed)pts.push(`+${h.reed}rd`);
    if(pts.length)msgs.push(pts.join(' '));
    setTurn(p=>p+1);setLog(msgs.length>0?msgs:['--']);
  },[board,wells,muxCfg]);

  const sd=bSel&&board[bSel]?T[board[bSel].type]:null;
  const sr=bSel&&board[bSel]?board[bSel].rotation:0;
  const sm=bSel&&board[bSel]?board[bSel].mirror:false;
  const sp=sd?sd.ports.map(p=>{
    const ae=rp(p.e,sr,sm);
    const dir=p.d==='i'||p.d==='i2'?'in':p.d==='o'||p.d==='o2'?'out':'bi';
    return `${dir}:${EN[ae]}`;
  }).join(' '):'';
  const isMux=sd&&sd.gate==='mux';
  const muxVal=bSel?muxCfg[bSel]||0:0;

  // Button style helpers
  const btn=(bg,fg,extra)=>({padding:'5px 8px',borderRadius:5,border:'none',fontSize:10,fontWeight:600,cursor:'pointer',background:bg,color:fg,...extra});
  const ctrlBtn=(bg,fg,extra)=>({width:36,height:30,borderRadius:6,border:'1px solid #303848',background:bg,color:fg,fontSize:15,fontWeight:700,cursor:'pointer',lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center',...extra});

  return(
    <div style={{width:'100vw',height:'100dvh',display:'flex',flexDirection:'column',background:'#131517',overflow:'hidden',
      fontFamily:"'SF Pro Text','Segoe UI',system-ui,sans-serif",userSelect:'none',WebkitUserSelect:'none'}}>

      {/* Top */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'6px 10px',background:'#1A1C20',borderBottom:'1px solid #252830',flexShrink:0}}>
        <div style={{display:'flex',alignItems:'center',gap:6}}>
          <span style={{color:'#4A88AA',fontSize:10,fontWeight:700,letterSpacing:'1.2px',textTransform:'uppercase'}}>River Flows</span>
          <span style={{color:'#404858',fontSize:9}}>T{turn}</span>
        </div>
        <div style={{display:'flex',gap:3,fontSize:8,color:'#5A7068'}}>
          <span>{res.seed}sd</span><span>{res.wood}wd</span><span>{res.wisdom}wi</span><span>{res.reed}rd</span>
        </div>
        <div style={{display:'flex',gap:4}}>
          <button onClick={()=>{setRm(!rm);setSel(null);setBSel(null);}} style={btn(rm?'#6A2020':'#252830',rm?'#FF9090':'#5A6878')}>DEL</button>
          <button onClick={runFlow} style={btn('#1A4A68','#80C0E0')}>FLOW</button>
          <button onClick={endTurn} style={btn('#1A5A30','#80D0A0')}>TURN</button>
        </div>
      </div>

      {/* Context */}
      <div style={{minHeight:38,display:'flex',alignItems:'center',justifyContent:'center',background:'#181A1E',
        borderBottom:'1px solid #222530',fontSize:10,color:'#5A6878',padding:'3px 10px',gap:6,flexShrink:0,flexWrap:'wrap'}}>
        {bSel&&sd?(<>
          <span style={{color:'#8AA0B8',fontWeight:600,fontSize:11}}>{sd.s}{sm?' [M]':''}</span>
          <span style={{color:'#3A4A5A',fontSize:7}}>{sp}</span>
          <button onClick={()=>rot('ccw')} style={ctrlBtn('#222830','#8AB0D0')}>↶</button>
          <button onClick={()=>rot('cw')} style={ctrlBtn('#222830','#8AB0D0')}>↷</button>
          <button onClick={mirror} style={ctrlBtn(sm?'#2A3848':'#222830',sm?'#80D0F0':'#6080A0')}>⇔</button>
          {sd.isWell&&<button onClick={()=>setWells(p=>({...p,[bSel]:!p[bSel]}))}
            style={btn(wells[bSel]?'#1A4A30':'#3A2020',wells[bSel]?'#70D0A0':'#D08080',{fontSize:9})}>
            {wells[bSel]?'ON':'OFF'}</button>}
          {isMux&&<button onClick={()=>setMuxCfg(p=>({...p,[bSel]:((p[bSel]||0)+1)%3}))}
            style={btn('#3A3020','#D0B060',{fontSize:9})}>
            {['Out1','Out2','Both'][muxVal]}</button>}
          <button onClick={()=>setBSel(null)} style={btn('#252830','#5A6878',{fontSize:9})}>OK</button>
        </>):log.length>0&&turn>0?(
          <span style={{color:'#6A8A70',fontSize:9}}>{log.join(' | ')}</span>
        ):rm?(
          <span style={{color:'#D08080'}}>Tap tile to remove</span>
        ):sel?(
          <span>Place: <b style={{color:'#8AB0D0'}}>{T[sel].s}</b></span>
        ):(
          <span>Select tile, tap grid. Tap placed tile to edit.</span>
        )}
      </div>

      {/* Grid */}
      <div style={{flex:1,position:'relative',overflow:'hidden'}}
        onTouchStart={ts} onTouchMove={tm} onTouchEnd={te}>
        <svg ref={svgRef} viewBox={`${x0} ${y0} ${vW} ${vH}`}
          style={{width:'100%',height:'100%',display:'block'}} onClick={click} preserveAspectRatio="xMidYMid meet">
          <defs>
            <filter id="gl"><feGaussianBlur stdDeviation="2" result="b"/>
              <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          </defs>
          {hexes.map(({q,r})=>{
            const p=h2p(q,r),k=hk(q,r),tile=board[k],d=tile?T[tile.type]:null;
            const hf=fl[k],a=adj[k],isSel=bSel===k;
            return <g key={k}>
              <polygon points={hexPts(p.x,p.y)}
                fill={d?d.fill:'#181A1E'}
                stroke={isSel?'#D0A840':rm&&d?'#802020':a?.direct>0?'#2870A0':a?.flowing?'#307828':d?d.str:'#222530'}
                strokeWidth={isSel?2.5:d?1:0.5} opacity={d?1:0.45}/>

              {d&&(()=>{const va=vtx(p.x,p.y,1),vb=vtx(p.x,p.y,2);
                return <line x1={va.x} y1={va.y} x2={vb.x} y2={vb.y} stroke={d.band} strokeWidth={2.5} strokeLinecap="round" opacity={0.8}/>;})()}

              {/* Mirror indicator */}
              {d&&tile.mirror&&(()=>{const va=vtx(p.x,p.y,4),vb=vtx(p.x,p.y,5);
                return <line x1={va.x} y1={va.y} x2={vb.x} y2={vb.y} stroke="#606880" strokeWidth={1.5} strokeLinecap="round" opacity={0.5} strokeDasharray="2 2"/>;})()}

              {d&&d.ports.map((port,i)=>{
                const ae=rp(port.e,tile.rotation,tile.mirror);
                const dir=port.d==='i2'?'i':port.d==='o2'?'o':port.d;
                return <Arr key={i} cx={p.x} cy={p.y} edge={ae} dir={dir}/>;
              })}
              {d&&d.ports.filter(p2=>p2.d==='b').map((port,i)=>{
                const ae=rp(port.e,tile.rotation,tile.mirror);
                return <Arr key={`b${i}`} cx={p.x} cy={p.y} edge={ae} dir="i"/>;
              })}

              {d&&<>
                <text x={p.x} y={p.y-2} textAnchor="middle"
                  style={{fontSize:d.cat==='ter'?11:10,fontWeight:700,fill:'#C0D0E0',pointerEvents:'none',fontFamily:'monospace'}}>{d.l}</text>
                <text x={p.x} y={p.y+10} textAnchor="middle"
                  style={{fontSize:6,fontWeight:600,fill:'#5A6A80',pointerEvents:'none',letterSpacing:'0.3px'}}>{d.s}</text>
              </>}

              {!d&&(()=>{const nm=eMid(p.x,p.y,0);
                return <text x={nm.x} y={nm.y+3} textAnchor="middle"
                  style={{fontSize:4.5,fill:'#282C38',pointerEvents:'none',fontWeight:700}}>N</text>;})()}

              {hf&&hf.draws.filter(dd=>dd.tokens>0&&dd.to>=0).map((dd,i)=>
                <path key={`w${i}`} d={wPath(p.x,p.y,dd.from,dd.to)}
                  fill="none" stroke={wCol(dd.tokens)} strokeWidth={wWid(dd.tokens)}
                  strokeLinecap="round" opacity={0.8} filter="url(#gl)"/>)}

              {hf&&Object.entries(hf.edges).map(([edge,tk])=>{
                if(tk<=0)return null;
                const m=eMid(p.x,p.y,parseInt(edge));
                return <g key={`e${edge}`}>
                  <circle cx={m.x} cy={m.y} r={3.5+tk*1.2} fill={wCol(tk)} opacity={0.2} filter="url(#gl)"/>
                  <circle cx={m.x} cy={m.y} r={2+tk*0.6} fill={wCol(tk)} opacity={0.6}/>
                  <text x={m.x} y={m.y+2.5} textAnchor="middle"
                    style={{fontSize:6,fontWeight:800,fill:'#fff',pointerEvents:'none'}}>{tk}</text>
                </g>;})}

              {a?.flowing&&!a?.direct&&<circle cx={p.x-S*0.5} cy={p.y-S*0.4} r={3} fill="#307828" opacity={0.7}/>}
              {a?.direct>0&&<g>
                <circle cx={p.x-S*0.5} cy={p.y-S*0.4} r={4} fill="#2870A0" opacity={0.7}/>
                <text x={p.x-S*0.5} y={p.y-S*0.4+2.2} textAnchor="middle"
                  style={{fontSize:5,fill:'#fff',fontWeight:700,pointerEvents:'none'}}>{a.direct}</text></g>}

              {!d&&<circle cx={p.x} cy={p.y} r={1.2} fill={sel?'#2A3040':'#1E2028'}/>}
            </g>;
          })}
        </svg>
      </div>

      {/* Palette */}
      <div style={{background:'#1A1C20',borderTop:'1px solid #252830',flexShrink:0}}>
        <div style={{display:'flex'}}>
          {CATS.map(c=>(
            <button key={c.id} onClick={()=>{setCat(c.id);setBSel(null);}}
              style={{flex:1,padding:'5px 0',textAlign:'center',fontSize:7,fontWeight:700,
                letterSpacing:'0.3px',textTransform:'uppercase',cursor:'pointer',
                background:cat===c.id?'#1E2228':'transparent',
                color:cat===c.id?c.c:'#303848',border:'none',
                borderBottom:cat===c.id?`2px solid ${c.c}`:'2px solid transparent'}}>{c.label}</button>))}
        </div>
        <div style={{display:'flex',gap:5,padding:'6px 8px 12px',overflowX:'auto',WebkitOverflowScrolling:'touch',scrollbarWidth:'none'}}>
          {(CATS.find(c2=>c2.id===cat)?.t||[]).map(id=>{
            const t=T[id],isSel=sel===id&&!rm;
            return <button key={id} onClick={()=>{setSel(id);setRm(false);setBSel(null);}}
              style={{minWidth:54,height:44,borderRadius:7,
                border:isSel?`2px solid ${t.band}`:'1px solid #222530',
                background:isSel?t.fill:'#151719',
                display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
                gap:0,cursor:'pointer',flexShrink:0,padding:'2px 4px'}}>
              <span style={{fontSize:10,fontWeight:700,color:isSel?'#D0E0F0':'#4A5868',lineHeight:1.1,fontFamily:'monospace'}}>{t.l}</span>
              <span style={{fontSize:7,fontWeight:600,color:isSel?'#7090B0':'#2A3848',lineHeight:1.1}}>{t.s}</span>
            </button>;})}
        </div>
      </div>
    </div>
  );
}
