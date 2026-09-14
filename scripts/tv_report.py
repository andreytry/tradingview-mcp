#!/usr/bin/env python3
"""Render the TradingView sweep JSON (scripts/tv_tf_sweep.mjs) as markdown tables:
one per strategy x timeframe with a per-symbol breakdown and a TOTAL row.
Every number comes from TradingView's own Strategy Tester."""
import json, sys
d = json.load(open(sys.argv[1]))
rows, pooled = d["by_symbol"], d["pooled"]
NAMES = {"reversal-a-v2": "SupplyDemandTrendReversal (Strategy A)",
         "continuation-b-v2": "SupplyDemandTrendContinuation (Strategy B)"}
def f(x, pct=False, r=False, money=False):
    if x is None: return "—"
    if money: return f"{x:+,.0f}"
    if pct: return f"{x:.1f}%"
    if r: return f"{x:+.2f}"
    return str(x)
out = []
for strat in ["reversal-a-v2", "continuation-b-v2"]:
    out.append(f"\n## {NAMES[strat]}\n")
    for tf in sorted({r["tf"] for r in rows if r["strategy"] == strat}, key=int):
        sub = [r for r in rows if r["strategy"] == strat and r["tf"] == tf]
        p = next((x for x in pooled if x["strategy"] == strat and x["tf"] == tf), None)
        out.append(f"\n### {tf}m entry timeframe\n")
        out.append("| Symbol | Trades | Win% | Avg R | Total R | PF | Max DD (R) | USD |")
        out.append("|---|---|---|---|---|---|---|---|")
        for r in sub:
            out.append(f"| {r['symbol']} | {r['trades']} | {f(r['win_pct'],pct=True)} | {f(r['avg_r'],r=True)} | {f(r['total_r'],r=True)} | {f(r['profit_factor'])} | {f(r['max_dd_r'],r=True)} | {f(r['net_usd'],money=True)} |")
        if p:
            out.append(f"| **TOTAL** | **{p['trades']}** | **{f(p['win_pct'],pct=True)}** | **{f(p['avg_r'],r=True)}** | **{f(p['total_r'],r=True)}** | — | **{f(p['max_dd_r'],r=True)}** | **{f(p['net_usd'],money=True)}** |")
print("\n".join(out))
