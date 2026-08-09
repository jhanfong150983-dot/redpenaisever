-- 批改品質 dashboard 資料層(2026-08-10、user 拍板的 A/B/C 模型)
-- A=單輪健康度(從 grading_result 現算) B=跨輪一致性(需歷史→本表) C=不一致格眼球裁決(verdicts 表)
--
-- 設計要點:
-- - 重批會覆蓋 grading_result/phase_a_state → 跨輪比較的唯一資料來源就是本表
-- - 不進 client sync(admin server-side 查),避免 sync 瘦身踩雷
-- - 每卷保留最近 5 輪(server 端寫入時汰舊)
-- - RLS 開啟但不建 policy = 只有 service_role 可讀寫(admin API 經 proxy)
--
-- ⚠️ 照慣例:先跑本 DDL、再 push server 程式(程式端 fail-open,先 push 也不會壞,只是不記錄)

-- ── 每輪逐格快照 ─────────────────────────────────────────────
create table if not exists public.grading_run_history (
  id            bigint generated always as identity primary key,
  submission_id text        not null,
  assignment_id text        not null,
  owner_id      uuid,
  graded_at     bigint      not null,             -- ms epoch、= submissions.graded_at(輪的身分)
  graded_by     text,                              -- 'teacher' | 'student'
  total_score   numeric,
  git_sha       text,                              -- VERCEL_GIT_COMMIT_SHA 前 7 碼
  config        jsonb,                             -- 關鍵 env 指紋(同組態判別用——跨組態的翻盤≠變異)
  cells         jsonb       not null,              -- 逐格陣列,格式見 server historyCellOf()
  created_at    timestamptz not null default now()
);

create index if not exists idx_grh_submission on public.grading_run_history (submission_id, graded_at desc);
create index if not exists idx_grh_assignment on public.grading_run_history (assignment_id, created_at desc);

alter table public.grading_run_history enable row level security;

-- ── admin 眼球裁決(C 層,累積誤殺/放水統計 = L4 資料來源)──────────
create table if not exists public.grading_run_verdicts (
  id              bigint generated always as identity primary key,
  submission_id   text   not null,
  assignment_id   text   not null,
  question_id     text   not null,
  run_a_graded_at bigint not null,                 -- 較早輪
  run_b_graded_at bigint not null,                 -- 較晚輪
  verdict         text   not null check (verdict in ('a_correct','b_correct','both_correct','both_wrong','unclear')),
  note            text,
  created_at      timestamptz not null default now(),
  unique (submission_id, question_id, run_a_graded_at, run_b_graded_at)
);

create index if not exists idx_grv_assignment on public.grading_run_verdicts (assignment_id, created_at desc);

alter table public.grading_run_verdicts enable row level security;

-- ── 驗收 ──
-- select count(*) from grading_run_history;   → 0(空表建立成功)
-- select count(*) from grading_run_verdicts;  → 0
