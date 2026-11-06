-- Masarifi v3: security hardening (safe to run more than once)

-- 1) Ledgers: must be a JSON object, capped at ~1 MB per user
alter table public.ledgers drop constraint if exists ledgers_data_shape;
alter table public.ledgers add constraint ledgers_data_shape
  check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 1000000);

-- 2) Push devices: only real browser push services, bounded fields
alter table public.push_subscriptions drop constraint if exists push_endpoint_allowed;
alter table public.push_subscriptions add constraint push_endpoint_allowed check (
  length(endpoint) < 1024 and
  endpoint ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/'
);
alter table public.push_subscriptions drop constraint if exists push_fields_bounded;
alter table public.push_subscriptions add constraint push_fields_bounded check (
  lang in ('ar','en','de') and length(tz) < 64 and pg_column_size(subscription) < 4096
  and subscription->>'endpoint' = endpoint
  and length(coalesce(subscription->'keys'->>'p256dh','')) between 40 and 200
  and length(coalesce(subscription->'keys'->>'auth','')) between 10 and 100
);

-- at most 10 devices per user
create or replace function public.push_limit_per_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.push_subscriptions where user_id = new.user_id and endpoint <> new.endpoint) >= 10 then
    raise exception 'too many devices';
  end if;
  return new;
end; $$;
drop trigger if exists push_limit on public.push_subscriptions;
create trigger push_limit before insert on public.push_subscriptions
  for each row execute function public.push_limit_per_user();
revoke all on function public.push_limit_per_user() from public, anon, authenticated;

-- 3) Users can never change who owns a row
create or replace function public.lock_owner()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.user_id <> old.user_id then raise exception 'owner cannot change'; end if;
  return new;
end; $$;
drop trigger if exists ledgers_lock_owner on public.ledgers;
create trigger ledgers_lock_owner before update on public.ledgers for each row execute function public.lock_owner();
drop trigger if exists push_lock_owner on public.push_subscriptions;
create trigger push_lock_owner before update on public.push_subscriptions for each row execute function public.lock_owner();
revoke all on function public.lock_owner() from public, anon, authenticated;

-- 4) Row Level Security applies even to the table owner
alter table public.ledgers force row level security;
alter table public.push_subscriptions force row level security;
alter table public.push_config force row level security;
alter table public.push_log force row level security;

-- 5) Nothing in the public schema is callable by anonymous visitors
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke execute on functions from anon;
grant execute on function public.delete_my_account() to authenticated;
