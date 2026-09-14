#!/usr/bin/env bash
# Start (or restart) the TradingView Paper Trading executor on this workstation. It needs
# the desktop app's CDP bridge, so it lives here and not on the box. Idempotent.
set -u
cd /root/tradingview-mcp
export DISPLAY=:10.0
LOG=/var/log/paper_executor.log
pkill -f 'node scripts/paper_executor.mjs' 2>/dev/null && sleep 1
setsid nohup node scripts/paper_executor.mjs >> "$LOG" 2>&1 < /dev/null &
sleep 2
if pgrep -f 'node scripts/paper_executor.mjs' >/dev/null; then echo "running, log: $LOG"; tail -n 3 "$LOG"; else echo "FAILED to start"; tail -n 20 "$LOG"; exit 1; fi
