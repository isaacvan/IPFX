-- Support chatbot knowledge base, owner-editable facts, and a privacy-safe
-- question log. All tables are service-role only: the public chat endpoint
-- and the admin console read/write them; browsers never touch them directly.
begin;

create table if not exists public.support_kb (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  topic text not null check (char_length(topic) between 2 and 40),
  title text not null check (char_length(title) between 3 and 200),
  keywords text[] not null default '{}',
  answer text not null check (char_length(answer) between 3 and 4000),
  follow_ups text[] not null default '{}',
  is_active boolean not null default true,
  -- seed updates never overwrite an entry the owner has edited
  edited_by_owner boolean not null default false,
  -- {h: hash of the embedded text, d: vector, t: title vector}; filled in by the support-chat function
  embedding text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.support_config (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  value text not null check (char_length(value) <= 1000),
  description text,
  edited_by_owner boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- One row per visitor question. The text is redacted (emails/phone/card-like
-- numbers removed) before insert; rows are purged after 90 days.
create table if not exists public.support_chat_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  question text not null,
  mode text not null check (mode in ('facts','kb','llm','guard','fallback','smalltalk')),
  kb_id text,
  answered boolean not null,
  top_score numeric(8,2),
  resolved boolean not null default false
);
create index if not exists support_chat_log_gap_idx
  on public.support_chat_log(created_at desc) where answered = false and resolved = false;
create index if not exists support_chat_log_created_idx on public.support_chat_log(created_at);

alter table public.support_kb enable row level security;
alter table public.support_config enable row level security;
alter table public.support_chat_log enable row level security;
revoke all on public.support_kb, public.support_config, public.support_chat_log from public, anon, authenticated;
revoke all on sequence public.support_chat_log_id_seq from public, anon, authenticated;
grant all on public.support_kb, public.support_config, public.support_chat_log to service_role;
grant all on sequence public.support_chat_log_id_seq to service_role;

-- 90-day retention for the chat log.
create or replace function public.purge_support_chat_log() returns void
language sql security definer set search_path = '' as $$
  delete from public.support_chat_log where created_at < now() - interval '90 days';
$$;
revoke all on function public.purge_support_chat_log() from public, anon, authenticated;
grant execute on function public.purge_support_chat_log() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('support-chat-log-purge')
      where exists (select 1 from cron.job where jobname = 'support-chat-log-purge');
    perform cron.schedule('support-chat-log-purge', '17 3 * * *', 'select public.purge_support_chat_log()');
  end if;
end $$;

commit;
