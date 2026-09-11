/**
 * Simplified zone strategy.
 *
 * ZONES: detection, boundaries, overlap cull and breach-death are copied verbatim from
 * backtest/sdzones.mjs, which is the line-by-line replication of
 * "Supply/Demand Zones with Zone Arrival/Departure Alerts" (USER;6fbe379234e342f081381e583d3f6e31).
 * Nothing about how a zone is found or killed is changed here.
 *
 * ENTRIES: replaced with at most three criteria.
 *   C1  nested      zone sits fully inside a live same-type zone from a higher timeframe
 *   C2  strength    leg-out body >= STRONG_ATR x ATR  AND  base <= MAX_BASE candles
 *   C3  context     one of: none | trend (with the trend) | rsirev (reversal) | rsimid
 *
 * Everything else is mechanics, not a criterion: chart timeframe, entry trigger,
 * stop distance, target and break-even.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const D = '/root/tradingview-mcp/backtest-data';

// ---- zone parameters: the live chart's values, unchanged ----------------------
const P = {
  atr_length: 14, long_atr_filter: 0.5, max_long_short_ratio: 0.5,
  leg_out_leg_in_ratio: 0.25, breach_threshold: 0.25, max_small_candles: 10,
  max_wick_ratio: 10, max_zones: 200, ema_fast_len: 20, ema_slow_len: 50,
};

/**
 * Contract specs as [tick, dollars-per-point, name]. MICRO wherever a micro exists,
 * because the smallest tradable unit decides whether a setup fits a dollar risk budget
 * at all. A zone that needs $600 of stop on the full-size contract needs $60 on the
 * micro, which is the difference between skipping it and taking it.
 *
 * Where no micro is listed by CME the full-size contract is used and flagged, so the
 * cost of that is visible rather than hidden.
 */
const SPEC = {
  // index micros
  MNQ: [0.25, 2, 'Micro Nasdaq'], MES: [0.25, 5, 'Micro S&P'],
  MYM: [1.0, 0.5, 'Micro Dow'],   M2K: [0.1, 5, 'Micro Russell'],
  // metals and energy micros
  MGC: [0.1, 10, 'Micro Gold'], MCL: [0.01, 100, 'Micro Crude'],
  CL:  [0.01, 100, 'Micro Crude (MCL)'],
  SI:  [0.005, 1000, 'Micro Silver (SIL)'],
  HG:  [0.0005, 2500, 'Micro Copper (MHG)'],
  // FX: micros exist for euro, pound, aussie only
  '6E': [0.0001, 12500, 'Micro Euro (M6E)'],
  '6B': [0.0001, 6250,  'Micro Pound (M6B)'],
  '6A': [0.0001, 10000, 'Micro Aussie (M6A)'],
  '6J': [0.0000005, 12500000, 'Yen — NO MICRO, full size'],
  '6N': [0.00005, 100000,     'Kiwi — NO MICRO, full size'],
  '6S': [0.0001, 125000,      'Franc — NO MICRO, full size'],
  '6C': [0.00005, 100000,     'CAD — NO MICRO, full size'],
  // softs
  SB: [0.01, 1120, 'Sugar — NO MICRO, full size'],
};
const specOf = (s) => SPEC[s.replace(/(2y|y|live|now|h)$/, '')] ?? [0.25, 2, '?'];

const body = (b) => Math.abs(b.close - b.open);
const isGreen = (b) => b.close > b.open;
const isRed = (b) => b.close < b.open;

/**
 * Aggregate to a higher timeframe.
 *
 * `off` shifts the bucket boundary. Flooring to UTC midnight is wrong for futures:
 * TradingView anchors daily and 4-hour bars to the EXCHANGE SESSION, which for CME
 * opens 18:00 New York, about 22:00 UTC. Six hours of offset moves every daily bar,
 * which moves every daily zone, which changes which 1-hour zones pass the nesting
 * test. That is a different strategy, not a rounding detail.
 */
