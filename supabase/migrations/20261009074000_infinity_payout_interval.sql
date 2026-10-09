-- Align Infinity Stage4 with the existing published default; other programmes retain their interval.
-- Surgical deployed-definition edit preserves unrelated concurrent payout changes.
do $repair$
declare body text;
begin
 select pg_get_functiondef('public.fn_request_payout(uuid,uuid,boolean,text,uuid)'::regprocedure) into body;
 if position('v_min_days        constant int     := 7;'in body)=0 or position('if v_acct.phase'in body)=0 then raise exception 'PAYOUT_SOURCE_DRIFT_REVIEW_REQUIRED';end if;
 body:=replace(body,'v_min_days        constant int     := 7;','v_min_days        int := 7;');
 body:=replace(body,'  if v_acct.phase','  if v_acct.challenge_type = ''infinity'' and v_acct.stage = 4 then v_min_days := 14; end if;'||chr(10)||'  if v_acct.phase');
 execute body;
end $repair$;
