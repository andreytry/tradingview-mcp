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
