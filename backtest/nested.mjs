/**
 * Nested Supply/Demand strategy — 6-month backtest.
 *
 * Rules implemented (see docs / Confluence "TRADING / STRATEGY"):
 *  1. HTF trend    : >=5 consecutive HH+HL (up) or LL+LH (down) on the HTF. Counter-trend disqualified.
 *  2. Nested zones : an LTF base lying ENTIRELY inside an HTF base, same direction. Standalone invalid.
 *  3. Explosive    : leg-out body >= EXPLOSIVE_ATR * ATR14 of its own timeframe.
 *  4. BOS          : the leg-out breaks the prior structural swing high (demand) / low (supply).
 *  5. FVG          : the departure leaves a 3-bar Fair Value Gap.
 *  6. Freshness    : both HTF and LTF zones strictly unmitigated before entry.
 *  7. RSI14        : long needs RSI < 70, short needs RSI > 30, measured on the entry bar.
 *  8. Entry pocket : price must trade into the band between the HTF distal edge and the LTF proximal
 *                    edge, then print an LTF rejection (pin / engulfing / CHoCH) before entry.
 *  9. Stop         : 30% of the rejecting zone's width beyond its distal line.
 * 10. Target       : next opposing unmitigated NESTED zone (proximal edge).
 * 11. RR           : minimum 1:3 or the setup is discarded.
 *
 * Exits are resolved on 1-minute bars so stop/target sequencing inside a 5m bar is honest.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const D = '/root/tradingview-mcp/backtest-data';

// ---- tunables (documented, not fitted per symbol) ----
const P = {
  HTF_SEC: Number(process.env.HTF_SEC || 3600),   // higher timeframe for trend + outer zone
  LTF_SEC: 300,         // execution timeframe + inner zone
  SWING_LR: 2,          // pivot lookleft/lookright for swing structure
  TREND_LEG: Number(process.env.TREND_LEG || 5),  // consecutive HH/HL (or LL/LH) required
  EXPLOSIVE_ATR: Number(process.env.EXPLOSIVE_ATR || 1.0),  // leg-out body vs ATR14
  BASE_MAX: 3,          // max base candles
  BASE_BODY_MAX: 0.5,   // base body <= this * leg-out body
  RSI_LEN: 14,
  RSI_LONG_MAX: 70,
  RSI_SHORT_MIN: 30,
  SL_ZONE_FRAC: 0.30,   // stop = 30% of zone width beyond distal
  MIN_RR: Number(process.env.MIN_RR || 3.0),
  FRESH_ONLY: true,
  // 'zone'   = spec: next opposing unmitigated nested zone (can be 10R+ away)
  // 'fixedR' = diagnostic: cap the target at exactly MIN_RR multiples of risk
  TP_MODE: process.env.TP_MODE || 'zone',
  // 'on'  = zone must be nested (LTF base inside HTF base)
  // 'off' = any high-quality zone trades on its own (explosive + BOS + FVG + fresh)
  NEST_MODE: process.env.NEST_MODE || 'on',
  // which timeframe supplies tradable zones when NEST_MODE=off
  ZONE_TF: process.env.ZONE_TF || 'both',
};

const ET = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function et(s) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(s * 1000)).map((x) => [x.type, x.value]));
  const h = p.hour === '24' ? 0 : Number(p.hour);
  return { date: `${p.year}-${p.month}-${p.day}`, min: h * 60 + Number(p.minute) };
}

const body = (b) => Math.abs(b.close - b.open);

function agg(bars, sec) {
  const o = []; let c = null;
  for (const b of bars) {
    const k = Math.floor(b.time / sec) * sec;
    if (!c || c.k !== k) { if (c) o.push(c); c = { k, time: k, open: b.open, high: b.high, low: b.low, close: b.close, endTime: b.time }; }
    else { c.high = Math.max(c.high, b.high); c.low = Math.min(c.low, b.low); c.close = b.close; c.endTime = b.time; }
  }
  if (c) o.push(c);
  return o;
}

function atrS(bars, len = 14) {
  const o = new Array(bars.length).fill(null);
  if (bars.length < len + 1) return o;
  const tr = [bars[0].high - bars[0].low];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  let a = tr.slice(0, len).reduce((x, y) => x + y, 0) / len; o[len - 1] = a;
  for (let i = len; i < bars.length; i++) { a = (a * (len - 1) + tr[i]) / len; o[i] = a; }
  return o;
}

function rsiS(bars, len = 14) {
  const o = new Array(bars.length).fill(null);
  if (bars.length < len + 1) return o;
  let ag = 0, al = 0;
  for (let i = 1; i <= len; i++) { const d = bars[i].close - bars[i - 1].close; if (d > 0) ag += d; else al -= d; }
  ag /= len; al /= len;
  o[len] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = len + 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    ag = (ag * (len - 1) + Math.max(d, 0)) / len;
    al = (al * (len - 1) + Math.max(-d, 0)) / len;
    o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return o;
}

/** Confirmed swing pivots. A pivot is only known LR bars after it prints. */
function swings(bars, LR) {
  const out = [];
  for (let i = LR; i < bars.length - LR; i++) {
    let hi = true, lo = true;
    for (let k = i - LR; k <= i + LR; k++) {
      if (k === i) continue;
      if (bars[k].high >= bars[i].high) hi = false;
      if (bars[k].low <= bars[i].low) lo = false;
    }
    if (hi) out.push({ i, type: 'H', price: bars[i].high, knownTime: bars[i + LR].endTime });
    if (lo) out.push({ i, type: 'L', price: bars[i].low, knownTime: bars[i + LR].endTime });
  }
  out.sort((a, b) => a.knownTime - b.knownTime);
  return out;
}

