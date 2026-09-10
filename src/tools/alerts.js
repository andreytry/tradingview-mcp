import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert on the current chart symbol via TradingView\'s alert API', {
    condition: z.string().describe('Alert condition: "crossing", "greater_than", or "less_than"'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('strategy_alert_create',
    'Create a STRATEGY alert (Pine script condition) with an optional webhook URL. Unlike alert_create (price only), this fires the script\'s own alert() calls. Reads pine_id/pine_version/inputs from the study wherever it sits on the chart, so any symbol can be armed without switching panes.', {
    symbol: z.string().describe('Full symbol to arm, e.g. "CME_MINI:MES1!" or "CBOT_MINI:MYM1!"'),
    study_name: z.string().describe('Name of the Pine strategy on the chart, e.g. "GlobexTraps"'),
    web_hook: z.string().optional().describe('Webhook URL the alert POSTs to'),
    resolution: z.string().optional().describe('Alert timeframe, e.g. "5". Defaults to the hosting chart resolution'),
    message: z.string().optional().describe('Alert message. Ignored for alert() payloads, which send the script string'),
    expiration_days: z.coerce.number().optional().describe('Days until expiry (default 30)'),
  }, async (args) => {
    try { return jsonResult(await core.createStrategyAlert(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete a specific alert by id, or all active alerts', {
    alert_id: z.coerce.number().optional().describe('Alert id to delete (from alert_list)'),
    delete_all: z.coerce.boolean().optional().describe('Delete all active alerts'),
  }, async ({ alert_id, delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ alert_id, delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