function aggregate(m1, sec, off = 0) {
  const out = []; let cur = null;
  for (const [t, o, h, l, c] of m1) {
    const k = Math.floor((t - off) / sec) * sec + off;
    if (!cur || cur.time !== k) { if (cur) out.push(cur); cur = { time: k, open: o, high: h, low: l, close: c, end: t }; }
    else { cur.high = Math.max(cur.high, h); cur.low = Math.min(cur.low, l); cur.close = c; cur.end = t; }
  }
  if (cur) out.push(cur);
  return out;
}
function atrSeries(bars, len) {
  const o = new Array(bars.length).fill(null);
  if (bars.length < len + 1) return o;
  const tr = [bars[0].high - bars[0].low];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  let a = tr.slice(0, len).reduce((x, y) => x + y, 0) / len;
  o[len - 1] = a;
  for (let i = len; i < bars.length; i++) { a = (a * (len - 1) + tr[i]) / len; o[i] = a; }
  return o;
}
function emaSeries(bars, len) {
  const o = new Array(bars.length).fill(null); const k = 2 / (len + 1); let e = null;
  for (let i = 0; i < bars.length; i++) { e = e === null ? bars[i].close : bars[i].close * k + e * (1 - k); if (i >= len - 1) o[i] = e; }
  return o;
}
function rsiSeries(bars, len = 14) {
  const o = new Array(bars.length).fill(null); let ag = 0, al = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close, g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= len) { ag += g / len; al += l / len; if (i === len) o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    else { ag = (ag * (len - 1) + g) / len; al = (al * (len - 1) + l) / len; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  }
  return o;
}

// ---- trend definitions -------------------------------------------------------
// Pivot swings with lookleft/lookright = LR. A bar is a swing high if its high is the
// highest across the 2*LR+1 window centred on it. Confirmed only LR bars later, which is
// why the timeline below records the CONFIRMATION time, not the pivot time.
function swings(bars, LR = 2) {
  const hi = [], lo = [];
  for (let i = LR; i < bars.length - LR; i++) {
    let isH = true, isL = true;
    for (let k = i - LR; k <= i + LR; k++) {
      if (k === i) continue;
      if (bars[k].high >= bars[i].high) isH = false;
      if (bars[k].low <= bars[i].low) isL = false;
    }
    if (isH) hi.push({ i, at: bars[i + LR].end, v: bars[i].high });
    if (isL) lo.push({ i, at: bars[i + LR].end, v: bars[i].low });
  }
  return { hi, lo };
}

// HH/LL trend: LEG consecutive higher highs AND higher lows = up; lower lows and lower
// highs = down; anything else = no trend. Returns events {at, dir} in time order.
function hhllTimeline(bars, LEG = 3, LR = 2) {
  const { hi, lo } = swings(bars, LR);
  const ev = [];
  const all = [...hi.map((x) => ({ ...x, k: 'h' })), ...lo.map((x) => ({ ...x, k: 'l' }))]
    .sort((a, b) => a.at - b.at);
  const H = [], L = [];
  for (const s of all) {
    (s.k === 'h' ? H : L).push(s.v);
    let dir = 0;
    if (H.length > LEG && L.length > LEG) {
      let up = true, dn = true;
      for (let n = 0; n < LEG; n++) {
        if (!(H.at(-1 - n) > H.at(-2 - n))) up = false;
        if (!(L.at(-1 - n) > L.at(-2 - n))) up = false;
        if (!(H.at(-1 - n) < H.at(-2 - n))) dn = false;
        if (!(L.at(-1 - n) < L.at(-2 - n))) dn = false;
      }
      dir = up ? 1 : dn ? -1 : 0;
    }
    ev.push({ at: s.at, dir });
  }
  return ev;
}

