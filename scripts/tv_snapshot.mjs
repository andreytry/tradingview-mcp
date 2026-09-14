#!/usr/bin/env node
/**
 * Periodic TradingView -> Supabase snapshot.
 *
 * Reads the Strategy Tester through the same CDP bridge the MCP server uses, and writes
 * one public.tv_snapshot row per strategy/symbol. This is the ONLY way to get profit and
 * loss out of TradingView: there is no REST API for it, and the realtime chart view does
 * not carry a P&L figure.
 *
 * It must run on the machine with the TradingView desktop app open, because CDP is local.
 * If the app is closed the run exits non-zero and writes nothing rather than writing
 * zeros, so a dead collector never looks like a flat month.
 */
import { setSymbol, setTimeframe, getState, manageIndicator } from '../src/core/chart.js';
// User Pine scripts are not reachable through createStudy by name; they have to be added
// the way the UI does it, via the indicator search dialog.
import { addStudyFromSearch, setInputs } from '../src/core/indicators.js';
import { getStrategyResults } from '../src/core/data.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Each entry is one deployed strategy: the saved Pine name, the backend tag it reports
// under, its chart timeframe, and the inputs that define the validated configuration.
const STRATEGIES = [
  {
    script: 'SupplyDemandTrendReversal',
    tag: 'reversal-a-v2',
    timeframe: '15',
    inputs: { in_1: 0.75, in_6: 2, in_12: 1.5, in_16: 2.0, in_19: true, in_20: true, in_21: false },
  },
  {
    script: 'SupplyDemandTrendContinuation',
    tag: 'continuation-b-v2',
    timeframe: '15',
    inputs: { in_1: 1.5, in_6: 1, in_7: '5', in_14: 100, in_15: 0, in_17: 3.0, in_22: 'off' },
  },
];

const SYMBOLS = ['COMEX_MINI:MGC1!', 'CME_MINI:MES1!', 'CBOT_MINI:MYM1!', 'CME_MINI:M2K1!', 'CME_MINI:MNQ1!'];
const short = (s) => s.split(':')[1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The tester recomputes asynchronously after a symbol change; poll rather than guess. */
async function resultsWhenReady(tries = 12) {
  for (let i = 0; i < tries; i++) {
    const r = await getStrategyResults().catch(() => null);
    if (r?.success && r.metrics && r.metrics.total_trades !== undefined) return r.metrics;
    await sleep(1500);
  }
  return null;
}

async function clearStrategies() {
  const st = await getState();
  for (const s of st.studies || []) {
    if (/Strategy [AB] -/.test(s.name)) await manageIndicator({ action: 'remove', entity_id: s.id });
  }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_KEY are required');

  const captured_at = new Date().toISOString();
  const rows = [];

  for (const strat of STRATEGIES) {
    await clearStrategies();
    await setTimeframe({ timeframe: strat.timeframe });
    const added = await addStudyFromSearch({ query: strat.script });
    const entity_id = added?.entity_id;
    if (!entity_id) throw new Error(`could not add ${strat.script}`);
    await setInputs({ entity_id, inputs: strat.inputs });

    for (const sym of SYMBOLS) {
      await setSymbol({ symbol: sym });
      const m = await resultsWhenReady();
      if (!m) { console.error(`no report for ${strat.tag} ${sym}`); continue; }

      const trades = m.total_trades ?? 0;
      const wins = m.winning_trades ?? 0;
      const losses = m.losing_trades ?? 0;
      // R is derived, not reported: a win banks targetR, a loss costs 1R.
      const targetR = strat.tag === 'reversal-a-v2' ? 2 : 3;
      const total_r = trades ? targetR * wins - losses : 0;

      rows.push({
        captured_at, strategy: strat.tag, symbol: short(sym), timeframe: strat.timeframe,
        trades, wins, losses,
        win_pct: trades ? Number((100 * wins / trades).toFixed(1)) : null,
        profit_factor: m.profit_factor ?? null,
        net_profit: m.net_profit ?? 0,
        gross_profit: m.gross_profit ?? null,
        gross_loss: m.gross_loss ?? null,
        max_drawdown: m.max_drawdown ?? null,
        avg_r: trades ? Number((total_r / trades).toFixed(3)) : null,
        total_r,
      });
      console.error(`${strat.tag} ${short(sym).padEnd(6)} trades=${trades} pf=${m.profit_factor ?? '-'} net=${m.net_profit ?? 0}`);
    }
  }

  if (!rows.length) throw new Error('collected nothing; refusing to write an empty snapshot');

  const res = await fetch(`${SUPABASE_URL}/rest/v1/tv_snapshot`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text()).slice(0, 300)}`);
  console.error(`wrote ${rows.length} rows at ${captured_at}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('snapshot failed:', e.message); process.exit(1); });
