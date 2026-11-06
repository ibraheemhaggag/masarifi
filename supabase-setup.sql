-- Masarifi: one private ledger per user
create table if not exists public.ledgers (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.ledgers enable row level security;
create policy "read own ledger"   on public.ledgers for select to authenticated using (auth.uid() = user_id);
create policy "insert own ledger" on public.ledgers for insert to authenticated with check (auth.uid() = user_id);
create policy "update own ledger" on public.ledgers for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own ledger" on public.ledgers for delete to authenticated using (auth.uid() = user_id);
revoke all on public.ledgers from anon;
grant select, insert, update, delete on public.ledgers to authenticated;
