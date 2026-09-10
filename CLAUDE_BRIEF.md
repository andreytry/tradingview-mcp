# GlobexTraps — build brief

## Architecture

```
TradingView (Pine strategy, 5m)
    | webhook POST, JSON signal
Backend (Node/Express, this box, port 8080)
    | 10 gates, fail-closed
TradersPost webhook
    |
Tradovate -> MyFundedFutures account
```

Pine finds the setup and marks it on the chart. The backend re-derives every number and
blocks anything unsafe — it exists because TradersPost executes whatever it receives, so a
Pine bug must not become a live order. It is also the only place the correlation guard and
the MFFU drawdown guard can live. Fills flow back so the backend tracks live equity.

Strategy = Sweep-Reclaim v2 on MNQ1!, MES1!, MYM1!, M2K1!, 5-minute, 09:30-11:30 ET.
6-month backtest: 62 trades, 65% win, avgR +0.237, PF 1.63, t=1.94. Suggestive, not proven.

## PART A — Backend (build this first)

Node 18+, Express. Modules: config.js, mffu.js, risk.js, traderspost.js, server.js.
Export the pipeline function separately from the HTTP layer so tests run without a port.

Endpoints:
```
POST /webhook  signal intake, gates, relay
POST /fill     {secret, signalId, pnl} -> release open risk, advance equity+peak
POST /equity   {secret, equity, peak} -> authoritative reconcile vs MFFU dashboard
GET  /health   kill-switch, size multiplier, open positions, drawdown snapshot
```

Ten gates, in order, all fail-closed. Log every skip with its reason to signals.log.jsonl.
Return 200 on skips (403 only for bad secret) so TradingView does not retry-storm.

```
1  shared secret
2  v == 1
3  strategy == "sweep-reclaim-v2"
4  idempotency on id, 24h window
5  staleness: bar_time within 90s
6  geometry: LONG stop<entry<target, SHORT target<entry<stop
7  risk: R <= 1*ATR, R >= 16 ticks, |target-entry| == R +/- 2 ticks
8  session 09:30-11:30 ET Mon-Fri
9  correlation guard
10 MFFU drawdown guard
```

Correlation guard: the four micros are highly correlated, so two simultaneous
same-direction signals are one bet at double size. First signal per session per direction
wins; later same-direction signals on OTHER symbols are skipped. Same symbol may re-fire
once flat. Max 1 concurrent open position.

MFFU drawdown guard:
```
floor(peak) = min(peak - 2000, +100)
```
Max Loss trails the intraday equity high-water mark by $2000 and LOCKS at +$100 once the
HWM hits +$2100. Before each order, project worst case (all open positions stop out) and
refuse if it lands within $250 of the floor. Latch on breach.

Sizing (0.75x, hard cap — do not raise):
```
MNQ1! tick 0.25 pv $2.00 -> 4 micros
MES1! tick 0.25 pv $5.00 -> 8 micros
MYM1! tick 1.0  pv $0.50 -> 11 micros
M2K1! tick 0.1  pv $5.00 -> 11 micros
```
Total 34, inside the Rapid 50K cap of 50. Why 0.75x: replayed on the real 6-month
sequence, 1.00x produced $2278 intraday drawdown against a $2000 limit — it blows the
account. 0.75x gives $1709.

Relay to TradersPost, POST https://webhooks.traderspost.io/trading/webhook/{uuid}/{password}

```json
{
  "ticker": "MNQ", "action": "buy", "sentiment": "bullish",
  "orderType": "limit", "limitPrice": 30197.50,
  "quantity": 4, "quantityType": "fixed_quantity",
  "time": "2026-09-07T14:25:00Z",
  "takeProfit": { "limitPrice": 30229.75 },
  "stopLoss": { "type": "stop", "stopPrice": 30164.25 },
  "extras": { "strategy": "sweep-reclaim-v2", "signalId": "..." }
}
```

Absolute prices only, never percent/amount — those drift from the backtested levels.
Entry = signal entry +/- 2 ticks (marketable limit), rounded to tick.

Env: WEBHOOK_SECRET, TRADERSPOST_WEBHOOK_URL, SIZE_MULTIPLIER=0.75, MFFU_TRAILING_DD=2000,
MFFU_LOCK_AT=100, MFFU_MARGIN_BUFFER=250, MAX_CONCURRENT_POSITIONS=1, STALE_MS=90000,
SESSION_ENFORCE=1, KILL_SWITCH=1.

Ship with KILL_SWITCH=1 (validate and log, send nothing). Write tests covering every gate,
the drawdown lock, payload mapping, and end-to-end pipeline. Reference build had 39 cases.

Known limitation to document: the backend sees closed equity plus known open risk, not
tick-by-tick intraday equity, so its drawdown reading runs low. That is why 0.75x, the
$250 buffer, and daily /equity reconciliation exist.

## PART B — Pine side

### B1. Three blocking patches — DONE 2026-09-07 (see status note at end)

