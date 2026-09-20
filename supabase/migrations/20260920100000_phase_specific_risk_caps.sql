-- Phase-specific risk caps derived from each phase's target and loss geometry.
-- Base cap = min(profit target / 10, maximum drawdown / 8, daily loss / 4).
-- Professional/PAC accounts use a conservative 0.50% default.

update public.challenge_presets
set max_risk_per_trade_pct = case
      when challenge_type = 'infinity' and stage between 1 and 3 then 0.70
      when challenge_type = 'infinity' and stage = 4 then 0.50
      when challenge_type = 'traditional' and stage = 1 then 0.75
      when challenge_type = 'traditional' and stage = 2 then 0.50
      when challenge_type = 'traditional' and stage = 3 then 0.40
      when challenge_type = 'futures' and stage = 1 then 0.50
      when challenge_type = 'futures' and stage = 2 then 0.40
      when challenge_type = 'pac' then 0.50
      else max_risk_per_trade_pct
    end,
    require_stop_loss = true
where challenge_type in ('infinity', 'traditional', 'futures', 'pac');

-- Keep accounts already provisioned for the October launch on the same rules
-- as their preset. Demo accounts are deliberately unrestricted.
update public.trading_accounts a
set max_risk_per_trade_pct = p.max_risk_per_trade_pct,
    require_stop_loss = p.require_stop_loss
from public.challenge_presets p
where a.preset_id = p.id
  and a.challenge_type in ('infinity', 'traditional', 'futures', 'pac')
  and coalesce(a.phase, '') <> 'demo';