// ---- VERBATIM from sdzones.mjs ------------------------------------------------
function detectZoneAt(h, atrH, i) {
  const at = (k) => h[i - k];
  const cur = at(0), curAtr = atrH[i];
  if (!cur || curAtr == null) return null;
  const curBody = body(cur);
  if (curBody < curAtr * P.long_atr_filter) return null;
  const curColor = isGreen(cur) ? 'green' : isRed(cur) ? 'red' : 'na';
  if (curColor === 'na') return null;
  let smallCount = 0, idx = 1, valid = false, legInIndex = -1;
  while (idx <= P.max_small_candles && i - idx >= 0) {
    const s = at(idx); if (!s) break;
    const sBody = body(s);
    if (smallCount >= 1 && sBody >= curBody * P.leg_out_leg_in_ratio) { valid = true; legInIndex = idx; break; }
    const upW = s.high - Math.max(s.open, s.close);
    const dnW = Math.min(s.open, s.close) - s.low;
    const wickOk = sBody > 0 && Math.max(upW, dnW) <= sBody * P.max_wick_ratio;
    const sizeOk = sBody <= curBody * P.max_long_short_ratio;
    if (wickOk && sizeOk) { smallCount++; idx++; } else break;
  }
  if (!valid && smallCount >= 1) { legInIndex = Math.min(idx, i); valid = true; }
  if (!valid || legInIndex <= 0) return null;
  const legIn = at(legInIndex); if (!legIn) return null;
  const legColor = isGreen(legIn) ? 'green' : isRed(legIn) ? 'red' : 'na';
  if (legColor === 'na') return null;
  let type = null;
  if (curColor === 'green' && legColor === 'red') type = 'Demand';
  else if (curColor === 'green' && legColor === 'green') type = 'Demand';
  else if (curColor === 'red' && legColor === 'green') type = 'Supply';
  else if (curColor === 'red' && legColor === 'red') type = 'Supply';
  if (!type) return null;
  let top, bot;
  if (type === 'Demand') {
    const b1 = at(1); if (!b1) return null;
    top = Math.max(b1.open, b1.close); bot = cur.low;
    for (let k = 1; k <= smallCount; k++) { const bk = at(k); if (!bk) continue; top = Math.max(top, Math.max(bk.open, bk.close)); bot = Math.min(bot, bk.low); }
  } else {
    const b1 = at(1); if (!b1) return null;
    top = cur.high; bot = Math.min(b1.open, b1.close);
    for (let k = 1; k <= smallCount; k++) { const bk = at(k); if (!bk) continue; top = Math.max(top, bk.high); bot = Math.min(bot, Math.min(bk.open, bk.close)); }
  }
  if (!(top > bot)) return null;
  // legStrength is the leg-out body measured in ATR; it is what C2 thresholds on.
  return { top, bot, type, smallCount, legoutTime: cur.time, createdAt: cur.end,
           legStrength: curBody / curAtr };
}
const overlap = (a, b) => a.bot <= b.top && b.bot <= a.top;

// ---- per-symbol prepared data, cached across configs --------------------------
// The original script always runs 60M, 15M, 5M and CT. But that is a day-trading zone
// book. The method this strategy comes from is a SWING method: daily and 4-hour zones,
// entered on 4-hour or hourly. ZONETFS makes the zone book configurable so the higher
// timeframe version can actually be measured instead of assumed.
const ZONE_TF_SET = (process.env.ZONETFS || '60,15,5').split(',').map(Number);

function prepare(sym, from, to, warmup) {
  let m1;
  try { m1 = JSON.parse(readFileSync(`${D}/${sym}_1m.json`)); } catch { return null; }
  if (from) { const lo = from - warmup; m1 = m1.filter((r) => r[0] >= lo && r[0] <= (to || Infinity)); }
  if (!m1.length) return null;
  return { m1, ct: new Map(), zones: new Map() };
}
function barsFor(S, mins) {
  if (!S.ct.has(mins)) {
    // Intraday buckets under an hour need no offset; from 1 hour up the session anchor
    // matters, and at daily it dominates.
    const bars = aggregate(S.m1, mins * 60, mins >= 60 ? SESSION_OFF : 0);
    S.ct.set(mins, { bars, atr: atrSeries(bars, P.atr_length),
      emaF: emaSeries(bars, P.ema_fast_len), emaS: emaSeries(bars, P.ema_slow_len),
      rsi: rsiSeries(bars, 14) });
  }
  return S.ct.get(mins);
}
function trendFor(S, mins, leg) {
  const key = `${mins}:${leg}`;
  if (!S.trend) S.trend = new Map();
  if (!S.trend.has(key)) {
    const { bars } = barsFor(S, mins);
    S.trend.set(key, { candle: bars, hhll: hhllTimeline(bars, leg, 2) });
  }
  return S.trend.get(key);
}
/**
 * Sub-sample a lower-timeframe series the way request.security() actually delivers it.
 *
 * This is the difference between my engine and the deployed Pine script, and it is not
 * small. On a 30-minute chart, request.security(..., "5", ...) updates ONCE per chart
 * bar: the script sees the most recent closed 5-minute bar and never the other five.
 * Reading every 5-minute bar instead finds roughly six times as many 5-minute zones,
 * which is why this engine reported 228 gold trades where TradingView's own emulator,
 * running the real script, reported 48.
 */
