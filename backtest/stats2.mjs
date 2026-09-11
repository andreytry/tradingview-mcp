import { readFileSync } from 'node:fs';
const tr = JSON.parse(readFileSync(process.argv[2]));
const tag = process.argv[3] || '';
function agg(rows){
  const n=rows.length; if(!n) return null;
  const rs=rows.map(t=>t.r);
  const gp=rs.filter(r=>r>0).reduce((a,b)=>a+b,0), gl=-rs.filter(r=>r<0).reduce((a,b)=>a+b,0);
  const byd={}; rows.forEach(t=>(byd[t.date]??=[]).push(t.r));
  const days=Object.keys(byd).length;
  const sess=Object.values(byd).map(v=>v.reduce((a,b)=>a+b,0));
  const mean=sess.reduce((a,b)=>a+b,0)/sess.length;
  const sd=sess.length>1?Math.sqrt(sess.reduce((a,b)=>a+(b-mean)**2,0)/(sess.length-1)):0;
  const t=sd>0?mean/(sd/Math.sqrt(sess.length)):null;
  let eq=0,pk=0,mdd=0; for(const r of rs){eq+=r;pk=Math.max(pk,eq);mdd=Math.min(mdd,eq-pk);}
  const d0=rows.map(r=>r.date).sort(), span=(Date.parse(d0.at(-1))-Date.parse(d0[0]))/86400000+1;
  return {n, win:rs.filter(r=>r>0).length/n*100, avgR:rs.reduce((a,b)=>a+b,0)/n,
    totR:rs.reduce((a,b)=>a+b,0), pf: gl>0?gp/gl:Infinity,
    usd:rows.reduce((a,b)=>a+b.usd,0), days, tpd:n/days, tpcal:n/(span/7*5),
    t, mddR:mdd, from:d0[0], to:d0.at(-1)};
}
const A=agg(tr); const f=(x,d=2)=>x==null?'n/a':x.toFixed(d);
if(!A){console.log(`${tag} NO TRADES`);process.exit(0);}
console.log(`${tag} n=${A.n} win=${f(A.win,1)}% avgR=${f(A.avgR,3)} totR=${f(A.totR,1)} PF=${f(A.pf)} USD=${f(A.usd,0)} tradingDays=${A.days} trades/day=${f(A.tpd)} t=${f(A.t)} maxDD=${f(A.mddR,1)}R ${A.from}..${A.to}`);
if(process.env.BYSYM==='1'){const bys={};tr.forEach(t=>(bys[t.sym]??=[]).push(t));
 for(const s of Object.keys(bys).sort()){const x=agg(bys[s]);
  console.log(`   ${s.padEnd(6)} n=${String(x.n).padStart(4)} win=${f(x.win,1).padStart(5)}% avgR=${f(x.avgR,3).padStart(7)} totR=${f(x.totR,1).padStart(7)} PF=${f(x.pf).padStart(5)} USD=${f(x.usd,0).padStart(8)}`);}}
