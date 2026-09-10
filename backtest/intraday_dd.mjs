// Recompute drawdown under MFFU's INTRADAY trailing rule using 1m bars.
import { readFileSync } from 'node:fs';
const D='/root/tradingview-mcp/backtest-data';
const T=JSON.parse(readFileSync(`${D}/trades_6m.json`));
const M1={}; for(const s of ['MNQ','MES','MYM','M2K']) M1[s]=JSON.parse(readFileSync(`${D}/${s}_1m.json`));
const ptr={MNQ:0,MES:0,MYM:0,M2K:0};
// annotate each trade with its intra-trade equity path (in R), sampled per 1m bar
for(const t of T){
  const m=M1[t.sym]; let i=ptr[t.sym];
  while(i<m.length&&m[i][0]<t.entryTime+300)i++;
  ptr[t.sym]=i;
  const path=[]; const sign=t.dir==='LONG'?1:-1;
  for(let j=i;j<m.length&&m[j][0]<=t.exitT;j++){
    const [ts,o,h,l,c]=m[j];
    const best=sign>0? h : l, worst=sign>0? l : h;
    path.push({up:sign*(best-t.entry)/t.R, dn:sign*(worst-t.entry)/t.R});
  }
  t.mfe=path.length?Math.max(...path.map(p=>p.up)):0;
  t.mae=path.length?Math.min(...path.map(p=>p.dn)):0;
  t.path=path;
}
const A={MNQ:5,MES:10,MYM:14,M2K:14};
function ddPath(mult,rule){
  let closed=0,peak=0,dd=0;
  for(const t of T){
    const dollarR=t.R*t.pv*A[t.sym]*mult;
    if(rule==='intraday'){
      // walk the trade: equity = closed + unrealised
      for(const p of t.path){
        const hi=closed+p.up*dollarR, lo=closed+p.dn*dollarR;
        peak=Math.max(peak,hi);          // favourable excursion raises the trailing peak
        dd=Math.max(dd,peak-lo);         // then adverse excursion measured from it
      }
    }
    closed += t.r*dollarR - A[t.sym]*mult*0.1;
    peak=Math.max(peak,closed); dd=Math.max(dd,peak-closed);
  }
  return {final:closed,dd};
}
console.log('Max drawdown, MFFU intraday-trailing vs closed-equity (actual 6-month sequence)\n');
console.log('size    final P/L    DD closed-equity    DD INTRADAY trailing    50K limit $2,000');
for(const m of [0.5,0.75,1,1.5,2]){
  const a=ddPath(m,'closed'), b=ddPath(m,'intraday');
  const ok=b.dd<2000?'OK':'BREACH';
  console.log(`${String(m+'x').padEnd(7)} $${a.final.toFixed(0).padStart(7)}      $${a.dd.toFixed(0).padStart(7)}             $${b.dd.toFixed(0).padStart(7)}            ${ok}`);
}
const mfe=T.map(t=>t.mfe);
const losers=T.filter(t=>t.r<0);
console.log(`\nMFE stats: mean ${(mfe.reduce((a,b)=>a+b,0)/mfe.length).toFixed(2)}R`);
console.log(`Losing trades that first went +0.5R or better: ${losers.filter(t=>t.mfe>=0.5).length}/${losers.length}`);
console.log(`  their mean MFE: ${(losers.reduce((a,b)=>a+b.mfe,0)/losers.length).toFixed(2)}R  -> each adds MFE+1R to the trailing drawdown`);
