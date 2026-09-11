/**
 * Exact replication of "Supply/Demand Zones with Zone Arrival/Departure Alerts"
 * (TradingView script USER;6fbe379234e342f081381e583d3f6e31, version 3.0).
 *
 * Every rule below is transcribed from that source. Where the script has an input, the
 * default here is the value actually set on the live chart study. Nothing is added, and
 * the deviations that were in the earlier engine (lookahead FVG, HH/LL trend, an opposing
 * -zone target requirement, roll-day skipping) are all absent because the script has none
 * of them.
 *
 * Structure of the original:
 *   - zones are detected on an ANALYSIS timeframe (input, default 60)
 *   - entries are evaluated on the CHART timeframe against every live zone
 *   - a zone dies only when BREACHED, never on a touch, so it can fire repeatedly
 *
 * Env:
 *   CT=5            chart timeframe in minutes (entries)
 *   HTF=60          analysis timeframe in minutes (zones)
 *   SYMS=MNQ2y,...  symbols (files <SYM>_1m.json must exist)
 *   RSI=0|1         use_rsi_filter (script default false)
 *   TREND=ct|htf    ct = EMA20>EMA50 on the chart timeframe (the script's take_only_ct_trend)
 *                   htf = direction of the analysis-timeframe candle only, no EMAs
 *   DOUBLE=0|1      require the zone to sit inside a zone from the next timeframe up
 *   OUT=/tmp/x.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const D = '/root/tradingview-mcp/backtest-data';
const CT_MIN  = Number(process.env.CT  || 5);
// The script's main() detects zones on FOUR timeframes at once — 60M, 15M, 5M and the
// chart timeframe — all into one active_zones array, tagged by label, and culls overlaps
// only within a label. The `analysis_timeframe` input is never used by main(). Any engine
// that reads zones from a single timeframe is not this strategy.
const ZONE_TFS = (process.env.ZONE_TFS || '60,15,5,CT').split(',').map((x) => x.trim());
const USE_RSI = process.env.RSI === '1';
const TREND   = process.env.TREND || 'ct';
const DOUBLE  = process.env.DOUBLE === '1';
const OUT     = process.env.OUT || '/tmp/sd.json';

// --- script inputs, at the values set on the live chart -----------------------
const P = {
  atr_length: 14,
  long_atr_filter: 0.5,        // leg-out body >= this x ATR
  max_long_short_ratio: 0.5,   // base body <= this x leg-out body
  leg_out_leg_in_ratio: 0.25,
  breach_threshold: 0.25,
  max_small_candles: 10,
  max_wick_ratio: 10,
  max_zones: 200,
  rejection_atr_mult: 0.5,
  target_rr: 1.5,
  ema_fast_len: 20,
  ema_slow_len: 50,
  sl_zone_pct: 0.30,
  max_position_atr_mult: 1.0,
  rsi_threshold: 50,
  take_only_ct_trend: true,
  follow_strong_trend: false,  // off, so should_block_by_next_htf is always false
  ema_proximity_atr: -1,       // <=0, so every EMA-proximity gate returns true
};

const SYMS = (process.env.SYMS || 'MNQ2y,MES2y,MYM2y,M2K2y,MGC2y').split(',');
const SPEC = { MNQ: [0.25, 2], MES: [0.25, 5], MYM: [1.0, 0.5], M2K: [0.1, 5],
               MGC: [0.1, 10], MCL: [0.01, 100], '6E': [0.00005, 125000] };
const specOf = (s) => SPEC[s.replace(/(2y|y|live)$/, '')] ?? [0.25, 2];

// --- helpers -----------------------------------------------------------------
const body = (b) => Math.abs(b.close - b.open);
const isGreen = (b) => b.close > b.open;
const isRed   = (b) => b.close < b.open;

function aggregate(m1, sec) {
  const out = []; let cur = null;
  for (const [t, o, h, l, c] of m1) {
    const k = Math.floor(t / sec) * sec;
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
  const o = new Array(bars.length).fill(null);
  const k = 2 / (len + 1);
  let e = null;
  for (let i = 0; i < bars.length; i++) {
    e = e === null ? bars[i].close : bars[i].close * k + e * (1 - k);
    if (i >= len - 1) o[i] = e;
  }
  return o;
}

function rsiSeries(bars, len = 14) {
  const o = new Array(bars.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= len) { ag += g / len; al += l / len; if (i === len) o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    else { ag = (ag * (len - 1) + g) / len; al = (al * (len - 1) + l) / len; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  }
  return o;
}

/**
 * detect_mtf_patterns_universal, transcribed.
 * `hist` index 0 is the just-closed bar; higher indices go further back.
 */
