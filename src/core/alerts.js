/**
 * Core alert logic.
 *
 * Alerts are created / listed / deleted through TradingView's pricealerts REST API
 * (https://pricealerts.tradingview.com) using the desktop app's authenticated session.
 * Requests are sent as text/plain so the browser does not issue a CORS preflight that
 * the endpoint rejects. The create/delete bodies must be wrapped in a `payload` object.
 */
import { evaluate, evaluateAsync, safeString, requireFinite } from '../connection.js';

// Map the tool's friendly condition names to TradingView's alert condition types.
const CONDITION_TYPE_MAP = {
  crossing: 'cross', cross: 'cross',
  greater_than: 'greater', greater: 'greater', above: 'greater', '>': 'greater',
  less_than: 'less', less: 'less', below: 'less', '<': 'less',
};

export async function create({ condition, price, message }) {
  const p = requireFinite(price, 'price');
  const condType = CONDITION_TYPE_MAP[String(condition || 'crossing').trim().toLowerCase()] || 'cross';

  return evaluate(`
    (function() {
      try {
        var ms = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
        var sym = (ms.proSymbol && ms.proSymbol()) || (ms.symbol && ms.symbol());
        if (!sym) return { success: false, error: 'Could not read current chart symbol from TradingView' };
        var price = ${JSON.stringify(p)};
        var condType = ${safeString(condType)};
        var msg = ${safeString(message || '')};
        if (!msg) {
          var verb = condType === 'greater' ? 'above' : (condType === 'less' ? 'below' : 'crossing');
          msg = sym.split(':').pop() + ' ' + verb + ' ' + price;
        }
        var cond = { type: condType, frequency: 'on_first_fire', series: [{ type: 'barset' }, { type: 'value', value: price }], resolution: '1' };
        var payload = {
          conditions: [cond],
          symbol: '={"symbol":"' + sym + '"}',
          resolution: '1',
          message: msg,
          sound_file: 'alert/fired', sound_duration: 0,
          popup: true, auto_deactivate: true,
          email: false, sms_over_email: false, mobile_push: true,
          web_hook: null, name: null,
          expiration: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          active: true, ignore_warnings: true
        };
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/create_alert', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: payload }));
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) {}
        if (data.s === 'ok') {
          return { success: true, source: 'internal_api', symbol: sym, price: price, condition: condType, message: msg, alert_id: (data.r && data.r.alert_id) || null };
        }
        return { success: false, source: 'internal_api', error: (data.err && data.err.code) || data.errmsg || ('HTTP ' + x.status), response: (x.responseText || '').slice(0, 200) };
      } catch (e) {
        return { success: false, source: 'internal_api', error: e.message };
      }
    })()
  `);
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all, alert_ids, alert_id } = {}) {
  // Resolve the set of alert ids to delete.
  let ids = [];
  if (Array.isArray(alert_ids)) ids = ids.concat(alert_ids);
  if (alert_id != null) ids.push(alert_id);
  if (delete_all) {
    const listed = await list();
    ids = (listed.alerts || []).map((a) => a.alert_id);
  }
  ids = ids.filter((x) => x != null);
  if (!ids.length) {
    return { success: false, source: 'internal_api', error: delete_all ? 'No alerts to delete.' : 'Provide delete_all: true or an alert_id to delete.' };
  }

  const result = await evaluate(`
    (function() {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/delete_alerts', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } }));
        var data = {}; try { data = JSON.parse(x.responseText); } catch (e) {}
        return { ok: data.s === 'ok', status: x.status, response: (x.responseText || '').slice(0, 200) };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
  if (result && result.ok) {
    return { success: true, source: 'internal_api', deleted_count: ids.length, alert_ids: ids };
  }
  return { success: false, source: 'internal_api', alert_ids: ids, error: (result && (result.error || result.response)) || 'delete failed' };
}

/**
 * Create a STRATEGY alert (Pine script condition) with an optional webhook.
 *
 * alert_create only builds price alerts. This builds the `type: 'strategy'` condition
 * that fires the script's own alert() calls, which is what a Pine strategy needs.
 *
 * The study's pine_id / pine_version / inputs are read from whichever chart pane
 * currently hosts `study_name`, so the alert can be created for ANY symbol without
 * switching the chart. Inputs are a snapshot: change them on the chart first, then
 * create, exactly as the alert dialog behaves.
 *
 * Sent as sync XHR with text/plain to avoid the CORS preflight the endpoint rejects.
 */
export async function createStrategyAlert({
  symbol, study_name, web_hook, resolution, message,
  expiration_days = 30, currency_id = 'USD', session = 'regular',
} = {}) {
  if (!symbol) return { success: false, error: 'symbol is required, e.g. "CME_MINI:MES1!"' };
  if (!study_name) return { success: false, error: 'study_name is required, e.g. "GlobexTraps"' };

  return evaluate(`
    (function() {
      try {
        var NAME = ${safeString(study_name)};
        var SYM  = ${safeString(symbol)};
        var HOOK = ${web_hook ? safeString(web_hook) : 'null'};
        var RES  = ${resolution ? safeString(String(resolution)) : 'null'};
        var MSG  = ${message ? safeString(message) : 'null'};
        var DAYS = ${JSON.stringify(Number(expiration_days) || 30)};
        var CUR  = ${safeString(currency_id)};
        var SESS = ${safeString(session)};

        // locate the study on any chart pane
        var api = null, host = null;
        var n = TradingViewApi.chartsCount ? TradingViewApi.chartsCount() : 1;
        for (var i = 0; i < n && !api; i++) {
          var c = TradingViewApi.chart(i);
          var st = c.getAllStudies().filter(function(s) { return s.name === NAME; })[0];
          if (st) { api = c.getStudyById(st.id); host = c; }
        }
        if (!api) return { success: false, error: 'Study "' + NAME + '" not found on any chart pane. Add it first.' };

        var vals = api.getInputValues();
        var inputs = {}, pineId = null, pineVersion = null;
        vals.forEach(function(v) {
          if (v.id === 'pineId') { pineId = v.value; return; }
          if (v.id === 'pineVersion') { pineVersion = v.value; return; }
          if (v.id === 'text') return;              // encrypted source blob, not sent
          inputs[v.id] = v.value;                    // in_N + pineFeatures + __profile
        });
        if (!pineId) return { success: false, error: 'Study "' + NAME + '" has no pineId - not a Pine script?' };

        var res = RES || host.resolution();
        var msg = MSG || (NAME + ': {{strategy.order.action}} {{strategy.order.contracts}} @ {{ticker}}');

        var payload = {
          conditions: [{
            type: 'strategy',
            strategy_mode: 'strategy_and_alerts',
            series: [{
              type: 'study',
              study: 'StrategyScript@tv-scripting-101',
              inputs: inputs,
              pine_id: pineId,
              pine_version: pineVersion,
            }],
            resolution: res,
          }],
          symbol: '={"currency-id":"' + CUR + '","session":"' + SESS + '","symbol":"' + SYM + '"}',
          resolution: res,
          message: msg,
          sound_file: 'alert/fired', sound_duration: 0,
          popup: true, auto_deactivate: false,
          email: true, sms_over_email: false, mobile_push: true,
          web_hook: HOOK, name: null,
          expiration: new Date(Date.now() + DAYS * 24 * 3600 * 1000).toISOString(),
          active: true, ignore_warnings: true
        };

        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/create_alert', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: payload }));
        var data = {}; try { data = JSON.parse(x.responseText); } catch (e) {}
        if (data.s === 'ok') {
          return {
            success: true, source: 'internal_api', symbol: SYM, study: NAME,
            pine_id: pineId, pine_version: pineVersion, resolution: res,
            web_hook: HOOK, alert_id: (data.r && data.r.alert_id) || null
          };
        }
        return {
          success: false, source: 'internal_api', symbol: SYM,
          error: (data.err && data.err.code) || data.errmsg || ('HTTP ' + x.status),
          response: (x.responseText || '').slice(0, 200)
        };
      } catch (e) {
        return { success: false, source: 'internal_api', error: e.message };
      }
    })()
  `);
}
