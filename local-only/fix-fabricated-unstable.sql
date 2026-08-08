-- 修正被捏造的 consistencyStatus='unstable'（2026-08-09）
--
-- 背景：useSync 反建 details 時，arbiterResult 缺失就一律填 'unstable'（已於 2026-08-08 修掉寫入端），
--   導致 24 個作業共 5,662 格明明兩讀完全相同卻標 unstable。消費端已改成單調判定、不再被騙，
--   所以這支 SQL 純粹是資料衛生：讓日後做分析的人（含 AI）不會再被這個欄位誤導。
--
-- 判準：readAnswer1.studentAnswer 與 readAnswer2.studentAnswer **字串完全相同** → 'unstable' 必為捏造。
--   刻意用嚴格字串相等（不做標點/空白折疊）＝最保守，只改毫無歧義的格子。
--   兩讀真的不同或缺值的 1,772 格一律不動。
--
-- ⚠ 刻意不更新 updated_at：避免 284 份卷（含大 JSONB）被觸發重新同步，而此修正對 UI 無影響
--   （消費端已不信任這個欄位）。client 端 Dexie 仍留舊值，無害。
-- ⚠ 可重複執行（第二次會 0 rows）。

-- ── 步驟 1：先跑這段預覽，確認數字是 5662 再往下 ──────────────────────────
SELECT count(*) AS cells_to_fix
FROM submissions s,
     jsonb_array_elements(s.grading_result -> 'details') AS d
WHERE jsonb_typeof(s.grading_result -> 'details') = 'array'
  AND d ->> 'consistencyStatus' = 'unstable'
  AND d -> 'readAnswer1' ->> 'studentAnswer' IS NOT NULL
  AND d -> 'readAnswer1' ->> 'studentAnswer' = d -> 'readAnswer2' ->> 'studentAnswer';


-- ── 步驟 2：確認數字無誤後，執行修正 ──────────────────────────────────────
UPDATE submissions s
SET grading_result = jsonb_set(
      s.grading_result,
      '{details}',
      (
        SELECT jsonb_agg(
                 CASE
                   WHEN d ->> 'consistencyStatus' = 'unstable'
                    AND d -> 'readAnswer1' ->> 'studentAnswer' IS NOT NULL
                    AND d -> 'readAnswer1' ->> 'studentAnswer' = d -> 'readAnswer2' ->> 'studentAnswer'
                   THEN jsonb_set(d, '{consistencyStatus}', '"stable"'::jsonb)
                   ELSE d
                 END
                 ORDER BY ord            -- 保持 details 原順序
               )
        FROM jsonb_array_elements(s.grading_result -> 'details') WITH ORDINALITY AS t(d, ord)
      )
    )
WHERE jsonb_typeof(s.grading_result -> 'details') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(s.grading_result -> 'details') AS d
    WHERE d ->> 'consistencyStatus' = 'unstable'
      AND d -> 'readAnswer1' ->> 'studentAnswer' IS NOT NULL
      AND d -> 'readAnswer1' ->> 'studentAnswer' = d -> 'readAnswer2' ->> 'studentAnswer'
  );


-- ── 步驟 3：驗收（應回 0）──────────────────────────────────────────────────
SELECT count(*) AS remaining
FROM submissions s,
     jsonb_array_elements(s.grading_result -> 'details') AS d
WHERE jsonb_typeof(s.grading_result -> 'details') = 'array'
  AND d ->> 'consistencyStatus' = 'unstable'
  AND d -> 'readAnswer1' ->> 'studentAnswer' IS NOT NULL
  AND d -> 'readAnswer1' ->> 'studentAnswer' = d -> 'readAnswer2' ->> 'studentAnswer';
