// MFFU Rapid: intraday trailing $2,000 on equity HWM, LOCKS at +$100 once HWM hits +$2,100.
import { readFileSync } from 'node:fs';
const D='/root/tradingview-mcp/backtest-data';
const T=JSON.parse(readFileSync(`${D}/trades_6m.json`));
const M1={}; for(const s of ['MNQ','MES','MYM','M2K']) M1[s]=JSON.parse(readFileSync(`${D}/${s}_1m.json`));
const ptr={MNQ:0,MES:0,MYM:0,M2K:0};
for(const t of T){
  const m=M1[t.sym]; let i=ptr[t.sym];
  while(i<m.length&&m[i][0]<t.entryTime+300)i++; ptr[t.sym]=i;
  const sign=t.dir==='LONG'?1:-1; const path=[];
  for(let j=i;j<m.length&&m[j][0]<=t.exitT;j++){
    const [ts,o,h,l,c]=m[j];
    path.push({up:sign*((sign>0?h:l)-t.entry)/t.R, dn:sign*((sign>0?l:h)-t.entry)/t.R});
  }
  t.path=path;
}
const A={MNQ:5,MES:10,MYM:14,M2K:14};
const DD=2000, LOCK=100, TARGET=3000, COMM=0.1;
// floor per MFFU: trails at peak-DD until it would exceed LOCK, then fixed at LOCK
const floorOf=peak => Math.min(peak-DD, LOCK);

function walkActual(mult){
  let closed=0, peak=0, worstMargin=Infinity, breached=false, passedAt=null, maxDD=0;
  let n=0;
  for(const t of T){
    n++;
    const dollarR=t.R*t.pv*A[t.sym]*mult;
    for(const p of t.path){
      const hi=closed+p.up*dollarR, lo=closed+p.dn*dollarR;
      peak=Math.max(peak,hi);
      const f=floorOf(peak);
      worstMargin=Math.min(worstMargin, lo-f);
      maxDD=Math.max(maxDD, peak-lo);
      if(lo<=f) breached=true;
    }
    closed += t.r*dollarR - A[t.sym]*mult*COMM;
    peak=Math.max(peak,closed);
    const f=floorOf(peak);
    worstMargin=Math.min(worstMargin, closed-f);
    maxDD=Math.max(maxDD, peak-closed);
    if(closed<=f) breached=true;
    if(passedAt===null && closed>=TARGET) passedAt=n;
  }
  return {final:closed, maxDD, worstMargin, breached, passedAt};
}
console.log('ACTUAL 6-MONTH SEQUENCE under real MFFU rule (trailing $2,000, locks at +$100)\n');
console.log('size    final P/L   peak-to-trough   closest to breach   breached?   trades to $3,000');
for(const m of [0.5,0.75,1,1.25,1.5,2,2.5,3]){
  const r=walkActual(m);
  console.log(`${String(m+'x').padEnd(7)} $${r.final.toFixed(0).padStart(7)}   $${r.maxDD.toFixed(0).padStart(7)}          $${r.worstMargin.toFixed(0).padStart(7)}         ${r.breached?'YES  ':'no   '}      ${r.passedAt??'-'}`);
}
// Monte Carlo evaluation race with the lock rule
const risks=T.map(t=>({r:t.r, path:t.path, d:t.R*t.pv*A[t.sym]}));
const RATE=62/131, SESS_M=21, FEE=126, rnd=Math.random;
function race(mult,maxM=24,N=20000){
  let pass=0,blow=0,none=0; const months=[];
  for(let i=0;i<N;i++){
    let closed=0,peak=0,done=false,m;
    for(m=1;m<=maxM&&!done;m++){
      let n=0; for(let s=0;s<SESS_M;s++) if(rnd()<RATE) n++;
      for(let k=0;k<n&&!done;k++){
        const s=risks[Math.floor(rnd()*risks.length)];
        const dR=s.d*mult;
        for(const p of s.path){
          const hi=closed+p.up*dR, lo=closed+p.dn*dR;
          peak=Math.max(peak,hi);
          if(lo<=floorOf(peak)){blow++;done=true;months.push(m);break;}
        }
        if(done)break;
        closed += s.r*dR - 43*mult*COMM;
        peak=Math.max(peak,closed);
        if(closed<=floorOf(peak)){blow++;done=true;months.push(m);break;}
        if(closed>=TARGET){pass++;done=true;months.push(m);break;}
      }
    }
    if(!done){none++;months.push(maxM);}
  }
  const med=[...months].sort((a,b)=>a-b)[Math.floor(months.length/2)];
  return {pPass:pass/N,pBlow:blow/N,pNone:none/N,med};
}
console.log('\nEVALUATION RACE, MFFU Rapid 50K ($3,000 target, $2,000 trailing w/ $100 lock)');
console.log('size    $risk/trade   P(pass)   P(blow)   P(neither 24m)   median months   fees');
for(const m of [0.5,0.75,1,1.5,2,3]){
  const r=race(m);
  console.log(`${String(m+'x').padEnd(7)} $${String(Math.round(300*m)).padStart(5)}        ${(100*r.pPass).toFixed(0).padStart(3)}%      ${(100*r.pBlow).toFixed(0).padStart(3)}%        ${(100*r.pNone).toFixed(0).padStart(3)}%              ${String(r.med).padStart(2)}          $${r.med*FEE}`);
}
