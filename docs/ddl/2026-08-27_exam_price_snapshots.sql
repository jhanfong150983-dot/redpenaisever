-- 菜單制計價快照（2026-08-27 user 拍板「扣款改菜單公式」）
-- 首次扣款時凍結每份點數：之後答案卷修改、菜單調價都不影響已定價的卷（同卷同價）。
-- 老師的價格承諾以此表為準；exam-pricing.js fail-open——表不存在時現算不凍結。
create table if not exists public.exam_price_snapshots (
  assignment_id    text primary key,
  points_per_sheet integer not null check (points_per_sheet >= 1),
  pricing_version  text not null,
  class_size       integer,
  breakdown        jsonb,
  created_at       timestamptz not null default now()
);
