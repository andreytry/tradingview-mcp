import { readFileSync, writeFileSync } from 'node:fs';
const D='/root/tradingview-mcp/backtest-data';
const ET='America/New_York', PM_OPEN=4*60, RTH=9*60+30, WIN_END=RTH+120;
const P={legOutAtr:0.5,maxLS:0.5,legRatio:0.25,maxSmall:10,maxWick:10,breach:0.25,maxZones:200};
const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:ET,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function et(s){const p=Object.fromEntries(fmt.formatToParts(new Date(s*1000)).map(x=>[x.type,x.value]));const h=p.hour==='24'?0:Number(p.hour);
  return {date:`${p.year}-${p.month}-${p.day}`,min:h*60+Number(p.minute),label:`${p.month}-${p.day} ${String(h).padStart(2,'0')}:${p.minute}`};}
const body=b=>Math.abs(b.close-b.open);
function agg(bars,sec){const o=[];let c=null;
  for(const b of bars){const k=Math.floor(b.time/sec)*sec;
    if(!c||c.k!==k){if(c)o.push(c);c={k,time:b.time,open:b.open,high:b.high,low:b.low,close:b.close,endIdx:b.i};}
    else{c.high=Math.max(c.high,b.high);c.low=Math.min(c.low,b.low);c.close=b.close;c.endIdx=b.i;}}
  if(c)o.push(c);return o;}
function atrS(bars,len=14){const o=new Array(bars.length).fill(null);if(bars.length<len+1)return o;
  const tr=[bars[0].high-bars[0].low];
  for(let i=1;i<bars.length;i++){const b=bars[i],pc=bars[i-1].close;
    tr.push(Math.max(b.high-b.low,Math.abs(b.high-pc),Math.abs(b.low-pc)));}
  let a=tr.slice(0,len).reduce((x,y)=>x+y,0)/len;o[len-1]=a;
  for(let i=len;i<bars.length;i++){a=(a*(len-1)+tr[i])/len;o[i]=a;}return o;}
function detect(htf,tfId,idxAt){
  const atr=atrS(htf,14),out=[];
  for(let n=1;n<htf.length;n++){
    const hist=[];for(let k=0;k<=Math.min(n,499);k++)hist.push(htf[n-k]);
    if(hist.length<P.maxSmall+2)continue;
    const cur=hist[0],cA=atr[n];if(cA==null||cA<=0)continue;
    const cB=body(cur);if(cB<cA*P.legOutAtr)continue;
    const green=cur.close>cur.open;if(cur.close===cur.open)continue;
    let small=0,idx=1,valid=false,legIn=-1;
    while(idx<=P.maxSmall&&idx<hist.length){
      const s=hist[idx],sB=body(s);
      if(small>=1&&sB>=cB*P.legRatio){valid=true;legIn=idx;break;}
      const up=s.high-Math.max(s.open,s.close),dn=Math.min(s.open,s.close)-s.low;
      if(sB>0&&Math.max(up,dn)<=sB*P.maxWick&&sB<=cB*P.maxLS){small++;idx++;}else break;}
    if(!valid&&small>=1){legIn=Math.min(idx,hist.length-1);valid=true;}
    if(!valid||legIn<=0||small<1)continue;
    const li=hist[legIn];if(li.open===li.close)continue;
    let top,bot;
    if(green){top=Math.max(hist[1].open,hist[1].close);bot=hist[0].low;
      for(let i=1;i<=small;i++){const z=hist[i];if(!z)break;top=Math.max(top,Math.max(z.open,z.close));bot=Math.min(bot,z.low);}}
    else{top=hist[0].high;bot=Math.min(hist[1].open,hist[1].close);
      for(let i=1;i<=small;i++){const z=hist[i];if(!z)break;top=Math.max(top,z.high);bot=Math.min(bot,Math.min(z.open,z.close));}}
    if(!(top>bot))continue;
    const left=hist[Math.min(small,hist.length-1)];
    out.push({tf:tfId,dem:green,top,bot,createdTime:left.time,knownAt:idxAt(n)});
  }
  return out;}
function timeline(bars,zones){
  const by=new Map();for(const z of zones){if(!by.has(z.knownAt))by.set(z.knownAt,[]);by.get(z.knownAt).push(z);}
  let act=[];const tl=new Array(bars.length);
  for(let i=0;i<bars.length;i++){const b=bars[i];
    act=act.filter(z=>{const a=(z.top-z.bot)*P.breach;return z.dem?!(b.low<z.bot-a):!(b.high>z.top+a);});
    const add=by.get(b.i);
    if(add){for(const z of add)act.unshift({...z});
      const keep=[];
      for(const z of act){const cl=keep.find(k=>k.tf===z.tf&&!(k.bot>z.top||z.bot>k.top));
        if(!cl)keep.push(z);else if(z.createdTime<cl.createdTime)keep[keep.indexOf(cl)]=z;}
      act=keep.slice(0,P.maxZones);}
    tl[i]=act;}
  return tl;}

