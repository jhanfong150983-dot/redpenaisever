-- 2026-07-22 緊急修正：graded_fp 型別 bigint → text。
--   8ee4ed9 把指紋格式改成 `${graded_at}|${score}`（抓老師手動改分）——但只改了程式、沒改欄位型別，
--   Postgres 對「2026-07-21T…|49」報 invalid input syntax for bigint → 每次 upsert 都 500、
--   client 又靜默吞掉 → A班國語 31 位 × 兩輪的 AI 診斷全部白跑（重新整理即消失、表內 0 筆）。
--   既有 B班數學 32 筆 bigint 值轉 text 後不會 match 新格式 → 一次性失效、重生即回新格式（可接受）。
alter table public.parent_reports
  alter column graded_fp type text using graded_fp::text;