function pineSample(sub, ct) {
  const out = []; let j = 0, last = null;
  for (let i = 0; i < ct.length; i++) {
    while (j < sub.length && sub[j].end <= ct[i].time) last = sub[j++];
    if (last && (!out.length || out[out.length - 1].time !== last.time)) out.push(last);
  }
  return out;
}

function zonesFor(S, mins, label, ctMins) {
  const key = `${mins}:${ctMins}:${PINEMTF ? 1 : 0}`;
  if (!S.zones.has(key)) {
    let bars, atr;
    if (PINEMTF && mins < ctMins) {
      const sub = barsFor(S, mins).bars;
      const ctBars = barsFor(S, ctMins).bars;
      bars = pineSample(sub, ctBars);
      atr = atrSeries(bars, P.atr_length);
    } else {
      ({ bars, atr } = barsFor(S, mins));
    }
    const created = [];
    for (let i = 0; i < bars.length; i++) { const z = detectZoneAt(bars, atr, i); if (z) created.push({ ...z, rank: mins }); }
    S.zones.set(key, created);
  }
  return S.zones.get(key).map((z) => ({ ...z, label }));
}

// ---- one backtest run ---------------------------------------------------------
function run(S, sym, cfg, from) {
  const [tick, pv] = specOf(sym);
  const { bars: ct, atr: atrCt, emaF, emaS, rsi } = barsFor(S, cfg.ct);
  const tfs = [...new Set([...ZONE_TF_SET, cfg.ct])].sort((a, b) => b - a);
  const streams = tfs.map((m) => ({ mins: m, label: m === cfg.ct ? 'CT' : `${m}M`,
    created: zonesFor(S, m, m === cfg.ct ? 'CT' : `${m}M`, cfg.ct), ptr: 0 }));

  // HTF trend state, advanced bar by bar so nothing from the future is read.
  const htfMin = cfg.htf || 60;
  const T = (cfg.ctx === 'htfcandle' || cfg.ctx === 'hhll') ? trendFor(S, htfMin, cfg.leg || 3) : null;
  let hi = 0, hLast = null, ei = 0, hhllDir = 0;

  const F = { zonesMade: 0, seen: 0, used: 0, alive: 0, weak: 0, longBase: 0, strong: 0,
    notNested: 0, nested: 0, noHtf: 0, wrongTrend: 0, trendOk: 0, tooWide: 0, behind: 0, candidate: 0,
    bars: 0, hasPend: 0, pendMoved: 0 };
  let prevPendEntry = null;
  let live = [], pos = null; const trades = [];
  // ONEORDER mirrors what the Pine strategy can actually do: hold ONE resting limit at a
  // time, chosen at the close of each bar as the nearest qualifying zone, and fill only
  // if price reaches THAT price. The previous behaviour checked every live zone on every
  // bar, which is equivalent to resting dozens of orders at once and quietly picking
  // whichever zone the market happened to visit. That inflated both trade count and
  // quality: on gold it gave 146 trades at PF 2.10 where TradingView's own tester,
  // running the deployed script, gave 48 at 1.47.
  let pend = null;
  for (let i = 1; i < ct.length; i++) {
    const b = ct[i], A = atrCt[i];
    if (A == null || emaS[i] == null) continue;
    F.bars++;

    for (const st of streams) {
      while (st.ptr < st.created.length && st.created[st.ptr].createdAt <= b.time) {
        const z = { ...st.created[st.ptr++], used: 0 };
        if (!live.some((q) => q.label === z.label && overlap(q, z))) {
          F.zonesMade++;
          live.unshift(z); if (live.length > P.max_zones) live.pop();
        }
      }
    }
    if (T) {
      while (hi < T.candle.length && T.candle[hi].end <= b.time) hLast = T.candle[hi++];
      while (ei < T.hhll.length && T.hhll[ei].at <= b.time) hhllDir = T.hhll[ei++].dir;
    }
    live = live.filter((z) => {
      const amt = (z.top - z.bot) * P.breach_threshold;
      return z.type === 'Supply' ? !(b.high > z.top + amt) : !(b.low < z.bot - amt);
    });

    if (pos) {
      const long = pos.side === 'LONG';
      // In oneOrder mode the exit bracket is not live until the bar after the fill,
      // because that is when the Pine script submits it.
      if (cfg.oneOrder && !pos.armed) { pos.armed = true; continue; }
      pos.mfe = Math.max(pos.mfe, (long ? b.high - pos.fill : pos.fill - b.low) / pos.risk);
      if (cfg.be && !pos.beDone) {
        const trig = long ? pos.entry + cfg.be * pos.risk : pos.entry - cfg.be * pos.risk;
        if (long ? b.high >= trig : b.low <= trig) { pos.stop = pos.entry; pos.beDone = true; }
      }
      const hitSL = long ? b.low <= pos.stop : b.high >= pos.stop;
      const hitTP = long ? b.high >= pos.tp : b.low <= pos.tp;
      const timeout = cfg.maxBars && (i - pos.i) >= cfg.maxBars;
      if (hitSL || hitTP || timeout) {
        const px = hitSL ? pos.stop : hitTP ? pos.tp : b.close;
        const exit = long ? px - tick : px + tick;
        const r = (long ? exit - pos.fill : pos.fill - exit) / pos.risk;
        // contracts sized so the dollar risk lands as close to the budget as a whole
        // number of lots allows, never rounding up past it
        const lots = cfg.riskUsd ? Math.max(1, Math.floor(cfg.riskUsd / (pos.risk * pv))) : 1;
        trades.push({ sym, dir: pos.side, zoneTf: pos.label,
          date: new Date(pos.t * 1000).toISOString().slice(0, 16).replace('T', ' '), entryTime: pos.t,
          entry: Number(pos.entry.toFixed(4)), stop: Number(pos.stop.toFixed(4)),
          target: Number(pos.tp.toFixed(4)), riskPts: Number(pos.risk.toFixed(4)),
          res: hitSL ? 'STOP' : hitTP ? 'TARGET' : 'TIMEOUT',
          r: Number(r.toFixed(4)), lots, riskUsd: Number((pos.risk * pv * lots).toFixed(2)),
          usd: Number((r * pos.risk * pv * lots).toFixed(2)),
          mfe: Number(pos.mfe.toFixed(3)) });
        pos = null;
      }
    }
    if (pos) continue;

    // --- one-resting-order path -------------------------------------------------
    if (cfg.oneOrder) {
      if (pend && (!from || b.time >= from)) {
        const buy = pend.buy;
        // TradingView fills a buy limit when the bar's LOW reaches it, full stop; the
        // high is irrelevant. And when a bar opens already through the limit, the broker
        // fills at the OPEN, which is a better price than the limit. My previous rule
        // demanded the bar also trade back up through the limit, which silently threw
        // away every gap-through fill.
        const hit = buy ? b.low <= pend.entry - cfg.fillThru * tick
                        : b.high >= pend.entry + cfg.fillThru * tick;
        if (hit && !pend.z.used) {
          const px = buy ? Math.min(b.open, pend.entry) : Math.max(b.open, pend.entry);
          pend.z.used++;
          // The script submits strategy.exit only once it SEES the position, which is the
          // bar after the fill. So the stop and target cannot be hit on the entry bar.
          pos = { side: buy ? 'LONG' : 'SHORT', t: b.time, i, label: pend.z.label,
            entry: px, fill: buy ? px + tick : px - tick,
            stop: pend.sl, risk: Math.abs(px - pend.sl),
            tp: buy ? px + cfg.rr * Math.abs(px - pend.sl) : px - cfg.rr * Math.abs(px - pend.sl),
            beDone: false, mfe: 0, armed: false };
        }
      }
      // choose the order to rest for the next bar
      pend = null;
      let best = Infinity;
      for (const z of live) {
        F.seen++;
        if (!(b.time > z.legoutTime)) continue;
        if (z.used) { F.used++; continue; }
        F.alive++;
        if (cfg.strongAtr && !(z.legStrength >= cfg.strongAtr)) { F.weak++; continue; }
        if (cfg.maxBase && !(z.smallCount <= cfg.maxBase)) { F.longBase++; continue; }
        F.strong++;
        if (cfg.nested && !live.some((q) => q.rank > z.rank && q.type === z.type && z.top <= q.top && z.bot >= q.bot)) { F.notNested++; continue; }
        F.nested++;
        const buy = z.type === 'Demand';
        if (cfg.ctx === 'trend') { if (buy ? !up : up) continue; }
        else if (cfg.ctx === 'htfcandle') { if (!hLast) { F.noHtf++; continue; } const u = hLast.close > hLast.open; if (buy ? !u : u) { F.wrongTrend++; continue; } }
        F.trendOk++;
        const e = buy ? z.top : z.bot;
        const hgt = z.top - z.bot;
        const sl = buy ? z.bot - hgt * cfg.slPct : z.top + hgt * cfg.slPct;
        const risk = Math.abs(e - sl);
        if (!(risk > 0)) continue;
        // Dollar risk, not ATR. One contract of this instrument risks this many dollars
        // on this stop; if that alone blows the budget the setup is untradeable at this
        // account size no matter how good it looks.
        // Minimum stop distance in TICKS. Commission and slippage are charged per
        // contract and do not shrink with the stop, so a tight stop pays the same cost
        // against a smaller R. Scaling the position to a fixed dollar risk does NOT help:
        // it multiplies contracts and commission together and leaves the ratio unchanged.
        // Only refusing the tight setups does. GlobexTraps already does this (minTicks=16).
        if (cfg.minTicks && risk < cfg.minTicks * tick) { F.tooTight = (F.tooTight || 0) + 1; continue; }
        const oneLot = risk * pv;
        if (cfg.maxRiskUsd && oneLot > cfg.maxRiskUsd) { F.tooWide++; continue; }
        if (cfg.maxRiskAtr && !(risk <= A * cfg.maxRiskAtr)) { F.tooWide++; continue; }
        if (buy ? !(sl < e) : !(sl > e)) continue;
        // the script only rests into a level price has not already passed through
        if (buy ? !(b.close > e) : !(b.close < e)) { F.behind++; continue; }
        F.candidate++;
        const d = Math.abs(b.close - e);
        if (d < best) { best = d; pend = { z, buy, entry: e, sl, risk, tp: buy ? e + cfg.rr * risk : e - cfg.rr * risk }; }
      }
      // How stable is the resting order? A trader picks a level and waits. This engine,
      // like the Pine, re-picks the NEAREST qualifying zone every single bar, so the order
      // can hop to a different level bar after bar and only fills if price happens to be
      // at whichever one it landed on. That is why two 90%-correlated instruments share
      // almost none of their setups.
      if (pend) { F.hasPend++; if (prevPendEntry !== null && pend.entry !== prevPendEntry) F.pendMoved++; prevPendEntry = pend.entry; }
      else prevPendEntry = null;
      continue;
    }
    // --- end one-resting-order path ----------------------------------------------

    if (from && b.time < from) continue;

    const up = emaF[i] > emaS[i];
    for (const z of live) {
      if (!(b.time > z.legoutTime)) continue;
      const buy = z.type === 'Demand';

      // --- trigger (mechanics) ---
      let cond;
      if (cfg.trigger === 'reject') {
        cond = buy ? (isGreen(b) && b.low <= z.top && b.low >= z.bot && b.high > z.top)
                   : (isRed(b)   && b.high <= z.top && b.high >= z.bot && b.low < z.bot);
      } else { // 'touch' and 'touchclose': price trades into the zone's proximal edge
        // A resting limit is not filled by price KISSING the level. It has to trade
        // through it, and even then queue position decides. FILLTHRU=n demands the bar
        // penetrate n ticks past the limit before the fill is credited. The whole edge
        // of this strategy is the fill, so this assumption has to be stress-tested
        // rather than assumed.
        const thru = cfg.fillThru * tick;
        cond = buy ? (b.low <= z.top - thru && b.high >= z.top) : (b.high >= z.bot + thru && b.low <= z.bot);
      }
      if (!cond) continue;

      // --- C1 nested ---
      if (cfg.nested && !live.some((q) => q.rank > z.rank && q.type === z.type && z.top <= q.top && z.bot >= q.bot)) continue;
      // --- C2 strength ---
      if (cfg.strongAtr && !(z.legStrength >= cfg.strongAtr)) continue;
      if (cfg.maxBase && !(z.smallCount <= cfg.maxBase)) continue;
      // --- C3 context ---
      if (cfg.ctx === 'trend') { if (buy ? !up : up) continue; }
      else if (cfg.ctx === 'counter') { if (buy ? up : !up) continue; }
      else if (cfg.ctx === 'rsirev') { const v = rsi[i]; if (v == null) continue; if (buy ? !(v <= cfg.rsiLo) : !(v >= cfg.rsiHi)) continue; }
      else if (cfg.ctx === 'rsimid') { const v = rsi[i]; if (v == null) continue; if (!(v >= 40 && v <= 60)) continue; }
      else if (cfg.ctx === 'htfcandle') { if (!hLast) continue; const up2 = hLast.close > hLast.open; if (buy ? !up2 : up2) continue; }
      else if (cfg.ctx === 'hhll') { if (hhllDir === 0) continue; if (buy ? hhllDir !== 1 : hhllDir !== -1) continue; }

      // --- mechanics: entry, stop, target ---
      const hgt = z.top - z.bot;
      // 'touch' assumes a resting limit at the proximal edge, which is what a live limit
      // order does. 'touchclose' takes the bar close instead — what a Pine strategy does
      // by default with process_orders_on_close. The gap between them is the cost of not
      // resting an order, and it has to be measured before the script is written.
      const entry = cfg.trigger === 'touch' ? (buy ? z.top : z.bot) : b.close;
      const sl = buy ? z.bot - hgt * cfg.slPct : z.top + hgt * cfg.slPct;
      const risk = Math.abs(entry - sl);
      if (!(risk > 0)) continue;
      if (cfg.maxRiskAtr && !(risk <= A * cfg.maxRiskAtr)) continue;
      // A zone is tradable only cfg.maxTouch times in its life. Without this the engine
      // re-enters the same level on every bar price sits at its edge.
      if (cfg.maxTouch && z.used >= cfg.maxTouch) continue;
      z.used++;
      if (buy ? !(sl < entry) : !(sl > entry)) continue;
      pos = { side: buy ? 'LONG' : 'SHORT', t: b.time, i, label: z.label, entry,
        fill: buy ? entry + tick : entry - tick, stop: sl, risk,
        tp: buy ? entry + cfg.rr * risk : entry - cfg.rr * risk, beDone: false, mfe: 0 };
      // ENTRYBAR=1 also resolves the entry bar itself. The bar that touches the zone can
      // keep going and take the stop inside the same bar; ignoring that flatters the
      // result, and on a 30-minute bar the omission is not small. Stop wins a tie.
      if (cfg.entryBar) {
        // Only the STOP may resolve on the entry bar. Awarding the target here would
        // assume the bar's extreme came after the touch, which is lookahead inside the
        // bar; allowing only the loss is the pessimistic reading of the same ambiguity.
        const hitSL0 = buy ? b.low <= pos.stop : b.high >= pos.stop;
        const hitTP0 = false;
        if (hitSL0 || hitTP0) {
          const px = hitSL0 ? pos.stop : pos.tp;
          const ex = buy ? px - tick : px + tick;
          const rr0 = (buy ? ex - pos.fill : pos.fill - ex) / pos.risk;
          trades.push({ sym, dir: pos.side, zoneTf: pos.label,
            date: new Date(pos.t * 1000).toISOString().slice(0, 10), entryTime: pos.t,
            res: hitSL0 ? 'STOP' : 'TARGET', r: Number(rr0.toFixed(4)),
            usd: Number((rr0 * pos.risk * pv).toFixed(2)), mfe: 0 });
          pos = null;
        }
      }
      break;
    }
  }
  if (process.env.FUNNEL === '1') console.error(`FUNNEL ${sym}: ` + JSON.stringify(F));
  return trades;
}

