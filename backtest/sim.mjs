/**
 * Account simulation — MFFU Rapid rules, 6 months, intrabar path on 1m bars.
 *
 *   floor(peak) = min(peak - 2000, +100)     trailing $2k, LOCKS at +$100 once peak >= +$2,100
 *   pass target = +$3,000 closed equity
 *
 * Sizing is RISK PARITY: contracts = round(riskPerTrade / (R * pointValue)), min 1.
 * That removes the R-vs-dollars mismatch (a +1R win on a tiny-R setup is not the same money
 * as a +1R win on a wide-R setup). Commission $0.50/contract/side + 1 tick slippage is
 * already inside the trade's r.
 *
 * Usage: node backtest/sim.mjs <tradesFile> [riskPerTrade...]
 */
import { readFileSync } from 'node:fs';
const D = '/root/tradingview-mcp/backtest-data';

const file = process.argv[2] || `${D}/trades_6m.json`;
const risks = process.argv.slice(3).map(Number).filter(Boolean);
const RISKS = risks.length ? risks : [100, 150, 200, 250, 300, 400, 500];

const T = JSON.parse(readFileSync(file));
const syms = [...new Set(T.map((t) => t.sym))];
const M1 = {};
for (const s of syms) M1[s] = JSON.parse(readFileSync(`${D}/${s}_1m.json`));

// attach the intrabar excursion path (in R units) for each trade
const ptr = Object.fromEntries(syms.map((s) => [s, 0]));
for (const t of T) {
  const m = M1[t.sym];
  let i = ptr[t.sym];
  while (i < m.length && m[i][0] < t.entryTime + 300) i++;
  ptr[t.sym] = i;
  const sign = t.dir === 'LONG' ? 1 : -1;
  const path = [];
  for (let j = i; j < m.length && m[j][0] <= t.exitT; j++) {
    const [, , h, l] = m[j];
    path.push({
      up: sign * ((sign > 0 ? h : l) - t.entry) / t.R,
      dn: sign * ((sign > 0 ? l : h) - t.entry) / t.R,
    });
  }
  t.path = path;
}

const DD = 2000, LOCK = 100, TARGET = 3000, COMM = 0.5 * 2; // per contract round turn
const floorOf = (peak) => Math.min(peak - DD, LOCK);

function walk(riskPerTrade, capContracts = 50) {
  let closed = 0, peak = 0, worstMargin = Infinity, maxDD = 0;
  let breached = false, breachAt = null, passedAt = null, n = 0, totalContracts = 0;
  const equity = [];
  for (const t of T) {
    n++;
    const perContract = t.R * t.pv;
    let q = Math.max(1, Math.round(riskPerTrade / perContract));
    q = Math.min(q, capContracts);
    totalContracts += q;
    const dollarR = perContract * q;
    // intrabar excursion against the trailing floor
    for (const p of t.path) {
      const hi = closed + p.up * dollarR, lo = closed + p.dn * dollarR;
      peak = Math.max(peak, hi);
      const f = floorOf(peak);
      worstMargin = Math.min(worstMargin, lo - f);
      maxDD = Math.max(maxDD, peak - lo);
      if (lo <= f && !breached) { breached = true; breachAt = n; }
    }
    closed += t.r * dollarR - q * COMM;
    peak = Math.max(peak, closed);
    const f = floorOf(peak);
    worstMargin = Math.min(worstMargin, closed - f);
    maxDD = Math.max(maxDD, peak - closed);
    if (closed <= f && !breached) { breached = true; breachAt = n; }
    if (passedAt === null && closed >= TARGET) passedAt = n;
    equity.push(+closed.toFixed(0));
  }
  return { final: closed, peak, maxDD, worstMargin, breached, breachAt, passedAt, n, avgQ: totalContracts / n, equity };
}

console.log(`file: ${file.split('/').pop()}   trades: ${T.length}   symbols: ${syms.join(',')}`);
console.log(`MFFU Rapid: trailing $${DD}, locks at +$${LOCK}, pass at +$${TARGET}\n`);
console.log(`${'risk/trade'.padStart(10)} ${'avgQty'.padStart(7)} ${'final $'.padStart(9)} ${'peak $'.padStart(8)} ${'maxDD $'.padStart(8)} ${'minMargin'.padStart(10)} ${'breach'.padStart(7)} ${'passed@'.padStart(8)}`);
for (const r of RISKS) {
  const w = walk(r);
  console.log(
    `${('$' + r).padStart(10)} ${w.avgQ.toFixed(1).padStart(7)} ${w.final.toFixed(0).padStart(9)} ${w.peak.toFixed(0).padStart(8)} ${w.maxDD.toFixed(0).padStart(8)} ${w.worstMargin.toFixed(0).padStart(10)} ${(w.breached ? 'YES@' + w.breachAt : 'no').padStart(7)} ${(w.passedAt ?? '-').toString().padStart(8)}`,
  );
}
