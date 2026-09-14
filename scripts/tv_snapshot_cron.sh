#!/usr/bin/env bash
# Periodic TradingView -> Supabase snapshot. Runs on this workstation because the CDP
# bridge to the desktop app is local. Skips cleanly if the app is not up.
set -u
cd /root/tradingview-mcp
export DISPLAY=:10.0
export SUPABASE_URL="$(grep -E '^SUPABASE_URL=' /root/globextraps/.env | cut -d= -f2-)"
export SUPABASE_KEY="$(grep -E '^SUPABASE_KEY=' /root/globextraps/.env | cut -d= -f2-)"
if ! curl -s -m 3 http://127.0.0.1:9222/json/version >/dev/null; then
  echo "$(date -Is) tradingview CDP not up, skipping" >> /var/log/tv_snapshot.log; exit 0
fi
{ echo "=== $(date -Is)"; timeout 900 node scripts/tv_snapshot.mjs; echo "exit=$?"; } >> /var/log/tv_snapshot.log 2>&1
