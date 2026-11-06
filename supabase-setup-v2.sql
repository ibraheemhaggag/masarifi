-- Masarifi v2: push reminders, account deletion, daily schedule

-- 1) Devices that asked for reminders (each user sees and manages only their own)
create table if not exists public.push_subscriptions (
  endpoint     text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  subscription jsonb not null,
  lang         text not null default 'ar',
  tz           text not null default 'Asia/Riyadh',
  updated_at   timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "own subs read"   on public.push_subscriptions;
drop policy if exists "own subs insert" on public.push_subscriptions;
drop policy if exists "own subs update" on public.push_subscriptions;
drop policy if exists "own subs delete" on public.push_subscriptions;
create policy "own subs read"   on public.push_subscriptions for select to authenticated using (auth.uid() = user_id);
create policy "own subs insert" on public.push_subscriptions for insert to authenticated with check (auth.uid() = user_id);
create policy "own subs update" on public.push_subscriptions for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own subs delete" on public.push_subscriptions for delete to authenticated using (auth.uid() = user_id);
revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- 2) Server-only tables (no access from the app)
create table if not exists public.push_config (key text primary key, value jsonb not null);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;

create table if not exists public.push_log (
  user_id  uuid not null references auth.users(id) on delete cascade,
  due_date date not null,
  sent_at  timestamptz not null default now(),
  primary key (user_id, due_date)
);
alter table public.push_log enable row level security;
revoke all on public.push_log from anon, authenticated;

-- 3) Let a signed-in user delete their own account (their ledger and devices go with it)
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from auth.users where id = auth.uid();
end; $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- 4) Daily reminder run at 06:00 UTC (09:00 Riyadh)
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'masarifi-reminders';
select cron.schedule(
  'masarifi-reminders',
  '0 6 * * *',
  $job$
  select net.http_post(
    url := 'https://qbiqyhpvooldrjuqwihz.supabase.co/functions/v1/reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFiaXF5aHB2b29sZHJqdXF3aWh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5NzYxOTIsImV4cCI6MjEwOTU1MjE5Mn0.dKw-qv34QpyhHWWSqt2qZvjYvfArLyogtRo-rPFWM24'
    ),
    body := '{"action":"run"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);
