-- 2026-08-03 sync 瘦身:把 submissions 的三個大 JSONB 移出同步,改 on-demand。
--
-- 背景:單份 submission 42KB,其中 phase_a_state 21KB + grading_result 19KB + final_answers 2KB,
--   真正天天要用的欄位(分數/狀態/時間)只有 1KB。行政端全校一次考卷 2200 份 → 首次 sync 90MB。
--
-- 但有兩處輕量判斷原本是從大 JSONB 裡讀的,拔掉後會壞:
--   ① AssignmentList 的已批改計數:`sub.status === 'graded' || sub.gradingResult`
--      (實測全表 2930 份中,有 grading_result 但 status≠graded 的有 26 份,不能只看 status)
--   ② isPhaseAStale:比 `phase_a_state.savedAt` 與 gradedAt,判斷 Phase A 是否比 Phase B 新
--
-- → 用 generated column 把這兩個值提成頂層純量,幾十 bytes 就能取代 40KB 的傳輸。
--   generated always as ... stored 由 PG 自動維護,不需要應用層同步,也不會漏更新。

alter table submissions
  add column if not exists has_grading_result boolean
  generated always as (grading_result is not null) stored;

alter table submissions
  add column if not exists phase_a_saved_at text
  generated always as (phase_a_state ->> 'savedAt') stored;

-- ③ 首頁作業總覽的錯題數 fallback(App.tsx:1434)。
--    改用投影 grading_result->mistakes 的話,實測平均 547 bytes/份 → 2200 份還要 1.1MB;
--    存成整數只要 4 bytes。
alter table submissions
  add column if not exists mistakes_count integer
  generated always as (
    case when jsonb_typeof(grading_result -> 'mistakes') = 'array'
         then jsonb_array_length(grading_result -> 'mistakes')
         else null end
  ) stored;

-- 驗證(跑完應該看到 has_grading_result=true 約 2436 筆、phase_a_saved_at 是 ISO 字串)
-- select count(*) filter (where has_grading_result) as with_gr,
--        count(*) filter (where phase_a_saved_at is not null) as with_pa,
--        count(*) as total
-- from submissions;
