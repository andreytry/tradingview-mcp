import { readFileSync } from 'node:fs';
const T=JSON.parse(readFileSync('/root/tradingview-mcp/backtest-data/trades_6m.json'));
const ALLOC={MNQ:5,MES:10,MYM:14,M2K:14};
const risks=T.map(t=>({r:t.r, usdPer1x: t.R*t.pv*ALLOC[t.sym]}));  // $ risk at 1x sizing
const RATE=62/131, SESS_M=21, TARGET=3000, MAXDD=2000, FEE=126;
const rnd=Math.random;
function race(mult,maxM=24,N=30000){
  let pass=0,blow=0,none=0;const months=[];
  for(let i=0;i<N;i++){
    let eq=0,pk=0,done=false,m;
    for(m=1;m<=maxM&&!done;m++){
      let n=0;for(let s=0;s<SESS_M;s++)if(rnd()<RATE)n++;
      for(let k=0;k<n;k++){
        const s=risks[Math.floor(rnd()*risks.length)];
        eq += s.r*s.usdPer1x*mult - ALLOC.MNQ*0.1;
        pk=Math.max(pk,eq);
        const floor=Math.max(-MAXDD,pk-MAXDD);
        if(eq<=floor){blow++;done=true;months.push(m);break;}
        if(eq>=TARGET){pass++;done=true;months.push(m);break;}
      }
    }
    if(!done){none++;months.push(maxM);}
  }
  const med=[...months].sort((a,b)=>a-b)[Math.floor(months.length/2)];
  return {mult,pPass:pass/N,pBlow:blow/N,pNone:none/N,medMonths:med};
}
// bootstrap 6-month outcome distribution at each size
function boot(mult,N=30000){
  const eqs=[],dds=[];
  for(let i=0;i<N;i++){
    const n=Math.round(62*(0.8+0.4*rnd()));
    let eq=0,pk=0,dd=0;
    for(let k=0;k<n;k++){const s=risks[Math.floor(rnd()*risks.length)];
      eq+=s.r*s.usdPer1x*mult;pk=Math.max(pk,eq);dd=Math.max(dd,pk-eq);}
    eqs.push(eq);dds.push(dd);}
  const q=(a,x)=>{const s=[...a].sort((u,v)=>u-v);return s[Math.floor(x*s.length)];};
  return {mean:eqs.reduce((a,b)=>a+b,0)/N,p05:q(eqs,0.05),med:q(eqs,0.5),p95:q(eqs,0.95),
    dd90:q(dds,0.9),pLoss:eqs.filter(x=>x<0).length/N};
}
console.log('MEASURED INPUTS (real Globex, 6 months): 62 trades, 64.5% win, avgR +0.237, 10.3 trades/mo');
console.log('Sizing 1x = MNQ 5 / MES 10 / MYM 14 / M2K 14 micros (~$300 risk per trade)\n');
console.log('=== MFFU Rapid 50K evaluation: $3,000 target vs $2,000 EOD trailing ===');
console.log('size    $risk/trade   P(pass)   P(blow)   P(neither 24m)   median months   fees to pass');
for(const m of [0.5,1,1.5,2,3]){const r=race(m);
  console.log(`${String(m+'x').padEnd(7)} $${String(Math.round(300*m)).padStart(5)}        ${(100*r.pPass).toFixed(0).padStart(3)}%      ${(100*r.pBlow).toFixed(0).padStart(3)}%        ${(100*r.pNone).toFixed(0).padStart(3)}%              ${String(r.medMonths).padStart(2)}           $${r.medMonths*FEE}`);}
console.log('\n=== 6-month P/L distribution (bootstrapped from the 62 real trades) ===');
console.log('size    mean       p05        median     p95        maxDD(90th)  P(6m loss)');
for(const m of [0.5,1,1.5,2,3]){const b=boot(m);
  console.log(`${String(m+'x').padEnd(7)} $${b.mean.toFixed(0).padStart(7)} $${b.p05.toFixed(0).padStart(8)} $${b.med.toFixed(0).padStart(8)} $${b.p95.toFixed(0).padStart(8)} $${b.dd90.toFixed(0).padStart(9)}     ${(100*b.pLoss).toFixed(0)}%`);}
console.log('\n=== monthly income once funded (90/10 split) ===');
const evR=T.reduce((a,b)=>a+b.r,0)/T.length;
const avgRisk=risks.reduce((a,b)=>a+b.usdPer1x,0)/risks.length;
for(const m of [0.5,1,1.5,2,3]){
  const g=evR*avgRisk*m*(RATE*SESS_M);
  console.log(`  ${String(m+'x').padEnd(5)} $${String(Math.round(300*m)).padStart(4)}/trade -> gross $${g.toFixed(0).padStart(5)}/mo, net 90% $${(g*0.9).toFixed(0).padStart(5)}/mo`);
}
