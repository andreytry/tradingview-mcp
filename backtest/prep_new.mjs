// Convert Databento 1m -> 5m + keep 1m for intrabar exit resolution.
import { readFileSync, writeFileSync } from 'node:fs';
const D='/root/tradingview-mcp/backtest-data';
for(const sym of ['MGC','MCL','6E']){
  const lines=readFileSync(`${D}/raw/${sym}_1m.csv`,'utf8').trim().split('\n');
  const h=lines[0].split(',');
  const iT=h.indexOf('ts_event'),iO=h.indexOf('open'),iH=h.indexOf('high'),iL=h.indexOf('low'),
        iC=h.indexOf('close'),iV=h.indexOf('volume'),iI=h.indexOf('instrument_id');
  const m1=[]; const rolls=new Map();
  for(let k=1;k<lines.length;k++){
    const p=lines[k].split(',');
    const t=Math.round(Number(p[iT])/1e9);
    const o=Number(p[iO])/1e9,hi=Number(p[iH])/1e9,lo=Number(p[iL])/1e9,c=Number(p[iC])/1e9,v=Number(p[iV])||0;
    if(!Number.isFinite(t)||!Number.isFinite(c)||!Number.isFinite(o))continue;
    m1.push({t,o,h:hi,l:lo,c,v,id:p[iI]});
    if(!rolls.has(p[iI])) rolls.set(p[iI],t);
  }
  m1.sort((a,b)=>a.t-b.t);
  // 5m aggregation
  const m5=[]; let cur=null;
  for(const b of m1){
    const k=Math.floor(b.t/300)*300;
    if(!cur||cur.k!==k){ if(cur)m5.push(cur); cur={k,time:k,open:b.o,high:b.h,low:b.l,close:b.c,volume:b.v,id:b.id}; }
    else { cur.high=Math.max(cur.high,b.h); cur.low=Math.min(cur.low,b.l); cur.close=b.c; cur.volume+=b.v; }
  }
  if(cur)m5.push(cur);
  writeFileSync(`${D}/${sym}_5m.json`, JSON.stringify(m5.map((b,i)=>({i,time:b.time,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume,id:b.id}))));
  writeFileSync(`${D}/${sym}_1m.json`, JSON.stringify(m1.map(b=>[b.t,b.o,b.h,b.l,b.c])));
  console.log(`${sym}: ${m1.length} 1m -> ${m5.length} 5m | instruments/rolls: ${[...rolls.entries()].map(([id,t])=>id+'@'+new Date(t*1000).toISOString().slice(0,10)).join(' ')}`);
}