/**
 * Trend state over time: at each confirmed pivot, is there a run of >=TREND_LEG
 * higher highs AND higher lows (up) / lower lows AND lower highs (down)?
 */
function trendTimeline(sw) {
  const events = [];
  const H = [], L = [];
  for (const s of sw) {
    (s.type === 'H' ? H : L).push(s.price);
    const runUp = (arr) => { let n = 1; for (let i = arr.length - 1; i > 0; i--) { if (arr[i] > arr[i - 1]) n++; else break; } return n; };
    const runDn = (arr) => { let n = 1; for (let i = arr.length - 1; i > 0; i--) { if (arr[i] < arr[i - 1]) n++; else break; } return n; };
    let dir = 0;
    if (H.length >= P.TREND_LEG && L.length >= P.TREND_LEG && runUp(H) >= P.TREND_LEG && runUp(L) >= P.TREND_LEG) dir = 1;
    else if (H.length >= P.TREND_LEG && L.length >= P.TREND_LEG && runDn(H) >= P.TREND_LEG && runDn(L) >= P.TREND_LEG) dir = -1;
    events.push({ t: s.knownTime, dir });
  }
  return events;
}
const trendAt = (ev, t) => { let d = 0; for (const e of ev) { if (e.t <= t) d = e.dir; else break; } return d; };

/** Bullish FVG: bar[i-1].high < bar[i+1].low. Bearish: bar[i-1].low > bar[i+1].high. */
function hasFVG(bars, from, to, bull) {
  for (let i = Math.max(from, 1); i <= Math.min(to, bars.length - 2); i++) {
    if (bull && bars[i - 1].high < bars[i + 1].low) return true;
    if (!bull && bars[i - 1].low > bars[i + 1].high) return true;
  }
  return false;
}

/**
 * Detect bases with an explosive leg-out that breaks structure and leaves an FVG.
 * Returns zones with proximal/distal edges and the time they become known.
 */
