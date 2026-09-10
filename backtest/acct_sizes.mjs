import { readFileSync } from 'node:fs';
const D='/root/tradingview-mcp/backtest-data';
const T=JSON.parse(readFileSync(`${D}/trades_6m.json`));
const M1={}; for(const s of ['MNQ','MES','MYM','M2K']) M1[s]=JSON.parse(readFileSync(`${D}/${s}_1m.json`));
const ptr={MNQ:0,MES:0,MYM:0,M2K:0};
for(const t of T){const m=M1[t.sym];let i=ptr[t.sym];
  while(i<m.length&&m[i][0]<t.entryTime+300)i++;ptr[t.sym]=i;
  const sg=t.dir==='LONG'?1:-1;t.path=[];
  for(let j=i;j<m.length&&m[j][0]<=t.exitT;j++){const[,,h,l]=m[j];
    t.path.push({up:sg*((sg>0?h:l)-t.entry)/t.R,dn:sg*((sg>0?l:h)-t.entry)/t.R});}}
const A={MNQ:5,MES:10,MYM:14,M2K:14};
function walk(mult,DD,LOCK=100){
  let closed=0,peak=0,worst=Infinity;
  const floorOf=p=>Math.min(p-DD,LOCK);
  for(const t of T){const dR=t.R*t.pv*A[t.sym]*mult;
    for(const p of t.path){const hi=closed+p.up*dR,lo=closed+p.dn*dR;
      peak=Math.max(peak,hi);worst=Math.min(worst,lo-floorOf(peak));}
    closed+=t.r*dR-43*mult*0.1;peak=Math.max(peak,closed);
    worst=Math.min(worst,closed-floorOf(peak));}
  return {final:closed,worst};
}
const ACC=[
 {n:'Rapid 25K',price:79,dd:1000,target:1500,micros:30},
 {n:'Rapid 50K',price:126,dd:2000,target:3000,micros:50},
 {n:'Rapid 100K',price:267,dd:3000,target:6000,micros:80},
 {n:'Rapid 150K',price:347,dd:4500,target:9000,micros:100},
];
console.log('MAX SAFE SIZE per account, tested on the ACTUAL 6-month sequence');
console.log('(largest multiple keeping margin-to-breach > $250 at all times)\n');
console.log('account      $/mo   DD limit  max safe   margin left   micros   gross $/mo   net 90%   mo to target');
const rows=[];
for(const a of ACC){
  let best=0,bw=0,bf=0;
  for(let m=0.05;m<=4;m+=0.05){const r=walk(m,a.dd); if(r.worst>250){best=m;bw=r.worst;bf=r.final;}}
  const micros=Math.round(43*best);
  const g=bf/6, net=g*0.9;
  const mo=Math.ceil(a.target/g);
  rows.push({...a,best,net,g,mo,micros});
  console.log(`${a.n.padEnd(12)} $${String(a.price).padStart(4)}  $${String(a.dd).padStart(5)}    ${best.toFixed(2)}x      $${bw.toFixed(0).padStart(5)}       ${String(micros).padStart(3)}/${String(a.micros).padEnd(4)} $${g.toFixed(0).padStart(5)}      $${net.toFixed(0).padStart(5)}     ${mo}`);
}
console.log('\nMFFU caps: 3 funded accounts if any 100K/150K; 5 if only 25K/50K\n');
console.log('route                net $/mo   % of $6,000   eval fees/mo');
for(const [lab,c,i] of [['3 x Rapid 150K',3,3],['3 x Rapid 100K',3,2],['5 x Rapid 50K',5,1]]){
  const r=rows[i], net=c*r.net;
  console.log(`${lab.padEnd(20)} $${net.toFixed(0).padStart(5)}      ${(100*net/6000).toFixed(0).padStart(3)}%        $${c*r.price}`);
}
const cap=3*rows[3].net;
console.log(`\nMFFU ceiling: $${cap.toFixed(0)}/mo net. Gap to $6,000 = $${(6000-cap).toFixed(0)}/mo.`);
