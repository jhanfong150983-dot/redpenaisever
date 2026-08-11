-- 答案卷模板血緣（2026-08-11、教師分散批改+學校匯集 前置①：跨班公平性）
-- 背景：分享碼匯入=「複製新 id」不是連結 → 跨 owner 的 semantic_score_tables scope_key 對不上、
--   同答案在不同老師班上可能不同分。加血緣根鍵：匯入時記 source_template_id=來源的根
--   （鏈式傳遞：來源自己也是複製品就沿用它的根），查表 scope 一律解析到根 → 全校同卷共一張表。
-- 既有資料：同 owner 跨班本來就共用同一個 template id（根=自己），不需遷移；
--   歷史上已被匯入的複製品無法回溯血緣（來源未記錄），維持各自獨立。
-- ⚠️ 慣例：先跑本 DDL 再 push（server 端已寫 fail-open：欄位不存在→退回原行為，不會壞匯入/批改）
alter table public.answer_key_templates add column if not exists source_template_id text;
create index if not exists idx_akt_source on public.answer_key_templates (source_template_id);

-- 驗收：select column_name from information_schema.columns
--   where table_name='answer_key_templates' and column_name='source_template_id'; → 1 列
