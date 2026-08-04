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

## 國語驗證(2026-08-04 續、user:國語是讀圖大宗必須先驗)
Fixture:國語定期評量 ao_pdf(零 pad 直裁、無紅框、全 PRO)、50 可讀題(跳過國字注音 10)、
GT=判官驗收過的 arbiterDecisions。

| 檔位 | 輪 | 結果 |
|---|---|---|
| HIGH | 3 | 50/50 ×3 |
| **MEDIUM** | **5** | **50/50 ×5** ✅ |
| LOW | 6 | 4 輪全對;**2 輪出錯:「的→地」×2(同一題)、掉句號 ×1** |

**LOW 在國語不可用**:的/地正是「用字錯誤 A 類」判分點,而且兩讀都跑 LOW 時錯誤相關、
升級鏈救不到——同一題重複出錯=該筆跡在 LOW 降採樣下處於邊緣可讀性,系統性風險。

## 最終建議:全域 READ_MEDIA_RES=medium
- 國語 read 單趟 NT$3.35→1.95(-42%)、英語 2.11→~1.28(-39%)
- 英語每份(範本命中)≈ NT$3.2、國語 read 段等比下降——目標 5 元全科達標
- MEDIUM 品質證據:國語 5/5 全對;英語 MEDIUM 三頁各 1 輪同 HIGH,且 LOW(更低檔)都過英語
  → 單調性保證 MEDIUM ≥ LOW。不做 per-domain 分流(英語 LOW 再省 NT$0.8/份,不值得加管線複雜度)。
沙盒花費:國語段 ≈ NT$28;三個成本沙盒累計 ≈ NT$115。
