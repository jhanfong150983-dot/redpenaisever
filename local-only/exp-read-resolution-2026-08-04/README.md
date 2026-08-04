# read 圖片解析度檔位降本沙盒(2026-08-04)— 判決:LOW 可用,read 線 -57%

**發現路徑**:classify 以外的成本 73% 是圖片 input。原以為是裁圖太大,實測裁圖只有 ~330px 寬
——真正原因是 **Gemini 3.x 對「每張圖」收固定 token**(HIGH≈1120 / MEDIUM≈560 / LOW≈280),
與像素大小無關,預設 HIGH。縮像素無效(三檔 token 一模一樣),`generationConfig.mediaResolution` 才是旋鈕。

**Fixture**:行政英語TEST 座1(81 分、GT=phase_a_state.arbiterDecisions.finalAnswer)。
鏡像 production:cropWithMarkByBbox(0.012, 0.048/3)、tsReadHead review 角色 prompt、
family 分組/批次/model 分流(3.6/2.5)、temp 0、MINIMAL。

## 結果(全卷 48 題 × 每檔 3 輪)

| 頁 | 題型 | HIGH | LOW |
|---|---|---|---|
| 1(22 題) | multi_check/single_check/ordering | 22/22 ×3 | 22/22 ×3 |
| 2(18 題) | single_choice/fill_blank | 18/18 ×3 | 18/18 ×3 |
| 3(8 題) | single_choice/fill_blank | 7/8, 8/8, 7/8 | 7/8 ×3 |

第 3 頁唯一搖擺題 3-E-6=學生拼錯的「siventy」——**HIGH 自己 3 輪也錯 2 輪**,
屬既有難字噪音、非解析度退步;production 對兩讀不一致本來就走升級鏈,最終值即來自鏈。

**成本**:read 單趟(48 題)NT$2.11 → **NT$0.91(-57%)**;圖 token 37K → 12.6K(-66%)。

## 落地
- `READ_MEDIA_RES=low|medium|high`(staged-grading READ_ANSWER_GENERATION_CONFIG),**未設=不帶=現狀**。
- model-adapter:非 Gemini 3.x 或 503 fallback 一律 strip mediaResolution(2.5 不支援)。
- 覆蓋面:detail_read/re_read/升級鏈重讀全部走同一個 config,一處生效。

## ⚠ 啟用前提
- 英語 wq_pdf 已驗;**國語未驗**(注音調號/字形是小目標,LOW 降採樣風險最高)。
  有國語新卷時先跑同款沙盒再開。
- 沙盒花費 ≈ NT$16。原始資料:result-*.json。
