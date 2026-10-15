// Executes the real executor open function with entirely synthetic I/O. No network or tokens.
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { POLICY_V1 } from '../../supabase/functions/_shared/ab-classifier.ts';
import { emergencyStop, fundedRiskUsd, legSide, lotsFor, sizeMultiplier } from '../../supabase/functions/_shared/ab-allocator.ts';
import { exactTestOpenReceipt } from '../../supabase/functions/_shared/copy-test-receipt.ts';
import { ongoingSizing, exactExecutionReceipt } from '../../supabase/functions/_shared/ongoing-execution.ts';

export function bookOpenFixture(options = {}) {
  const text = options.source ?? fs.readFileSync(new URL('../../supabase/functions/book-executor/index.ts', import.meta.url), 'utf8');
  const code = text.slice(text.indexOf('async function ledgerPoints('), text.indexOf('async function closeLeg('));
  const trace = [], requests = [], posts = [];
  let sourceReads=0;
  let clock = 0;
  const turn = async (name) => { trace.push(name); const start = clock; await Promise.resolve(); clock = Math.max(clock, start + 25); };
  const gold = { symbol: 'XAUUSD.C', lot_size: 100, quote_currency: 'USD', spec_observed_at: new Date().toISOString(), lot_step: .01, min_qty: .01, trade_route_id: 1, tradable_instrument_id: 2, ...options.gold };
  const source = { id: 'synthetic-trade', user_id: 'synthetic-user', account_id: 'synthetic-demo', symbol: 'XAUUSD', side: 'buy', volume: .02, open_price: 4000, sl: 3999, status: 'open' };
  const trial = options.ordinary ? { handled: false } : { handled: true, ok: true, destination_id: 7, broker_lots: .01, max_trade_risk_usd: 10, session_id: 1, ...(options.ongoing?{ongoing:true,connection_id:1}:{}), ...options.trial };
  const ladders = [{ id: 7, size_usd: 50000, signal_group: 0, copy_test_only: !options.ordinary, instrument_map: [gold], role: options.ongoing?'monitor':'ladder', execution_enabled: !options.ongoing, status: 'funded' },
    ...(options.otherLadder ? [{ id: 8, size_usd: 50000, signal_group: 0, copy_test_only: true, instrument_map: [gold], role: 'ladder', execution_enabled: true, status: 'funded' }] : [])];
  const db = {
    async rpc(name, args) {
      requests.push({ name, args }); await turn(name);
      const data = { ab_person_of: 'synthetic-person',ongoing_copy_claim:options.ongoing?trial:{handled:false},ongoing_copy_access:!options.accessRefused,ongoing_copy_note:{ok:true}, copy_test_claim: trial, ab_route_for_user: options.route ?? 'a', ab_person_progress: 'EARLY', treasury_status: options.treasury ?? 'healthy',
        ab_reserve_risk: options.riskRefused ? { ok: false, reason: 'HALT' } : { ok: true, allowed_usd: args?.p_risk_usd }, ab_release_risk: null, copy_test_note: { ok: true } }[name];
      return { data, error: name === 'copy_test_claim' && options.admissionError ? { message: 'Unavailable' } : null };
    },
    from(table) {
      const filters = [], q = { table, verb: 'select', single: false, fields: '' };
      const chain = {
        select(fields, settings) { q.fields = fields; q.count = !!settings?.count; return chain; },
        eq(key, value) { filters.push([key, value]); return chain; }, in() { return chain; }, not() { return chain; }, order() { return chain; }, limit() { return chain; }, gte() { return chain; },
        maybeSingle() { q.single = true; return chain; }, single() { q.single = true; return chain; },
        insert(value) { q.verb = 'insert'; q.value = value; return chain; }, update(value) { q.verb = 'update'; q.value = value; return chain; },
        async then(resolve, reject) {
          try {
            requests.push({ ...q, filters: [...filters] }); await turn(table + ':' + q.verb);
            let data = { trades: source, ab_trader_profiles: { state_since: new Date().toISOString() }, ab_risk_limits: { max_multiplier: 1, account_size_usd: 0 }, ab_settings: { a_scale: 1, b_scale: 1 },
              ab_policy_versions: { thresholds: {} },symbol_specs:{contract_size:100,quote_currency:'USD',...options.sourceSpec}, ladder_settings: { signal_groups: 1 }, team_book_destinations: null, ab_trade_ledger: [], book_orders: { id: 22 } }[table];
            if(table==='trades'&&++sourceReads>1&&options.sourceChangedDuringOpen)data={...source,...options.sourceChangedDuringOpen};
            if (table === 'ladder_accounts') { const rows = ladders.filter(l => filters.every(([k, v]) => l[k] === v)); data = q.single ? rows[0] ?? null : rows; }
            resolve({ data, error: null, count: 1 });
          } catch (e) { reject(e); }
        },
      };
      return chain;
    },
  };
  const context = vm.createContext({ Date, Number, String, Math, Promise, POLICY_V1, emergencyStop, fundedRiskUsd, legSide, lotsFor, sizeMultiplier, exactTestOpenReceipt,ongoingSizing,exactExecutionReceipt,
    saveDispatchEvidence:(_db,input)=>{requests.push({name:'dispatch-evidence',input});return Promise.resolve();},
    executionInstrument:async()=>({lotSize:100,minLot:.01,maxLot:100,lotStep:.01,quotingCurrency:'USD',...options.brokerSpec}),
    closeLeg:async(db,body)=>{trace.push('catchup-exit');requests.push({name:'catchup-exit',body});return {ok:true};},
    destination: async () => { await turn('destination-guard'); return options.noDestination ? null : { token: 'synthetic-only',env:'demo', accountId: 'synthetic-broker', accNum: '1', map: [gold] }; },
    instrumentFor: map => map[0], signalGroup: () => 0,
    reserveCapacity: async (...args) => { await turn('capacity-guard'); requests.push({ name: 'capacity-guard', requireEmpty: args[5] }); return { ok: !options.capacityRefused,prior_position_ids:options.priorPositions??[], reason: 'Synthetic capacity refusal' }; },
    marketOrder: input => input, bookStrategy: (book, trade) => book + ':' + trade,
    placeMarketOrder: async (...args) => { await turn('broker-submit'); posts.push(args[3]); return options.ongoing?{orderId:'900',positionId:'901'}:{ orderId: 'synthetic-order', positionId: 'synthetic-position' }; },
    responseIds: x => x,
    orderFill: async () => { await turn('broker-receipt'); return { price: 4000, qty: Number(trial.broker_lots??.01), orderId: options.ongoing?'900':'synthetic-order', positionId: options.ongoing?'901':'synthetic-position', ...options.fill }; },
  });
  const open = vm.runInContext(stripTypeScriptTypes(code) + '\nopen', context);
  return { run: () => open(db, { source_trade_id: source.id, book: options.book ?? 'a', risk_usd: 2, price_scale_per_lot: 100 }), trace, requests, posts, modeledMs: () => clock };
}
