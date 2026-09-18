import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTrader, decideMirrorRisk, matchingMacroEvent } from '../supabase/functions/_shared/trader-risk.ts';

const event = { event_at: '2026-09-18T12:30:00Z', country: 'United States', currency: 'USD', importance: 3, event_name: 'CPI' };

test('matches a USD macro event to EURUSD inside the evidence window', () => {
  assert.equal(matchingMacroEvent({ symbol:'EURUSD', volume:1, opened_at:'2026-09-18T12:20:00Z' }, [event])?.event_name, 'CPI');
});

test('classifies repeated macro-window trading as news-event trading', () => {
  const trades = Array.from({length:8}, (_,i) => ({ symbol:'EURUSD', volume:1, opened_at:`2026-09-18T12:${20+i}:00Z`, closed_at:`2026-09-18T12:${25+i}:00Z` }));
  assert.equal(classifyTrader(trades, [event]).category, 'news_event_trader');
});

test('adaptive risk reduces unusual size and observe mode does not execute recommendation', () => {
  const recent = Array.from({length:12}, (_,i) => ({symbol:'EURUSD',volume:1,opened_at:`2026-09-${String(i+1).padStart(2,'0')}T10:00:00Z`}));
  const trade = {symbol:'EURUSD',volume:5,opened_at:'2026-09-18T10:00:00Z'};
  const adaptive = decideMirrorRisk({event:'open',mode:'adaptive',trade,recentTrades:recent});
  assert.equal(adaptive.action, 'reduce');
  assert.equal(adaptive.multiplier, 0.2);
  const observe = decideMirrorRisk({event:'open',mode:'observe',trade,recentTrades:recent});
  assert.equal(observe.action, 'allow');
  assert.equal(observe.multiplier, 1);
});

test('severe flags skip opens but closes are never blocked', () => {
  const trade = {symbol:'GBPUSD',volume:1,opened_at:'2026-09-18T10:00:00Z'};
  assert.equal(decideMirrorRisk({event:'open',mode:'adaptive',trade,recentTrades:[],openFlagReasons:['DRAWDOWN_SWING']}).action, 'skip');
  assert.equal(decideMirrorRisk({event:'close',mode:'blocked',trade,recentTrades:[]}).action, 'allow');
});
