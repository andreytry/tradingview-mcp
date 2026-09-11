import { writeFileSync } from 'node:fs';
import { prepare, run, stats, SYMS, FROM, TO, WARMUP } from './simplezones.mjs';

const CTS      = (process.env.CTS || '1,3,5,15,30,60').split(',').map(Number);
const CTXS     = (process.env.CTXS || 'none,trend,counter,rsirev,rsimid').split(',');
const STRENGTH = [[0,0],[0.8,5],[1.0,3],[1.5,2]];
const TRIGGERS = (process.env.TRIGS || 'reject,touch').split(',');
const RRS      = (process.env.RRS || '1,1.5,2').split(',').map(Number);
const MAXRISKS = (process.env.MAXRISKS || '0,1').split(',').map(Number);

const configs = [];
for (const ct of CTS) for (const ctx of CTXS) for (const [sa, mb] of STRENGTH)
  for (const trigger of TRIGGERS) for (const rr of RRS) for (const maxRiskAtr of MAXRISKS)
    configs.push({ ct, ctx, strongAtr: sa, maxBase: mb, trigger, rr, maxRiskAtr,
      nested: true, rsiLo: 35, rsiHi: 65, slPct: 0.3, be: 0, maxBars: 0 });

const key = (c) => `ct${c.ct}|${c.ctx}|s${c.strongAtr}b${c.maxBase}|${c.trigger}|rr${c.rr}|mr${c.maxRiskAtr}`;
console.error(`${configs.length} configs x ${SYMS.length} symbols`);

const acc = new Map();
for (const sym of SYMS) {
  const t0 = Date.now();
  const S = prepare(sym, FROM, TO, WARMUP);
  if (!S) { console.error(`${sym}: no data`); continue; }
  for (const c of configs) {
    const k = key(c);
    if (!acc.has(k)) acc.set(k, { cfg: c, trades: [] });
    acc.get(k).trades.push(...run(S, sym, c, FROM));
  }
  console.error(`${sym} done in ${((Date.now()-t0)/1000).toFixed(0)}s`);
}

const rows = [];
for (const [k, v] of acc) { const s = stats(v.trades); if (s) rows.push({ k, cfg: v.cfg, ...s }); }
rows.sort((a, b) => b.totR - a.totR);
writeFileSync(process.env.OUT || '/tmp/sweep.json', JSON.stringify(rows));
const f = (x, d = 2) => (x == null ? 'n/a' : x.toFixed(d));
console.log(`${'config'.padEnd(46)} ${'n'.padStart(5)} ${'win%'.padStart(6)} ${'totR'.padStart(8)} ${'PF'.padStart(5)} ${'tpd'.padStart(5)} ${'t'.padStart(6)} ${'maxDD'.padStart(7)}`);
for (const r of rows.slice(0, 40))
  console.log(`${r.k.padEnd(46)} ${String(r.n).padStart(5)} ${f(r.win,1).padStart(6)} ${f(r.totR,1).padStart(8)} ${f(r.pf).padStart(5)} ${f(r.tpd).padStart(5)} ${f(r.t).padStart(6)} ${f(r.mddR,1).padStart(7)}`);
console.log(`\n${rows.length} scored, ${rows.filter(r=>r.totR>0).length} profitable`);
