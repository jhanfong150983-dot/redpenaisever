-- VJ 判定冷凍表（2026-08-16 user 拍板）
-- 目的：作圖題判官在 temperature 0 下仍不可重現（實測 input_tokens 跨批次完全相同、
--       output 每輪都變），導致同一張卷每次重批分數不一樣。冷凍＝判過就存，重批直接沿用。
--
-- 鍵的設計：cache_key = sha1(學生圖 hash + 規準 hash + prompt 版本)
--   ・學生圖 hash：卷子重掃／bbox 變動 → 換一張圖 → 應重判
--   ・規準 hash  ：老師改規準 → 舊判定失效 → 應重判
--   ・prompt 版本：我們改判官邏輯（如三票、prompt 改寫）→ 舊判定不該綁死新版本
--   任一改變 → 鍵改變 → cache miss → 重判。這樣「凍結」與「不被舊版本綁死」同時成立。
--
-- source：'ai'＝判官判的；'teacher'＝老師在評分統計調整過（回寫）。
--   teacher 的優先權最高：重批時直接採用老師的分數，AI 不再覆蓋。
--   這是「人工才是最標準」在資料層的落實。

create table if not exists public.vj_verdict_cache (
  id            bigserial primary key,
  cache_key     text        not null,
  assignment_id text,
  submission_id text,
  question_id   text        not null,
  verdicts      jsonb       not null,          -- [{idx,label,verdict,reason}]
  score         numeric,
  max_score     numeric,
  vote_split    boolean     not null default false,
  source        text        not null default 'ai',   -- 'ai' | 'teacher'
  model         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint vj_verdict_cache_key_uniq unique (cache_key),
  constraint vj_verdict_cache_source_chk check (source in ('ai', 'teacher'))
);

-- 老師回寫時要用 submission_id + question_id 找回那一列
create index if not exists vj_verdict_cache_sub_q_idx
  on public.vj_verdict_cache (submission_id, question_id);

-- 清理舊資料用（作業刪除後）
create index if not exists vj_verdict_cache_assignment_idx
  on public.vj_verdict_cache (assignment_id);
