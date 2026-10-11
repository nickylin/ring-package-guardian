-- Dashboard 只读 RLS：静态看板用 anon key 读事件与告警
-- 快照图仍走 snapshot-url Edge Function 的签名 URL（桶保持私有）

create table if not exists public.ring_alerts (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  alert_type text not null,   -- package_arrived | package_removed | night_activity
  ring_event_id text,
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists ring_alerts_created
  on public.ring_alerts (created_at desc);

alter table public.ring_events enable row level security;
alter table public.ring_alerts enable row level security;

drop policy if exists "dashboard read events" on public.ring_events;
create policy "dashboard read events"
  on public.ring_events for select
  to anon
  using (true);

drop policy if exists "dashboard read alerts" on public.ring_alerts;
create policy "dashboard read alerts"
  on public.ring_alerts for select
  to anon
  using (true);
