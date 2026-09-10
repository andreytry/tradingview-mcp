#!/bin/bash
# Pull FX / metals / crypto futures from Databento and regress the zones strategy on them.
#
#   DATABENTO_API_KEY=db-xxxx bash backtest/pull_and_test.sh
#
# Pulls the VOLUME-rolled continuous series (.v.0). The calendar roll (.c.0) returns a
# sparse series between rolls and produced a wrong answer on gold once already, so the
# prep step warns loudly if a symbol comes back thin.
set -u
cd /root/tradingview-mcp

: "${DATABENTO_API_KEY:?set DATABENTO_API_KEY first}"
START=2026-03-06
END=2026-09-06
RAW=backtest-data/raw
mkdir -p "$RAW"

# symbol : tick : point value : label
CONTRACTS=(
  "6B:0.0001:62500:British pound"
  "6J:0.0000005:12500000:Japanese yen"
  "6N:0.0001:100000:New Zealand dollar"
  "6A:0.0001:100000:Australian dollar"
  "6C:0.00005:100000:Canadian dollar"
  "6S:0.00005:125000:Swiss franc"
  "MBT:5:0.1:Bitcoin micro"
  "SIL:0.005:1000:Silver micro"
  "6E:0.00005:125000:Euro FX"
)

# A symbol whose volume-rolled series is already on disk and complete is not pulled
# again. Euro is already there, and Databento bills per pull.
NEED=()
for c in "${CONTRACTS[@]}"; do
  sym=${c%%:*}
  n=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('backtest-data/${sym}_1m.json')).length)}catch(e){console.log(0)}")
  if [ "${FORCE_PULL:-0}" = 1 ] || [ "$n" -lt 150000 ]; then NEED+=("$c"); else echo "have $sym ($n bars), skipping pull"; fi
done

if [ ${#NEED[@]} -eq 0 ]; then
  echo "all series already on disk; going straight to the regression"
  PULLED=("${CONTRACTS[@]}")
else
SYMLIST=$(printf '%s,' "${NEED[@]%%:*}"); SYMLIST=${SYMLIST%,}
SYMLIST=$(echo "$SYMLIST" | sed 's/\([A-Z0-9]*\)/\1.v.0/g')

echo "== cost estimate =="
curl -s -u "$DATABENTO_API_KEY:" https://hist.databento.com/v0/metadata.get_cost \
  -d dataset=GLBX.MDP3 -d symbols="$SYMLIST" -d stype_in=continuous \
  -d schema=ohlcv-1m -d start=$START -d end=$END
echo; read -rp "proceed? [y/N] " ok; [ "$ok" = y ] || exit 0

PULLED=()
for c in "${NEED[@]}"; do
  sym=${c%%:*}
  echo "== $sym =="
  curl -s -u "$DATABENTO_API_KEY:" https://hist.databento.com/v0/timeseries.get_range \
    -d dataset=GLBX.MDP3 -d symbols="$sym.v.0" -d stype_in=continuous \
    -d schema=ohlcv-1m -d start=$START -d end=$END -d encoding=csv \
    -o "$RAW/${sym}_1m.csv"
  # An auth or quota failure returns a short JSON body, not a CSV. Catch it here rather
  # than letting the prep step turn it into an empty series and a meaningless backtest.
  if [ "$(wc -c < "$RAW/${sym}_1m.csv")" -lt 100000 ]; then
    echo "  FAILED: $(head -c 200 "$RAW/${sym}_1m.csv")"; continue
  fi
  node backtest/prep_any.mjs "$sym" && PULLED+=("$c")
done
# Anything skipped above is already prepped and belongs in the regression too.
for c in "${CONTRACTS[@]}"; do
  case " ${NEED[*]} " in *" $c "*) ;; *) PULLED+=("$c") ;; esac
done
fi

[ ${#PULLED[@]} -eq 0 ] && { echo "nothing pulled"; exit 1; }

EXTRA=$(python3 -c "
import json,sys
out=[]
for c in sys.argv[1:]:
    s,t,p,l=c.split(':')
    out.append([s,float(t),float(p),l])
print(json.dumps(out))" "${PULLED[@]}")

echo "== regression: nested zones, live config =="
EXTRA_SYMS="$EXTRA" NEST_MODE=on ZONE_TF=ltf TREND_LEG=3 HTF_SEC=900 MIN_RR=2 \
  TP_MODE=fixedR OUT=/tmp/zones_fx.json node backtest/nested.mjs

node backtest/stats_by_symbol.mjs /tmp/zones_fx.json