function detectZones(bars, sw) {
  const atr = atrS(bars, 14);
  const out = [];
  for (let i = P.BASE_MAX + 2; i < bars.length; i++) {
    const legOut = bars[i], A = atr[i];
    if (A == null || A <= 0) continue;
    const lob = body(legOut);
    if (lob < P.EXPLOSIVE_ATR * A) continue;          // rule 3: explosive departure
    const bull = legOut.close > legOut.open;
    if (legOut.close === legOut.open) continue;

    // walk back over small-bodied base candles
    let n = 0;
    while (n < P.BASE_MAX && i - 1 - n >= 1) {
      const c = bars[i - 1 - n];
      if (body(c) <= lob * P.BASE_BODY_MAX) n++; else break;
    }
    if (n < 1) continue;
    const baseFrom = i - n, baseTo = i - 1;

    let top = -Infinity, bot = Infinity;
    for (let k = baseFrom; k <= baseTo; k++) { top = Math.max(top, bars[k].high); bot = Math.min(bot, bars[k].low); }
    if (!(top > bot)) continue;

    // rule 4: BOS — leg-out must break the last confirmed swing in its direction
    const priorSw = sw.filter((s) => s.i < baseFrom && s.type === (bull ? 'H' : 'L'));
    if (!priorSw.length) continue;
    const ref = priorSw[priorSw.length - 1].price;
    if (bull ? !(legOut.close > ref) : !(legOut.close < ref)) continue;

    // rule 5: FVG in the departure
    if (!hasFVG(bars, i - 1, i + 1, bull)) continue;

    out.push({
      dem: bull, top, bot,
      proximal: bull ? top : bot,      // edge price returns to
      distal: bull ? bot : top,        // extreme edge
      width: top - bot,
      createdIdx: i,
      knownTime: bars[i].endTime,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
const SYMS = [
  // sym, tick, pointValue, label
  ['MNQ', 0.25, 2, 'Nasdaq 100 micro'],
  ['MES', 0.25, 5, 'S&P 500 micro'],
  ['MYM', 1.0, 0.5, 'Dow micro'],
  ['M2K', 0.1, 5, 'Russell 2000 micro'],
  ['MGC', 0.1, 10, 'Gold micro'],
  ['MCL', 0.01, 100, 'Crude oil micro'],
  ['6E', 0.00005, 125000, 'Euro FX'],
];

// Extra contracts can be appended without editing this file, so a data pull and a
// regression can run as one command: EXTRA_SYMS='[["6B",0.0001,62500,"British pound"]]'
// Entries are [symbol, tick, pointValue, label] and need matching _1m/_5m files in D.
if (process.env.EXTRA_SYMS) {
  // Replace rather than append on a name clash. 6E is already in the base list, and a
  // duplicate entry would run it twice and double-count every one of its trades.
  for (const e of JSON.parse(process.env.EXTRA_SYMS)) {
    const at = SYMS.findIndex((x) => x[0] === e[0]);
    if (at >= 0) SYMS[at] = e; else SYMS.push(e);
  }
}

const all = [];
const perSym = [];

// ONLY=MYM,MNQ restricts the run to named symbols — for answering a question about one
// instrument without waiting for the whole universe.
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map((s) => s.trim()) : null;
const MAX_TOUCHES = Number(process.env.MAX_TOUCHES || 1);
// ZBAND=29195,29235 reports the life of every zone overlapping that price band.
const ZBAND = process.env.ZBAND ? process.env.ZBAND.split(',').map(Number) : null;

for (const [sym, tick, pv, label] of SYMS) {
  if (ONLY && !ONLY.includes(sym)) continue;
  let bars, m1;
  try {
    bars = JSON.parse(readFileSync(`${D}/${sym}_5m.json`));
    m1 = JSON.parse(readFileSync(`${D}/${sym}_1m.json`));
  } catch { console.log(`${sym}: no data, skipped`); continue; }

  const ltf = bars.map((b, i) => ({ ...b, i, endTime: b.time + P.LTF_SEC }));
  const htf = agg(bars, P.HTF_SEC);

  const swH = swings(htf, P.SWING_LR);
  const swL = swings(ltf, P.SWING_LR);
  const trend = trendTimeline(swH);

  const zH = detectZones(htf, swH);
  const zL = detectZones(ltf, swL);

  // Tradable-zone construction.
  const nested = [];
  if (P.NEST_MODE === 'on') {
    // rule 2 (strict): LTF base entirely inside an HTF base, same direction
    for (const h of zH) {
      for (const l of zL) {
        if (l.dem !== h.dem) continue;
        if (l.knownTime < h.knownTime) continue;           // inner must exist by/after outer
        if (!(l.top <= h.top && l.bot >= h.bot)) continue; // strictly inside
        nested.push({
          dem: h.dem, htf: h, ltf: l,
          knownTime: Math.max(h.knownTime, l.knownTime),
          // rule 8: pocket = HTF distal edge .. LTF proximal edge
          pocketLo: Math.min(h.distal, l.proximal),
          pocketHi: Math.max(h.distal, l.proximal),
          mitigated: false,
        });
      }
    }
  } else {
    // Nesting dropped. Every zone that already passed the quality gates
    // (explosive leg-out >=1 ATR, break of structure, FVG) stands on its own.
    // The pocket is simply the zone body: proximal edge .. distal edge.
    const pool = [];
    if (P.ZONE_TF === 'ltf' || P.ZONE_TF === 'both') pool.push(...zL);
    if (P.ZONE_TF === 'htf' || P.ZONE_TF === 'both') pool.push(...zH);
    for (const z of pool) {
      nested.push({
        dem: z.dem, htf: z, ltf: z,
        knownTime: z.knownTime,
        pocketLo: z.bot, pocketHi: z.top,
        mitigated: false,
      });
    }
  }
  nested.sort((a, b) => a.knownTime - b.knownTime);

  const rsi = rsiS(ltf, P.RSI_LEN);
  const R2 = (n) => Math.round(n / tick) * tick;

  // 1m cursor for exit resolution
  let mp = 0;
  const findM1 = (t) => { while (mp < m1.length && m1[mp][0] < t) mp++; while (mp > 0 && m1[mp - 1][0] >= t) mp--; return mp; };

  // roll days to skip
  const rollDays = new Set();
  for (let i = 1; i < bars.length; i++) if (bars[i].id !== bars[i - 1].id) rollDays.add(et(bars[i].time).date);

  let inTrade = 0, nTrades = 0, seen = 0;
  const F={bars:0,trend:0,freshAligned:0,pocket:0,rsi:0,reject:0,zw:0,opp:0,rr:0};

  for (let i = 5; i < ltf.length; i++) {
    const b = ltf[i];
    // Trace sits at the very top so a bar that exits on the earliest guards still says so.
    const TRACE0 = process.env.DEBUG_AT && Math.abs(b.time - Number(process.env.DEBUG_AT)) < 1;
    if (TRACE0) {
      console.log(`  [trace] ${sym} bar ${new Date(b.time * 1000).toISOString()} O${b.open} H${b.high} L${b.low} C${b.close}`);
      if (b.time < inTrade) console.log(`  [trace] EXIT: still in a trade until ${new Date(inTrade * 1000).toISOString()}`);
      if (rollDays.has(et(b.time).date)) console.log(`  [trace] EXIT: ${et(b.time).date} is a contract roll day`);
    }
    if (b.time < inTrade) continue;
    const day = et(b.time).date;
    if (rollDays.has(day)) continue;

    F.bars++;
    const dir = trendAt(trend, b.time);
    if (TRACE0) console.log(`  [trace] trend=${dir === 1 ? 'UP' : dir === -1 ? 'DOWN' : 'NONE (blocks everything)'}`);
    if (dir === 0) continue;                                   // rule 1
    F.trend++;

    // NOTE: mitigation is applied AFTER candidate selection below. Marking it first
    // consumed the zone on the very bar that first touched it, so the first (and only
    // tradable) return was always discarded — that bug produced 7 trades in 6 months.

    // candidate: fresh nested zone aligned with trend that price is inside the pocket of
    const cands = nested.filter((z) => z.knownTime < b.time && !z.mitigated
      && (z.dem ? dir === 1 : dir === -1)
      && b.low <= z.pocketHi && b.high >= z.pocketLo);
    if (nested.some((z) => z.knownTime < b.time && !z.mitigated && (z.dem ? dir === 1 : dir === -1))) F.freshAligned++;
    if (TRACE0) {
      const aligned = nested.filter((z) => z.knownTime < b.time && !z.mitigated && (z.dem ? dir === 1 : dir === -1));
      const stale = nested.filter((z) => z.knownTime < b.time && z.mitigated && (z.dem ? dir === 1 : dir === -1));
      console.log(`  [trace] nested zones aligned with trend: ${aligned.length} fresh, ${stale.length} already mitigated`);
      for (const q of aligned.slice(-3)) {
        console.log(`  [trace]   zone ${q.dem ? 'demand' : 'supply'} pocket ${q.pocketLo}..${q.pocketHi} | this bar L${b.low} H${b.high} -> ${(b.low <= q.pocketHi && b.high >= q.pocketLo) ? 'IN POCKET' : 'not reached'}`);
      }
      // Also show zones the engine built near this price regardless of state, so a
      // disagreement with what is drawn on the chart can be attributed: either the
      // detector never made a zone there, or it made one and already retired it.
      const near = nested.filter((q) => q.knownTime < b.time
        && Math.abs((q.ltf.proximal + q.ltf.distal) / 2 - b.close) < 120);
      console.log(`  [trace] engine zones within 120pts of ${b.close}: ${near.length}`);
      for (const q of near) {
        console.log(`  [trace]   ${q.dem ? 'demand' : 'supply'} ${Math.min(q.ltf.proximal, q.ltf.distal)}..${Math.max(q.ltf.proximal, q.ltf.distal)} ${q.mitigated ? 'MITIGATED' : 'fresh'} aligned=${q.dem ? dir === 1 : dir === -1}`);
      }
      if (!cands.length) console.log(`  [trace] EXIT: price never entered the pocket of any fresh aligned zone`);
    }
    if (!cands.length) continue;
    seen++; F.pocket++;

    const z = z0(cands, b);
    // now that candidates are chosen, retire every fresh zone this bar traded into
    for (const q of nested) {
      if (q.knownTime > b.time || q.mitigated) continue;
      if (q.dem ? b.low <= q.ltf.proximal : b.high >= q.ltf.proximal) {
        // MAX_TOUCHES=1 is the spec: a zone dies on first return, on the reasoning that
        // the unfilled orders that made it are consumed there. Raising it tests whether
        // a second touch still carries an edge.
        q.touches = (q.touches ?? 0) + 1;
        if (ZBAND && Math.min(q.ltf.proximal, q.ltf.distal) <= ZBAND[1] && Math.max(q.ltf.proximal, q.ltf.distal) >= ZBAND[0]) {
          console.log(`  [zone] touch #${q.touches} at ${new Date(b.time * 1000).toISOString()} on ${q.dem ? 'demand' : 'supply'} ${Math.min(q.ltf.proximal, q.ltf.distal)}..${Math.max(q.ltf.proximal, q.ltf.distal)} (born ${new Date(q.knownTime * 1000).toISOString()})`);
        }
        if (q.touches >= MAX_TOUCHES) q.mitigated = true;
      }
    }
    // Per-bar gate trace for one timestamp, so a "why did this not trade" question is
    // answered by the production rules rather than a re-implementation of them.
    const TRACE = process.env.DEBUG_AT && Math.abs(b.time - Number(process.env.DEBUG_AT)) < 1;
    if (TRACE) {
      const aligned = nested.filter((q) => q.knownTime < b.time && !q.mitigated && (q.dem ? dir === 1 : dir === -1));
      console.log(`  [trace] ${sym} trend=${dir} nestedZones=${nested.length} freshAligned=${aligned.length} inPocket=${cands.length} chosen=${z ? (z.dem ? 'demand/LONG' : 'supply/SHORT') : 'NONE'}`);
      if (!z && aligned.length) {
        const q = aligned[aligned.length - 1];
        console.log(`  [trace] nearest aligned zone: ${q.dem ? 'demand' : 'supply'} prox=${q.ltf.proximal} distal=${q.ltf.distal} | bar H=${b.high} L=${b.low}`);
      }
    }

    if (!z) continue;

    // rule 7: RSI
    const r = rsi[i];
    if (r == null) continue;
    if (TRACE0) console.log(`  [trace] chosen ${z.dem ? 'demand/LONG' : 'supply/SHORT'} | RSI=${r.toFixed(1)} need ${z.dem ? '<70' : '>30'} -> ${(z.dem ? r < P.RSI_LONG_MAX : r > P.RSI_SHORT_MIN) ? 'ok' : 'EXIT rsi'}`);
    if (z.dem && !(r < P.RSI_LONG_MAX)) continue;
    if (!z.dem && !(r > P.RSI_SHORT_MIN)) continue;
    F.rsi++;

    // rule 8: LTF rejection on this bar
    if (TRACE0) console.log(`  [trace] rejection candle (pin/engulf/choch): ${rejection(ltf, i, z.dem) ? 'yes' : 'NO -> EXIT'}`);
    if (!rejection(ltf, i, z.dem)) continue;
    F.reject++;

    // rule 9: stop 30% of zone width beyond distal of the rejecting (LTF) zone
    const zw = z.ltf.width || (z.htf.width || 0);
    if (!(zw > 0)) continue;
    const entry = b.close;
    const stop = z.dem ? R2(z.ltf.distal - P.SL_ZONE_FRAC * zw) : R2(z.ltf.distal + P.SL_ZONE_FRAC * zw);
    // The stop MUST sit beyond the zone on the losing side of the trade. If price has
    // already traded through the whole zone, the 30%-beyond-distal rule puts the stop on
    // the PROFITABLE side of entry, which is not a trade at all — and the exit resolver
    // then scores those stop-outs as wins. 33 of 169 trades were built this way and they
    // averaged +0.857R against +0.148R for the rest, so they inflated every published
    // zones statistic. Reject the geometry instead of trading it.
    if (TRACE0) console.log(`  [trace] entry=${entry} stop=${stop} -> ${(z.dem ? stop < entry : stop > entry) ? 'ok' : 'EXIT stop on the wrong side (price traded through the zone)'}`);
    if (z.dem ? !(stop < entry) : !(stop > entry)) continue;
    const R = Math.abs(entry - stop);
    if (!(R > 0) || R < 2 * tick) continue;
    F.zw++;

    // rule 10: target = next opposing unmitigated nested zone (proximal edge)
    const opp = nested.filter((o) => o.dem !== z.dem && !o.mitigated && o.knownTime < b.time
      && (z.dem ? o.htf.proximal > entry : o.htf.proximal < entry))
      .sort((a, c) => z.dem ? a.htf.proximal - c.htf.proximal : c.htf.proximal - a.htf.proximal)[0];
    if (TRACE0) console.log(`  [trace] opposing zone for target: ${opp ? 'found' : 'NONE -> EXIT'}`);
    if (!opp) continue;
    F.opp++;
    const zoneTp = opp.htf.proximal;
    const zoneRR = Math.abs(zoneTp - entry) / R;
    // the opposing zone must still exist and clear 1:3, exactly as specified...
    if (TRACE0) console.log(`  [trace] zone RR=${zoneRR.toFixed(2)} need >=${P.MIN_RR} -> ${zoneRR >= P.MIN_RR ? 'ok' : 'EXIT rr'}`);
    if (zoneRR < P.MIN_RR) continue;
    // ...but in fixedR mode we bank at MIN_RR instead of riding to the zone.
    const tp = P.TP_MODE === 'fixedR'
      ? R2(z.dem ? entry + P.MIN_RR * R : entry - P.MIN_RR * R)
      : R2(zoneTp);
    const rr = Math.abs(tp - entry) / R;
    F.rr++;

    // ---- resolve on 1m ----
    const isLong = z.dem;
    const slip = tick;
    const e = isLong ? entry + slip : entry - slip;
    let j = findM1(b.time + P.LTF_SEC), res = 'OPEN', exitT = null, rMult = 0;
    for (; j < m1.length; j++) {
      const [t, o, h, l, c] = m1[j];
      const hitS = isLong ? l <= stop : h >= stop;
      const hitT = isLong ? h >= tp : l <= tp;
      // Same-bar ambiguity. With 1m exit bars, nearest-to-open is a fair guess. When the
      // exit series is coarser (5m), that guess flatters the result, so PESSIMISTIC_TIE
      // forces the stop and the number becomes a floor rather than an estimate.
      if (hitS && hitT) {
        res = process.env.PESSIMISTIC_TIE === '1' ? 'STOP'
            : (Math.abs(o - tp) < Math.abs(o - stop) ? 'TARGET' : 'STOP');
        exitT = t; break;
      }
      if (hitS) { res = 'STOP'; exitT = t; break; }
      if (hitT) { res = 'TARGET'; exitT = t; break; }
    }
    if (res === 'OPEN') { const last = m1[m1.length - 1]; exitT = last[0]; rMult = (isLong ? last[4] - slip - e : e - (last[4] + slip)) / R; }
    else { const x = res === 'STOP' ? (isLong ? stop - slip : stop + slip) : (isLong ? tp - slip : tp + slip); rMult = (isLong ? x - e : e - x) / R; }

    z.mitigated = true;
    inTrade = exitT;
    nTrades++;
    all.push({
      sym, pv, label, dir: isLong ? 'LONG' : 'SHORT', date: day,
      entryTime: b.time, entry: +entry.toFixed(6), stop: +stop.toFixed(6), tp: +tp.toFixed(6),
      R: +R.toFixed(6), rr: +rr.toFixed(2), rsi: +r.toFixed(1), res,
      r: +rMult.toFixed(4), usd: +((rMult * R * pv) - 1).toFixed(2), exitT,
    });
  }

  perSym.push({ sym, label, funnel: F, bars5: ltf.length, htfBars: htf.length, zHTF: zH.length, zLTF: zL.length, nested: nested.length, pocketTouch: seen, trades: nTrades });
  console.log(`  funnel ${sym}: bars ${F.bars} -> trend ${F.trend} -> freshAlignedBar ${F.freshAligned} -> inPocket ${F.pocket} -> rsiOK ${F.rsi} -> rejection ${F.reject} -> stopOK ${F.zw} -> hasTarget ${F.opp} -> rr>=3 ${F.rr}`);
  console.log(`${sym.padEnd(4)} ${String(ltf.length).padStart(6)} 5m | HTF zones ${String(zH.length).padStart(4)} | LTF zones ${String(zL.length).padStart(5)} | nested ${String(nested.length).padStart(5)} | pocket touches ${String(seen).padStart(5)} | trades ${nTrades}`);
}

/** pick the candidate whose pocket the bar is deepest into */
function z0(cands, b) {
  let best = null, bestPen = -Infinity;
  for (const z of cands) {
    const pen = z.dem ? (z.pocketHi - b.low) : (b.high - z.pocketLo);
    if (pen > bestPen) { bestPen = pen; best = z; }
  }
  return best;
}

/** rule 8 trigger: pin bar, engulfing, or change of character */
function rejection(bars, i, bull) {
  const c = bars[i], p = bars[i - 1];
  const rng = c.high - c.low; if (!(rng > 0)) return false;
  const bd = body(c);
  const upW = c.high - Math.max(c.open, c.close);
  const dnW = Math.min(c.open, c.close) - c.low;
  // pin bar: wick on the rejecting side >= 50% of range and >= 1.5x body
  if (bull && dnW >= 0.5 * rng && dnW >= 1.5 * bd) return true;
  if (!bull && upW >= 0.5 * rng && upW >= 1.5 * bd) return true;
  // engulfing
  if (bull && c.close > c.open && p.close < p.open && c.close >= p.open && c.open <= p.close) return true;
  if (!bull && c.close < c.open && p.close > p.open && c.close <= p.open && c.open >= p.close) return true;
  // change of character: close back through the prior bar's extreme
  if (bull && c.close > p.high) return true;
  if (!bull && c.close < p.low) return true;
  return false;
}

all.sort((a, b) => a.entryTime - b.entryTime);
writeFileSync(process.env.OUT || `${D}/trades_nested_6m.json`, JSON.stringify(all, null, 1));
writeFileSync(`${D}/nested_funnel.json`, JSON.stringify(perSym, null, 1));
console.log(`\nTOTAL TRADES: ${all.length}`);
