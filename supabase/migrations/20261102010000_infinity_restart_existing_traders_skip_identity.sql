-- Owner decision, 2 Nov 2026: a trader who already holds an Infinity run (they were approved and are trading) can restart without
-- having completed the identity-and-address form or the identity-document application. 640 of 647 Infinity traders have both; the
-- other 7 were blocked at the restart dialog. People with no Infinity run (new applicants) still need both before a first start.
-- Identity and KYC remain required for Stage 3 and payouts (unchanged), and the age check still runs whenever an identity record exists.
-- Patches the live function body (same drift-guard pattern as the v2 release migrations) instead of replacing it wholesale.
begin;
do $restart$
declare src text;extra text:=' and not exists(select 1 from public.trading_accounts hx where hx.user_id=p_user and hx.challenge_type=''infinity'' and coalesce(hx.phase,'''')<>''demo'')';
begin
 select pg_get_functiondef('public.fn_restart_infinity_v2(uuid,text,boolean,boolean)'::regprocedure) into src;
 if position(') then raise exception ''COMPLETE_IDENTITY_FIRST'';' in src)=0 or position(') then raise exception ''COMPLETE_KYC_FIRST'';' in src)=0 then raise exception 'RESTART_IDENTITY_SOURCE_DRIFT';end if;
 src:=replace(src,') then raise exception ''COMPLETE_IDENTITY_FIRST'';',')'||extra||' then raise exception ''COMPLETE_IDENTITY_FIRST'';');
 src:=replace(src,') then raise exception ''COMPLETE_KYC_FIRST'';',')'||extra||' then raise exception ''COMPLETE_KYC_FIRST'';');
 execute src;
end $restart$;
commit;