// ---- stats --------------------------------------------------------------------
export function stats(rows) {
  const n = rows.length; if (!n) return null;
  const rs = rows.map((t) => t.r);
  const gp = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const gl = -rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  const byd = {}; rows.forEach((t) => (byd[t.date] ??= []).push(t.r));
  const sess = Object.values(byd).map((v) => v.reduce((a, b) => a + b, 0));
  const mean = sess.reduce((a, b) => a + b, 0) / sess.length;
  const sd = sess.length > 1 ? Math.sqrt(sess.reduce((a, b) => a + (b - mean) ** 2, 0) / (sess.length - 1)) : 0;
  let eq = 0, pk = 0, mdd = 0;
  for (const r of rs) { eq += r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq - pk); }
  return { n, win: rs.filter((r) => r > 0).length / n * 100, totR: eq, avgR: eq / n,
    pf: gl > 0 ? gp / gl : Infinity, usd: rows.reduce((a, b) => a + b.usd, 0),
    days: sess.length, tpd: n / sess.length, mddR: mdd,
    t: sd > 0 ? mean / (sd / Math.sqrt(sess.length)) : null };
}

// ---- CLI ----------------------------------------------------------------------
const FROM = process.env.FROM ? Date.parse(process.env.FROM + 'T00:00:00Z') / 1000 : null;
const TO = process.env.TO ? Date.parse(process.env.TO + 'T00:00:00Z') / 1000 : null;
const WARMUP = Number(process.env.WARMUP_D || 45) * 86400;
const SYMS = (process.env.SYMS || 'MNQ2y,MES2y,MYM2y,M2K2y,MGC2y').split(',');
// PINEMTF=1 models request.security's once-per-chart-bar delivery. Default ON, because
// off is simply wrong: it describes a script nobody is running.
const PINEMTF = process.env.PINEMTF !== '0';
// Seconds past UTC midnight where the exchange session starts. CME futures open
// 18:00 New York, which is 22:00 UTC in winter and 21:00 in summer; 22:00 is the
// closer single constant and DST drift is one hour on a 24-hour bar.
const SESSION_OFF = Number(process.env.SESSION_OFF ?? 79200);

