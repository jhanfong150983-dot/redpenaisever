-- 2026-08-04 固定扣除計費:冪等標記欄位
--
-- charged_graded_at 記「已為哪一次 graded_at 收過費」:
--   同輪重存(graded_at 沒變)→ 不重扣;重批(graded_at 變新)→ 再扣一次。
--   人工改分不動 graded_at 計費語意(scoreSource='manual' 在 handler 層就排除)。
-- graded_at 在系統中是 ms 時間戳(bigint),此欄同型別。

alter table submissions add column if not exists charged_graded_at bigint;

-- 驗證(現在應全為 NULL;FLAT_BILLING=1 啟用後每輪 AI 完成會蓋上)
-- select count(*) filter (where charged_graded_at is not null) as charged, count(*) from submissions;
