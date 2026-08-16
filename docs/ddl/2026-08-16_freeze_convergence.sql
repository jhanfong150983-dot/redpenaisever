-- 判定冷凍機制收斂（2026-08-16 user 拍板）
-- 背景：系統裡有兩套「AI 判過就存起來」的機制，行為卻不一致——
--   ・semantic_score_tables（國語短答查表制）：鍵無版本、老師改分不回寫
--   ・vj_verdict_cache（作圖題冷凍，今天新增）：鍵含版本、老師裁決回寫
-- 收斂原則（三條，兩表一致）：
--   ① 鍵含「判定邏輯版本」→ 改判分邏輯即自動失效重判，不會被舊版本綁死
--   ② source='teacher' 為最高優先，AI 永不覆蓋 → 老師裁決是最終事實
--   ③ 低信心旗標隨判定一起存 → 重批沿用時仍會送複核
--
-- ⚠ 執行後果：logic_version 預設 'v0'、新程式寫入用新版本號 → **既有 78 列全部失效**，
--   下次重批會重新判分。這是刻意的（那些列是舊邏輯判的），但你要知道會發生。

-- ① 判定邏輯版本：進唯一鍵
alter table public.semantic_score_tables
  add column if not exists logic_version text not null default 'v0';

-- ② 來源：ai / teacher（老師裁決保護）
alter table public.semantic_score_tables
  add column if not exists source text not null default 'ai';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'semantic_score_tables_source_chk'
  ) then
    alter table public.semantic_score_tables
      add constraint semantic_score_tables_source_chk check (source in ('ai', 'teacher'));
  end if;
end $$;

-- ③ 唯一鍵改為含版本（原本 scope_key + question_id + value_norm）
--    先移除舊約束（名稱可能因建立方式而異，兩種都試）
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.semantic_score_tables'::regclass
      and contype = 'u'
  loop
    execute format('alter table public.semantic_score_tables drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.semantic_score_tables
  add constraint semantic_score_tables_key_uniq
  unique (scope_key, question_id, value_norm, logic_version);

-- 老師回寫時用 scope + 題號 + 值 找回（跨版本一起標記）
create index if not exists semantic_score_tables_scope_q_val_idx
  on public.semantic_score_tables (scope_key, question_id, value_norm);
