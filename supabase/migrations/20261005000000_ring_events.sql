-- Ring webhook 事件表 + 快照存储桶
-- 在 Supabase SQL Editor 执行，或作为 migration 提交

create table if not exists public.ring_events (
  id uuid primary key default gen_random_uuid(),
  ring_event_id text not null unique,      -- Ring 事件 ID（幂等去重）
  event_type text not null,               -- motion_detected | button_press | ...
  device_id text not null,
  sub_type text,                           -- 如 motion 的 human 子类型
  occurred_at timestamptz not null,
  snapshot_path text,                      -- storage 路径（无快照时为 null）
  ai_label text,                           -- analyze-snapshot 回填：person/package/pet/vehicle/none
  ai_confidence numeric,
  raw jsonb not null,                      -- 原始 webhook 负载（未知结构也不丢）
  created_at timestamptz not null default now()
);

create index if not exists ring_events_device_time
  on public.ring_events (device_id, occurred_at desc);
create index if not exists ring_events_type_time
  on public.ring_events (event_type, occurred_at desc);

-- 快照存储桶（私有；Dashboard 通过签名 URL 读取）
insert into storage.buckets (id, name, public)
values ('ring-snapshots', 'ring-snapshots', false)
on conflict (id) do nothing;
