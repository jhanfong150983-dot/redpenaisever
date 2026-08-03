-- 2026-08-03 清除訊號的墓碑欄位(解今天發現的結構問題)
--
-- 問題:sync 合併是 local-first(`local?.gradingResult ?? serverGradingResult`),
--   server 把批改清成 null 之後,那個 null 會被本機舊值接住 → 清除對「已經有資料的裝置」完全無效。
--   同一台裝置可以靠「動作當下順手清本機」繞過,但 A 裝置清、B 裝置永遠不知道。
--
-- 解法:server 每次清除時蓋一個時間戳。client 比對「server 的清除時間」與「本機已知的清除時間」,
--   發現 server 比較新就把本機的批改欄位一起清掉。
--   為什麼用時間戳而不是布林:布林無法分辨「清過一次」與「又清了一次」,
--   重批之後再清第二次時布林已經是 true,client 不會有任何反應。

alter table submissions add column if not exists grading_cleared_at timestamptz;

-- 驗證(現在應該全為 NULL;之後每次換答案卷/重跑清除會被蓋上)
-- select count(*) filter (where grading_cleared_at is not null) as cleared, count(*) as total from submissions;
