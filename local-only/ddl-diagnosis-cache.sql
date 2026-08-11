-- 家長報告錯因診斷快取(2026-08-11、user 拍板 B 案:獨立表、不併入 semantic_score_tables)
-- 「同答同診斷」:錯因取決於寫了什麼、不取決於是誰寫的 → 按值快取
-- 三種鍵形態(kind):
--   text  = 文字題:key = 正規化讀值
--   choice= 選擇/勾選:key = canonical 選項值
--   image = 圖像判分(注音等):key = 判官理由文字(公式化、同理由=同迷思)
-- 生命週期:與分數表分離——答案卷變分數表作廢,但錯因解釋通常仍有效;
--   only 答案卷「題目本身」變更才作廢(scope_key 換 or 手動清)。
-- ⚠️ 照慣例:先跑本 DDL、再 push client/server 程式(fail-open:查無快取→照現行逐生呼叫)
create table if not exists public.parent_diagnosis_cache (
  id            bigint generated always as identity primary key,
  scope_key     text        not null,          -- answer_key_template_id 或 assignment_id
  question_id   text        not null,
  kind          text        not null check (kind in ('text','choice','image')),
  value_key     text        not null,          -- 正規化讀值 / 選項值 / 判官理由
  why           text        not null,          -- 🧠 為什麼會這樣
  suggest       text        not null,          -- 💡 在家可以
  model         text,
  created_at    timestamptz not null default now(),
  unique (scope_key, question_id, kind, value_key)
);

create index if not exists idx_pdc_scope on public.parent_diagnosis_cache (scope_key, question_id);

alter table public.parent_diagnosis_cache enable row level security;
-- 不建 policy = service_role only;client 經既有 proxy/API 讀寫

-- 驗收:select count(*) from parent_diagnosis_cache; → 0
