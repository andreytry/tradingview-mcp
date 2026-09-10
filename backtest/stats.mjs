import { readFileSync } from 'node:fs';
const tr = JSON.parse(readFileSync(process.argv[2]));
function agg(rows){
  const n=rows.length; if(!n) return null;
  const rs=rows.map(t=>t.r), usd=rows.map(t=>t.usd);
  const gp=rs.filter(r=>r>0).reduce((a,b)=>a+b,0), gl=-rs.filter(r=>r<0).reduce((a,b)=>a+b,0);
  const byd={}; rows.forEach(t=>(byd[t.date]??=[]).push(t.r));
  const sess=Object.values(byd).map(v=>v.reduce((a,b)=>a+b,0)/v.length);
  const mean=sess.reduce((a,b)=>a+b,0)/sess.length;
  const sd=sess.length>1?Math.sqrt(sess.reduce((a,b)=>a+(b-mean)**2,0)/(sess.length-1)):0;
  const t=sd>0?mean/(sd/Math.sqrt(sess.length)):null;
  let eq=0,pk=0,mdd=0; for(const r of rs){eq+=r;pk=Math.max(pk,eq);mdd=Math.min(mdd,eq-pk);}
  return {n, win:rs.filter(r=>r>0).length/n*100, avgR:rs.reduce((a,b)=>a+b,0)/n,
    totR:rs.reduce((a,b)=>a+b,0), pf: gl>0?gp/gl:Infinity, usd:usd.reduce((a,b)=>a+b,0),
    sessions:sess.length, t, mddR:mdd, avgRR:rows.reduce((a,b)=>a+b.rr,0)/n};
}
const A=agg(tr); if(!A){console.log('no trades');process.exit(0);}
const f=(x,d=2)=>x==null?'  n/a':x.toFixed(d);
console.log(`n=${A.n} win=${f(A.win,1)}% avgR=${f(A.avgR,3)} totR=${f(A.totR)} PF=${f(A.pf)} USD=${f(A.usd,0)} sessions=${A.sessions} t=${f(A.t)} maxDD=${f(A.mddR)}R avgRRtarget=${f(A.avgRR)}`);
const bys={}; tr.forEach(t=>(bys[t.sym]??=[]).push(t));
for(const s of Object.keys(bys).sort()){const x=agg(bys[s]);
  console.log(`  ${s.padEnd(4)} n=${String(x.n).padStart(3)} win=${f(x.win,1).padStart(5)}% avgR=${f(x.avgR,3).padStart(7)} totR=${f(x.totR).padStart(7)} PF=${f(x.pf).padStart(6)} USD=${f(x.usd,0).padStart(7)}`);}
const res={}; tr.forEach(t=>res[t.res]=(res[t.res]||0)+1); console.log('  outcomes:',JSON.stringify(res));