export function runAll(cfg, syms = SYMS, from = FROM, to = TO) {
  const out = [];
  for (const s of syms) {
    const S = prepare(s, from, to, WARMUP); if (!S) continue;
    out.push(...run(S, s, cfg, from));
  }
  return out;
}
export { prepare, run, SYMS, FROM, TO, WARMUP };

if (process.argv[1].endsWith('simplezones.mjs')) {
  const cfg = { ct: Number(process.env.CT || 5), nested: process.env.NESTED !== '0',
    strongAtr: Number(process.env.STRONG || 0), maxBase: Number(process.env.MAXBASE || 0),
    ctx: process.env.CTX || 'none', rsiLo: Number(process.env.RSILO || 35), rsiHi: Number(process.env.RSIHI || 65),
    trigger: process.env.TRIGGER || 'reject', slPct: Number(process.env.SLPCT || 0.3),
    rr: Number(process.env.RR || 1.5), be: Number(process.env.BE || 0),
    maxRiskAtr: Number(process.env.MAXRISK || 0), maxBars: Number(process.env.MAXBARS || 0),
    htf: Number(process.env.HTF || 60), leg: Number(process.env.LEG || 3),
    maxTouch: Number(process.env.MAXTOUCH || 1), entryBar: process.env.ENTRYBAR === '1',
    fillThru: Number(process.env.FILLTHRU || 0), oneOrder: process.env.ONEORDER === '1',
    riskUsd: Number(process.env.RISK_USD || 0), maxRiskUsd: Number(process.env.MAXRISK_USD || 0),
    minTicks: Number(process.env.MINTICKS || 0) };
  const t = runAll(cfg);
  writeFileSync(process.env.OUT || '/tmp/sz.json', JSON.stringify(t));
  const s = stats(t);
  console.log(JSON.stringify(cfg));
  console.log(s ? `n=${s.n} win=${s.win.toFixed(1)}% avgR=${s.avgR.toFixed(3)} totR=${s.totR.toFixed(1)} PF=${s.pf.toFixed(2)} USD=${s.usd.toFixed(0)} tpd=${s.tpd.toFixed(2)} t=${s.t?.toFixed(2)} maxDD=${s.mddR.toFixed(1)}R` : 'no trades');
}