function detectZoneAt(h, atrH, i) {
  const at = (k) => h[i - k];                      // k=0 is the leg-out bar
  const cur = at(0), curAtr = atrH[i];
  if (!cur || curAtr == null) return null;
  const curBody = body(cur);
  if (curBody < curAtr * P.long_atr_filter) return null;
  const curColor = isGreen(cur) ? 'green' : isRed(cur) ? 'red' : 'na';
  if (curColor === 'na') return null;

  let smallCount = 0, idx = 1, valid = false, legInIndex = -1;
  while (idx <= P.max_small_candles && i - idx >= 0) {
    const s = at(idx);
    if (!s) break;
    const sBody = body(s);
    if (smallCount >= 1) {
      if (sBody >= curBody * P.leg_out_leg_in_ratio) { valid = true; legInIndex = idx; break; }
    }
    const upW = s.high - Math.max(s.open, s.close);
    const dnW = Math.min(s.open, s.close) - s.low;
    const mxW = Math.max(upW, dnW);
    const wickOk = sBody > 0 && mxW <= sBody * P.max_wick_ratio;
    const sizeOk = sBody <= curBody * P.max_long_short_ratio;
    if (wickOk && sizeOk) { smallCount++; idx++; } else break;
  }
  if (!valid && smallCount >= 1) { legInIndex = Math.min(idx, i); valid = true; }
  if (!valid || legInIndex <= 0) return null;

  const legIn = at(legInIndex);
  if (!legIn) return null;
  const legColor = isGreen(legIn) ? 'green' : isRed(legIn) ? 'red' : 'na';
  if (legColor === 'na') return null;

  let type = null, title = null;
  if (curColor === 'green' && legColor === 'red')   { type = 'Demand'; title = 'drop-base-rally'; }
  else if (curColor === 'green' && legColor === 'green') { type = 'Demand'; title = 'rally-base-rally'; }
  else if (curColor === 'red'   && legColor === 'green') { type = 'Supply'; title = 'rally-base-drop'; }
  else if (curColor === 'red'   && legColor === 'red')   { type = 'Supply'; title = 'drop-base-drop'; }
  if (!type) return null;

  // find_zone_boundaries_universal(0, smallCount, type)
  let top, bot;
  if (type === 'Demand') {
    const b1 = at(1); if (!b1) return null;
    top = Math.max(b1.open, b1.close); bot = cur.low;
    for (let k = 1; k <= smallCount; k++) {
      const bk = at(k); if (!bk) continue;
      top = Math.max(top, Math.max(bk.open, bk.close));
      bot = Math.min(bot, bk.low);
    }
  } else {
    const b1 = at(1); if (!b1) return null;
    top = cur.high; bot = Math.min(b1.open, b1.close);
    for (let k = 1; k <= smallCount; k++) {
      const bk = at(k); if (!bk) continue;
      top = Math.max(top, bk.high);
      bot = Math.min(bot, Math.min(bk.open, bk.close));
    }
  }
  if (!(top > bot)) return null;
  return { top, bot, type, title, smallCount, legoutTime: cur.time, createdAt: cur.end };
}

const overlap = (a, b) => !(a.bot > b.top || b.bot > a.top);

function buildZones(h, atrH) {
  const zones = [];      // live set, mirroring active_zones
  const events = [];     // { at, zones: snapshot } is too heavy; instead record add/remove
  for (let i = 0; i < h.length; i++) {
    const z = detectZoneAt(h, atrH, i);
    if (!z) continue;
    zones.unshift(z);
    if (zones.length > P.max_zones) zones.pop();
    // ti2_cull_overlaps_same_tf: single analysis TF here, so every pair is same-TF
    for (let a = 0; a < zones.length; a++) {
      for (let b = a + 1; b < zones.length; ) {
        if (overlap(zones[a], zones[b])) {
          const keepA = zones[a].legoutTime <= zones[b].legoutTime;
          zones.splice(keepA ? b : a, 1);
          if (!keepA) { b = a + 1; continue; }
        } else b++;
      }
    }
    events.push({ at: z.createdAt, snapshot: zones.map((q) => ({ ...q })) });
  }
  return events;
}