1. Lookahead bias: D1/W request.security uses lookahead_on, which returns the FINAL daily
   close on forming historical bars. Switch to lookahead_off. Every backtest with the
   trend gate on is inflated until fixed.
2. Unconfirmed bars: calc_on_every_tick=true lets zones roll back but orders do not.
   Wrap entry, drawing and alert in `if barstate.isconfirmed`.
3. HTF parity: request [open[1],high[1],low[1],close[1],ta.atr(len)[1],time[1]] with
   lookahead_on — the repaint-free pattern. Zone timing shifts one HTF bar later; correct.

STOP after patching. Re-run Strategy Tester, report before/after delta to Andrew. That
delta says how much of the edge was lookahead artifact. Do not continue until he replies.

### B2. Chart marking — required, currently missing

Every trade drawn live, automatically. You wrote this code once to mark the 14 backtest
trades; move it into the strategy.
  - entry line at reclaim close, price labelled
  - red box entry->stop      rgba(242,54,69,0.28), border #f23645
  - green box entry->target  rgba(8,153,129,0.28), border #089981
  - dashed line at the swept PM level, #ffb300
  - label: side, entry, SL, TP; on exit extend boxes and append "+1R WIN" / "-1R LOSS"

box.new/line.new/label.new with xloc.bar_time. Set max_boxes_count=500,
max_labels_count=500 and delete oldest. Andrew must read the whole trade off the chart.

### B3. Signal emission

alert() inside the strategy, alert.freq_once_per_bar_close. NEVER freq_once_per_bar.
One alert per symbol, four total. Webhook URL goes in the alert dialog, not the source.
With alert(), TradingView sends the function string and ignores the dialog message box.

```
webhook_secret = input.string("", "Webhook secret", group="Webhook")
f_num(x) => str.tostring(x, "#.########")

if barstate.isconfirmed and signal_valid
    string msg = '{"v":1,"secret":"' + webhook_secret +
      '","strategy":"sweep-reclaim-v2"' +
      ',"id":"' + syminfo.ticker + '-' + str.tostring(time) + '"' +
      ',"symbol":"' + syminfo.ticker + '"' +
      ',"side":"' + (is_long ? "LONG" : "SHORT") + '"' +
      ',"entry":'       + f_num(entry_px) +
      ',"stop":'        + f_num(stop_px) +
      ',"target":'      + f_num(target_px) +
      ',"atr":'         + f_num(atr_at_sweep) +
      ',"sweep_wick":'  + f_num(wick_px) +
      ',"zone_top":'    + f_num(z_top) +
      ',"zone_bottom":' + f_num(z_bot) +
      ',"zone_tf":"'    + z_tf + '"' +
      ',"bar_time":'    + str.tostring(time) + '}'
    alert(msg, alert.freq_once_per_bar_close)
```

Field rules: bare JSON numbers, no quotes, no trailing commas. bar_time is unix ms (Pine
`time`, do not multiply). symbol keeps the 1! suffix. atr is the ATR14 AT THE SWEEP BAR,
not the reclaim bar — wrong bar changes which trades qualify. Do not use format.mintick,
it injects symbol formatting that breaks JSON. Single-quoted Pine literals so the JSON
double quotes survive.

Secret lives in the script input only. Never a literal, never in the alert dialog, never
committed, never in chat. Keep the script private.

## Verification

1. Print one built message, confirm it parses as JSON.
2. Backend KILL_SWITCH=1, replay a signal with curl. Outside 09:30-11:30 ET expect
   `{"ok":false,"reason":"outside_session_window"}` — proves every gate up to session works.
3. One live session, watch signals.log.jsonl. No signal that day is normal — the funnel
   yields roughly one trade per symbol per two weeks. You are checking the server is alive
   and skips carry sensible reasons.
4. Report: backtest delta, one captured payload, the session log lines.

## Rules that do not bend

- Never relax the zone filter to raise trade frequency. Removing it flattened avgR from
  +0.61 to +0.17. Low frequency is a property of the strategy, not a bug.
- Never raise SIZE_MULTIPLIER above 0.75.
- Never add fields to work around a rejection. If the backend rejects, the signal is wrong.
- Skip contract roll sessions; PM ranges spanning a roll are invalid.
- Confirm webhooks exist on the current TradingView plan before starting. If not, stop and
  tell Andrew rather than working around it.


---

## STATUS 2026-09-08

- **B1 complete.** D1/W lookahead N/A (no such call in GlobexTraps); unconfirmed-bar and HTF-parity fixed. Delta +0.003 avgR — noise. Backtest headline unchanged.
- **B2 complete.** Live trade marking verified on a win and a loss.
- **B3 complete.** `emitSignal()` emits the v1 JSON, secret from a script input, `freq_once_per_bar_close`.
- **E2E test mode added.** `e2eMode`/`e2eEvery`; MNQ1! @ 1m, every 2 bars = 2 minutes.
- **Endpoint live:** `https://n8n.ai-process.net:8446/webhook` (health returns 200).
- **Blocked:** backend `WEBHOOK_SECRET` not known to the Pine side; TradingView may reject port 8446 (80/443 only).
