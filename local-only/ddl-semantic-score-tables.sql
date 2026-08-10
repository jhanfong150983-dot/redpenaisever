-- 值→分數表(查表制)資料層(2026-08-11、user 拍板的完整設計)
-- 設計:同答同分同理由;懶建表(逐卷批改中增量凍結);掛 answer_key_template 層跨班共用
-- ⚠️ 照慣例:先跑本 DDL、再 push server 程式(程式端 fail-open)
--
-- scope_key = assignment.answer_key_template_id(有 template)或 assignment_id(無)
-- verdict:unanimous=兩票全同 / majority=2:1 多數決 / split_max=三票全歧取最高(user 拍板、帶低信心)
create table if not exists public.semantic_score_tables (
  id            bigint generated always as identity primary key,
  scope_key     text        not null,
  question_id   text        not null,
  value_norm    text        not null,             -- 正規化讀值(全半形/空白/頭尾標點折疊、一字不折)
  value_raw     text,                              -- 首見原文(顯示用)
  score         numeric     not null,
  max_score     numeric,
  rubric_scores jsonb,                             -- [{dimension,score,maxScore,reason}] 同答同理由的來源
  char_err      jsonb,                             -- 國語錯字覆核快取 {count,which}(語意分之外的扣分層)
  votes         jsonb,                             -- 投票記錄 e.g. [2,2] / [2,1,1] / [2,1,0]
  verdict       text        check (verdict in ('unanimous','majority','split_max')),
  low_conf      boolean     not null default false, -- split_max 一律 true;檢討單掛「⚠核對」
  model         text,
  config        jsonb,                             -- 建表當下的 env 指紋
  created_at    timestamptz not null default now(),
  unique (scope_key, question_id, value_norm)      -- 併發凍結:upsert-ignore、輸的重讀
);

create index if not exists idx_sst_scope on public.semantic_score_tables (scope_key, question_id);

alter table public.semantic_score_tables enable row level security;
-- 不建 policy = 只有 service_role 可讀寫(server 端批改管線用;不進 client sync)

-- 驗收:select count(*) from semantic_score_tables; → 0
