-- S4: admin_audit_log is append-only. Even the service role (edge functions) can only INSERT/SELECT;
-- a trigger also blocks UPDATE/DELETE/TRUNCATE for any role that still holds the privilege.
revoke update, delete, truncate on public.admin_audit_log from service_role;

create or replace function public.fn_admin_audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'admin_audit_log is append-only';
end;
$$;

drop trigger if exists admin_audit_log_no_update on public.admin_audit_log;
create trigger admin_audit_log_no_update before update or delete on public.admin_audit_log
  for each row execute function public.fn_admin_audit_immutable();
drop trigger if exists admin_audit_log_no_truncate on public.admin_audit_log;
create trigger admin_audit_log_no_truncate before truncate on public.admin_audit_log
  for each statement execute function public.fn_admin_audit_immutable();