const SYMS=[['MNQ',0.25,2],['MES',0.25,5],['MYM',1.0,0.5],['M2K',0.1,5]];
const CFG={stopBuf:0.25,maxRiskAtr:1.0,targetR:1.0,newsAtr:2.5,reclaimBars:3};
const all=[];
for(const [sym,tick,pv] of SYMS){
  const bars=JSON.parse(readFileSync(`${D}/${sym}_5m.json`));
  const m1=JSON.parse(readFileSync(`${D}/${sym}_1m.json`));
  bars.forEach(b=>b.et=et(b.time));
  const idxAtTime=t=>{let lo=0,hi=bars.length-1,r=bars.length;
    while(lo<=hi){const m=(lo+hi)>>1;if(bars[m].time>=t){r=m;hi=m-1;}else lo=m+1;}
    return r<bars.length?bars[r].i:bars.at(-1).i+1;};
  let zs=[];
  for(const [sec,tf] of [[300,0],[900,1],[3600,2]]){
    const h=agg(bars,sec);
    zs=zs.concat(detect(h,tf,(n)=>idxAtTime(n+1<h.length?h[n+1].time:h[n].time+sec)));
  }
  const tl=timeline(bars,zs);
  const atr=atrS(bars,14);
  // roll days to skip
  const rollDays=new Set();
  for(let i=1;i<bars.length;i++) if(bars[i].id!==bars[i-1].id) rollDays.add(bars[i].et.date);
  // premarket
  const pm={};
  for(const b of bars) if(b.et.min>=PM_OPEN&&b.et.min<RTH){
    const p=pm[b.et.date]??={high:-1e9,low:1e9,n:0};p.high=Math.max(p.high,b.high);p.low=Math.min(p.low,b.low);p.n++;}
  for(const d in pm)pm[d].mid=(pm[d].high+pm[d].low)/2;
  const R2=n=>Math.round(n/tick)*tick;
  // 1m index for exit resolution
  let mp=0;
  const findM1=(t)=>{while(mp<m1.length&&m1[mp][0]<t)mp++;while(mp>0&&m1[mp-1][0]>=t)mp--;return mp;};
  let nTrades=0;
  for(let i=1;i<bars.length;i++){
    const b=bars[i],p=pm[b.et.date];
    if(!p||p.n<6||rollDays.has(b.et.date))continue;
    if(b.et.min<RTH||b.et.min>=WIN_END)continue;
    const prev=bars[i-1],above=b.high>p.high,below=b.low<p.low;
    if(!above&&!below)continue;
    if(above&&prev.high>p.high)continue; if(below&&prev.low<p.low)continue;
    if(atr[i]==null||(b.high-b.low)>=CFG.newsAtr*atr[i])continue;
    const dir=above?'SHORT':'LONG',wick=above?b.high:b.low;
    const z=tl[i].find(x=>wick>=x.bot&&wick<=x.top&&(above?!x.dem:x.dem));
    if(!z)continue;
    let rec=null;
    for(let k=i+1;k<=Math.min(i+CFG.reclaimBars,bars.length-1);k++){const c=bars[k];
      if(c.close>=z.bot&&c.close<=z.top&&(above?c.close<p.high:c.close>p.low)){rec={k,c};break;}}
    if(!rec)continue;
    const buf=CFG.stopBuf*atr[i];
    const entry=rec.c.close,stop=above?R2(wick+tick+buf):R2(wick-tick-buf);
    const R=Math.abs(entry-stop);
    if(R<16*tick)continue;
    if(R>CFG.maxRiskAtr*atr[i])continue;
    const tp=above?entry-CFG.targetR*R:entry+CFG.targetR*R;
    // ---- exit on 1m bars (true intrabar sequencing) ----
    let j=findM1(rec.c.time+300), res='OPEN', exitT=null, rMult=0;
    const slip=tick;
    const e=dir==='LONG'?entry+slip:entry-slip;
    for(;j<m1.length;j++){
      const [t,o,h,l,c]=m1[j];
      const hitS=dir==='LONG'?l<=stop:h>=stop;
      const hitT=dir==='LONG'?h>=tp:l<=tp;
      if(hitS&&hitT){ // same 1m bar: use open proximity as tie-break, else assume stop
        const dS=Math.abs(o-stop),dT=Math.abs(o-tp);
        if(dT<dS){res='TARGET';}else{res='STOP';}
        exitT=t;break;}
      if(hitS){res='STOP';exitT=t;break;}
      if(hitT){res='TARGET';exitT=t;break;}
    }
    if(res==='OPEN'){const last=m1[m1.length-1];exitT=last[0];
      rMult=(dir==='LONG'?last[4]-slip-e:e-(last[4]+slip))/R;}
    else{const x=res==='STOP'?(dir==='LONG'?stop-slip:stop+slip):(dir==='LONG'?tp-slip:tp+slip);
      rMult=(dir==='LONG'?x-e:e-x)/R;}
    nTrades++;
    all.push({sym,pv,dir,label:b.et.date+' '+bars[rec.k].et.label.slice(6),date:b.et.date,
      entryTime:rec.c.time,entry:+entry.toFixed(4),stop:+stop.toFixed(4),tp:+tp.toFixed(4),
      R:+R.toFixed(4),res,r:+rMult.toFixed(4),usd:+((rMult*R*pv)-1).toFixed(2),exitT});
  }
  console.log(`${sym}: ${bars.length} 5m bars, ${zs.length} zones detected, ${Object.keys(pm).length} sessions, ${nTrades} trades`);
}
all.sort((a,b)=>a.entryTime-b.entryTime);
writeFileSync(`${D}/trades_6m.json`,JSON.stringify(all,null,1));
console.log(`\nTOTAL TRADES: ${all.length}`);
