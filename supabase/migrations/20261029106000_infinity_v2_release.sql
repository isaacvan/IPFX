begin;
-- Integration is complete; activation still requires the owner's published
-- document and chosen commission for every enabled symbol. Starts stay off.
alter table public.infinity_v2_settings add constraint infinity_v2_published_terms foreign key(terms_version) references public.platform_legal_documents(version);
create function public.infinity_v2_activation_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.infinity_v2_enabled then
 if not exists(select 1 from public.platform_legal_documents where version=new.terms_version and kind='terms' and length(coalesce(document_url,''))>0) then raise exception 'PUBLISH_V2_TERMS_FIRST';end if;
 if exists(select 1 from public.symbol_specs s left join public.infinity_v2_pricing_profiles p on p.symbol=s.symbol
  where coalesce(s.enabled,true) and p.commission_round_turn_per_lot is null) then raise exception 'SET_V2_COMMISSION_FIRST';end if;
 end if;return new;
end $$;
create trigger infinity_v2_activation_guard before update on public.infinity_v2_settings for each row execute function public.infinity_v2_activation_guard();
update public.infinity_v2_settings set integration_ready=true where singleton and not infinity_v2_enabled;
revoke all on function public.infinity_v2_activation_guard() from public,anon,authenticated;

insert into public.email_templates(key,category,subject,preheader,body_html,body_text,is_active) values(
 'infinity_monthly_restart_v2','account','Your new Infinity v2 Stage 1 is ready','Your new simulated Stage 1 account is ready on IPFX Markets.',
 '<p>Hi {{customer_name}},</p><p>Your new <strong>Infinity v2 Stage 1</strong> account is ready. Your dashboard shows the profit target, counted trades, consistency score and trading limits for this run.</p><p>There is no daily profit cap or minimum waiting period. Read the full rules and your saved requirements before trading.</p><p><a href="https://ipfxcapital.com/trading.html">Open IPFX Markets</a></p>',
 'Hi {{customer_name}}, your new Infinity v2 Stage 1 is ready. Your dashboard shows this run''s profit target, counted trades, consistency score and trading limits. There is no daily profit cap or minimum waiting period. Read the full rules before trading: https://ipfxcapital.com/trading.html',true)
on conflict(key) do nothing;
insert into public.email_templates(key,category,subject,preheader,body_html,body_text,is_active) select 'infinity_approved_v2',category,'Your Infinity v2 Challenge is ready',preheader,body_html,body_text,true from public.email_templates where key='infinity_monthly_restart_v2' on conflict(key) do nothing;
do $email$
declare src text;needle text:='values (c.user_id, ''infinity_monthly_restart'', who,';
begin
 select pg_get_functiondef('public.fn_infinity_monthly_auto_restart()'::regprocedure) into src;
 if position(needle in src)=0 then raise exception 'MONTHLY_RESTART_EMAIL_SOURCE_DRIFT';end if;
 insert into public.infinity_v2_legacy_definitions values('public.fn_infinity_monthly_auto_restart()',src);
 src:=replace(src,needle,'values (c.user_id, case when exists(select 1 from public.trading_accounts where id=new_acct and rules_version=''infinity_v2'') then ''infinity_monthly_restart_v2'' else ''infinity_monthly_restart'' end, who,');execute src;
end $email$;
commit;
