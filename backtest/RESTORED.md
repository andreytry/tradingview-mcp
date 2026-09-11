# Restored profitable configuration — nested zones

Reproduces the six-month headline from the 10 Sep 2026 session.

    HTF_SEC=900 TREND_LEG=3 TP_MODE=fixedR MIN_RR=2 node backtest/nested.mjs

Window 11 Mar – 4 Sep 2026, symbols MNQ, MES, MYM, M2K, MGC (oil and euro excluded,
both lose):

| set                | n   | win   | avg R  | tot R | PF   | USD   | t    | maxDD  |
|--------------------|-----|-------|--------|-------|------|-------|------|--------|
| 5 kept             |  89 | 51.7% | +0.472 | +42.0 | 1.93 | +2003 | 2.76 | -9.5R  |
| 4 index only       |  68 | 48.5% | +0.382 | +26.0 | 1.70 |  +631 | 1.84 | -9.5R  |
| all 7 incl MCL, 6E | 133 | 42.1% | +0.168 | +22.3 | 1.27 |  +684 | 1.29 | -14.1R |

What made the earlier reruns look dead was the DEFAULTS, not the strategy: the file
defaults to HTF_SEC=3600, TREND_LEG=5, TP_MODE=zone, MIN_RR=3, which yields 6 trades in
six months. The profitable setting is a 15-minute higher timeframe, a 3-leg trend and a
banked 2R target.

Known limits, carried over from the session that produced it: the edge does not survive
extension — twelve months and two years both land near PF 1.0 — and the deployed Pine
script does not implement this logic.

---

# Minimal double-zones — the profitable simplification (11 Sep 2026)

Three criteria only. Zones are the original script's, untouched.

    CT=30 NESTED=1 CTX=htfcandle STRONG=1.0 MAXBASE=3 HTF=60 \
    TRIGGER=touch RR=2 BE=0 MAXRISK=1 MAXTOUCH=1 \
    FROM=<from> TO=<to> node backtest/simplezones.mjs

| window              | n    | win   | avg R  | tot R   | PF   | USD     | t     | /day | maxDD  |
|---------------------|------|-------|--------|---------|------|---------|-------|------|--------|
| 6 months            |  870 | 46.2% | +0.310 |  +269.6 | 1.54 |  +9,201 |  6.27 | 6.17 | -17.5R |
| 12 months           | 1665 | 47.0% | +0.321 |  +534.0 | 1.56 | +20,681 |  8.27 | 6.10 | -17.5R |
| 24 months           | 3352 | 46.7% | +0.301 | +1009.9 | 1.52 | +31,988 | 11.07 | 6.12 | -19.1R |
| older 18m, unseen   | 2480 | 47.0% | +0.302 |  +748.6 | 1.52 | +23,491 |  9.30 | 6.11 | -19.1R |

All five symbols profitable (PF 1.34 to 1.70). All nine quarters profitable (PF 1.26 to
1.98). Halves 1.48 / 1.55. Direction 1456 long / 1896 short.

The three changes that turned the original from PF 0.13 into this:
  1. enter at the zone edge on touch, not at the close of the bar that already ran
  2. no break-even stop
  3. one zone, one trade

Cost sensitivity, median risk 31 ticks: +1 tick PF 1.41, +2 ticks 1.32, +3 ticks 1.23,
+4 ticks 1.15. It survives realistic slippage but the margin is not huge.