// --- run ---------------------------------------------------------------------
const all = [];
for (const sym of SYMS) {
  let m1;
  try { m1 = JSON.parse(readFileSync(`${D}/${sym}_1m.json`)); }
  catch { console.log(`${sym}: no data`); continue; }
  const [tick, pv] = specOf(sym);

  const ct  = aggregate(m1, CT_MIN * 60);
  const atrCt = atrSeries(ct, P.atr_length);
  const emaF = emaSeries(ct, P.ema_fast_len);
  const emaS = emaSeries(ct, P.ema_slow_len);
  const rsi  = rsiSeries(ct, 14);

  // One zone stream per enabled timeframe, each tagged with its label.
  const streams = [];
  for (const tf of ZONE_TFS) {
    const mins = tf === 'CT' ? CT_MIN : Number(tf);
    if (!Number.isFinite(mins)) continue;
    // No guard on mins < CT_MIN: the script requests 5M/15M/60M zones regardless of the
    // chart timeframe, so on a 60m chart it really does evaluate 5M zones.
    const bars = mins === CT_MIN ? ct : aggregate(m1, mins * 60);
    const a = atrSeries(bars, P.atr_length);
    const label = tf === 'CT' ? 'CT' : `${tf}M`;
    const created = [];
    for (let i = 0; i < bars.length; i++) {
      const z = detectZoneAt(bars, a, i);
      if (z) created.push({ ...z, label, rank: mins });
    }
    streams.push({ label, mins, created, ptr: 0 });
  }

  // trend inputs the script uses
  const bars1h = Math.max(1, Math.round(3600 / (CT_MIN * 60)));
  const bars4h = Math.max(1, Math.round(14400 / (CT_MIN * 60)));
  const htf60 = aggregate(m1, 3600);

  let live = [];
  let pos = null, nTrades = 0, zonesMade = 0;
  const trades = [];
  let h60i = 0, h60last = null;

  for (let i = 1; i < ct.length; i++) {
    const b = ct[i];
    const A = atrCt[i];
    if (A == null || emaS[i] == null) continue;

    // admit zones whose leg-out bar has closed
    for (const st of streams) {
      while (st.ptr < st.created.length && st.created[st.ptr].createdAt <= b.time) {
        const z = { ...st.created[st.ptr++] };
        // ti2_cull_overlaps_same_tf, same label only.
        //
        // The script re-runs a full pairwise scan on every admission, but the array is
        // already culled beforehand, so only the newly added zone can create an overlap.
        // Its rule keeps the OLDER of an overlapping pair (keep_i compares creation times
        // and the new zone sits at index 0, i.e. newest), so a new zone overlapping an
        // existing same-label zone is discarded. Checking only the new zone is equivalent
        // and turns an O(n^2) scan per admission into O(n).
        const clash = live.some((q) => q.label === z.label && overlap(q, z));
        if (!clash) {
          live.unshift(z); zonesMade++;
          if (live.length > P.max_zones) live.pop();
        }
      }
    }
    while (h60i < htf60.length && htf60[h60i].end <= b.time) h60last = htf60[h60i++];

    // update_zones(): a zone dies only when breached, never on a touch
    live = live.filter((z) => {
      const hgt = z.top - z.bot, amt = hgt * P.breach_threshold;
      return z.type === 'Supply' ? !(b.high > z.top + amt) : !(b.low < z.bot - amt);
    });

    if (pos) {
      const long = pos.side === 'LONG';
      if (!pos.be) {
        const oneR = long ? pos.entry + pos.risk : pos.entry - pos.risk;
        if (long ? b.high >= oneR : b.low <= oneR) { pos.stop = pos.entry; pos.be = true; }
      }
      const hitSL = long ? b.low <= pos.stop : b.high >= pos.stop;
      const hitTP = long ? b.high >= pos.tp : b.low <= pos.tp;
      if (hitSL || hitTP) {
        const px = hitSL ? pos.stop : pos.tp;
        const exit = long ? px - tick : px + tick;
        const r = (long ? exit - pos.fill : pos.fill - exit) / pos.risk;
        trades.push({ sym, dir: pos.side, zoneTf: pos.label,
          date: new Date(pos.t * 1000).toISOString().slice(0, 10), entryTime: pos.t,
          entry: pos.entry, stop: pos.stop0, tp: pos.tp, R: pos.risk,
          res: hitSL ? 'STOP' : 'TARGET', r: Number(r.toFixed(4)),
          usd: Number((r * pos.risk * pv).toFixed(2)), exitT: b.time });
        pos = null; nTrades++;
      }
    }
    if (pos) continue;

    const ctUp = emaF[i] > emaS[i];
    const green = isGreen(b), red = isRed(b);

    for (const z of live) {
      if (!(b.time > z.legoutTime)) continue;
      const sig = z.type === 'Demand' ? 'B' : 'S';

      const cond = sig === 'B'
        ? (green && b.low <= z.top && b.low >= z.bot && b.high > z.top)
        : (red   && b.high <= z.top && b.high >= z.bot && b.low < z.bot);
      if (!cond) continue;

      if (USE_RSI) {
        const rv = rsi[i]; if (rv == null) continue;
        if (sig === 'B' ? !(rv < P.rsi_threshold) : !(rv >= P.rsi_threshold)) continue;
      }

      // DOUBLE: the zone must sit inside a live same-type zone from a HIGHER timeframe
      if (DOUBLE) {
        const inside = live.some((q) => q.rank > z.rank && q.type === z.type
          && z.top <= q.top && z.bot >= q.bot);
        if (!inside) continue;
      }

      if (TREND === 'ct') {
        if (P.take_only_ct_trend && (sig === 'B' ? !ctUp : ctUp)) continue;
      } else if (TREND === 'h1' || TREND === 'h4') {
        const back = TREND === 'h1' ? bars1h : bars4h;
        const ref = ct[Math.max(0, i - back)];
        const up = b.close - ref.open >= 0;                 // the script's own h1/h4 delta
        if (sig === 'B' ? !up : up) continue;
      } else if (TREND === 'htfcandle') {
        if (!h60last) continue;
        const up = h60last.close > h60last.open;            // 60m candle direction only
        if (sig === 'B' ? !up : up) continue;
      }
      // TREND=none: no trend filter at all

      if (sig === 'S' && emaF[i] < emaS[i]) {
        const openInZone = b.open <= z.top && b.open >= z.bot;
        const bodyOk = body(b) >= A * P.rejection_atr_mult;
        const emaInZone = (emaF[i] <= z.top && emaF[i] >= z.bot) || (emaS[i] <= z.top && emaS[i] >= z.bot);
        if (!(red && openInZone && bodyOk && emaInZone)) continue;
      }

      const hgt = z.top - z.bot;
      const sl = sig === 'B' ? z.bot - hgt * P.sl_zone_pct : z.top + hgt * P.sl_zone_pct;
      const risk = Math.abs(b.close - sl);
      if (!(risk > 0)) continue;
      if (!(risk <= A * P.max_position_atr_mult)) continue;
      if (sig === 'B' ? !(sl < b.close) : !(sl > b.close)) continue;

      pos = { side: sig === 'B' ? 'LONG' : 'SHORT', t: b.time, label: z.label,
        entry: b.close, fill: sig === 'B' ? b.close + tick : b.close - tick,
        stop: sl, stop0: sl, risk,
        tp: sig === 'B' ? b.close + P.target_rr * risk : b.close - P.target_rr * risk,
        be: false };
      break;
    }
  }
  console.log(`${sym} CT${CT_MIN} [${ZONE_TFS.join('/')}]: ${ct.length} bars, ${zonesMade} zones, ${nTrades} trades`);
  all.push(...trades);
}

writeFileSync(OUT, JSON.stringify(all, null, 0));
console.log(`TOTAL ${all.length} -> ${OUT}`);
