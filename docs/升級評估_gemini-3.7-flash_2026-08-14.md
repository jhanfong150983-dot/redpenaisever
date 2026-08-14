# Gemini 3.7 Flash 升級評估計畫（2026-08-14）

> 目的：盤點系統內**所有** AI call site，逐一判斷是否升級到 `gemini-3.7-flash`，並定出沙盒實驗的順序、樣本量、否決線。
> 原則沿用既有鐵律：①新規則上線前必跑全庫回放＋反向檢查 ②local 實驗必鏡像 production input ③判官類實驗 ≥10 卷、**首要否決線是「放水」不是「誤殺」** ④修法設計成單調（可 env 回退）。

---

## 0. 價格前提（官方 pricing 頁 2026-08-14 查證）

| Model | Input /1M | Output（含 thinking）/1M | 備註 |
|---|---|---|---|
| `gemini-2.5-flash` | $0.075 | $0.30 | 按**像素**計圖片 token |
| `gemini-3.5-flash` | $1.50 | $9.00 | 無促銷 |
| `gemini-3.6-flash` | **$0.75** → $1.50 | **$3.75** → $7.50 | 促銷至 2026-12-31 |
| `gemini-3.7-flash` | **$0.75** → $1.50 | **$3.75** → $7.50 | 促銷至 2026-12-31 |

Context caching：3.6/3.7 = $0.075/1M（促銷）＋$0.50/1M/hr storage；3.5 = $0.15＋$1.00/1M/hr。
Batch/Flex = 標準價 ×0.5；Priority = ×1.8。

**三個直接推論**

1. **3.6 → 3.7 現在與未來都同價** ⇒ 純品質決策，成本零風險。
2. **3.5（判官）→ 3.7 是省錢**：input −50%、output −58%（2027 後仍 output −17%）。判官是全系統最大成本線 → 這裡是本次升級的**主要財務動機**。
3. **2.5 → 3.7 是 10~12.5 倍漲價**。預設不動。

> ⚠️ **獨立於升級的發現**：3.6（現行 MODEL_PRO）目前也在促銷價，2027-01-01 起 3.6/3.7 單價一律翻倍。定價模型（題數級距扣點、地板 6 折毛利 ≥40%）需要另外算一版「2027 標準價」情境，否則明年 1/1 毛利被砍。此事**不因是否升級 3.7 而改變**。

---

## 1. 全部 AI call site 盤點與升級判斷

分層依據：[model-config.js](../server/ai/model-config.js) 的 `STAGE_MODEL` 表 ＋ 散在 [staged-grading.js](../server/ai/staged-grading.js) 的 `modelOverride`。

### A 層｜現行 `MODEL_PRO = gemini-3.6-flash`（升級零成本，只看品質）

| # | routeKey / call site | 用途 | 量級 | 升級判斷 | 實驗 |
|---|---|---|---|---|---|
| A1 | `grading.classify`＋`phase_a_classify`<br>[model-config.js:49-50](../server/ai/model-config.js#L49-L50) | Phase A1 切題 bbox | 每卷每頁 × K（多份8/少份5/單份3） | **測**（風險最高：錯一格全卷歪） | E1 |
| A2 | read 三層分流的 PRO 部分<br>[staged-grading.js:10189](../server/ai/staged-grading.js#L10189)、[:8740](../server/ai/staged-grading.js#L8740) | 國語全卷 read／check・ordering／英語數學 text | **量最大**（每生每題 ×2 讀） | **測** | E2 |
| A3 | focused read 系列 `modelOverride: MODEL_PRO`<br>[:10869](../server/ai/staged-grading.js#L10869)、[:10986](../server/ai/staged-grading.js#L10986)、[:11035](../server/ai/staged-grading.js#L11035)、[:11180](../server/ai/staged-grading.js#L11180)、[:11231](../server/ai/staged-grading.js#L11231)、[:11792](../server/ai/staged-grading.js#L11792) | 勾選格 focused／排序專用／第三讀／字跡兜底 | 中 | 跟 A2 同批（同性質） | E2 |
| A4 | `answer_key.extract`<br>[model-config.js:90](../server/ai/model-config.js#L90) | 答案卷題目辨識（含密集勾選、題型分類） | 每卷一次性 | **測**（錯了整卷全錯，但可人工修） | E4 |
| A5 | `answer_key.locate` | 答案卷 bbox 定位 | 每卷一次性 | 併 A4 | E4 |
| A6 | `grading.vj_rubric` / `vj_blank` / `vj_grade` | VJ 視覺判斷題三階段 | VJ 題才觸發 | **測**（3.x 以下已知不安全，不能降） | E4 |
| A7 | `grading.level_judge` | 級分制判官（讀手寫推導） | 數學應用題 | **測**（08-13 剛落地，有現成一致投票 GT） | E4 |
| A8 | `grading.recheck`＋`STUDENT_CORRECTION_MODEL`<br>[api/data/[action].js:115](../api/data/[action].js#L115) | 學生訂正重批（含 OCR） | 低 | 跟 A2 綁定（同 read 性質），不單獨測 | — |
| A9 | `report.question_error_features`、`report.kp_tagging`<br>[model-config.js:95](../server/ai/model-config.js#L95)、[:98](../server/ai/model-config.js#L98) | 開放題錯誤特徵、知識點歸類 | 每卷一次性 | **低優先**：純文字/圖判斷、目前品質已驗收，升級收益低 | E4（尾巴） |
| A10 | charerr 判官 pin PRO [:14534](../server/ai/staged-grading.js#L14534)、[:14971](../server/ai/staged-grading.js#L14971) | 用字錯誤判定 | 中 | **併入 E3 判官批**（性質是判官不是 read） | E3 |
| A11 | page-detection `model: MODEL_PRO`<br>[api/data/[action].js:69](../api/data/[action].js#L69)、[:8224](../api/data/[action].js#L8224)、[:8269](../api/data/[action].js#L8269) | 純 page 判定（無 bbox） | 低 | 跟 A1 綁定 | E1（附帶） |

### B 層｜現行 `JUDGE_MODEL = gemini-3.5-flash`（pin，升級=省錢）

| # | call site | 用途 | 升級判斷 |
|---|---|---|---|
| B1 | 判官家族 6 個 `modelOverride: JUDGE_MODEL`<br>[:13663](../server/ai/staged-grading.js#L13663)、[:13699](../server/ai/staged-grading.js#L13699)、[:13844](../server/ai/staged-grading.js#L13844)、[:14065](../server/ai/staged-grading.js#L14065)、[:14105](../server/ai/staged-grading.js#L14105)、[:14161](../server/ai/staged-grading.js#L14161)、[:14349](../server/ai/staged-grading.js#L14349) | 國字注音三判官、調號覆核、單選字跡兜底、VJ lazy 兜底 | **最高優先測**：這是最大成本線，且 3.7 單價比現行 3.5 低 50%/58% |

> ⚠️ 這批 2026-08-04 才因為 3.6 誤殺而 **pin 回 3.5**（3.6 丟零星 d 票被「一票殺」放大、兩輪自翻 3/29、格外作答判 blank）。3.7 必須**原樣重跑同一套 A/B**，不能因為「版本更新」就假設修好了。一票殺規則是在 3.5 的票行為上校準的（V11）。

### C 層｜現行 `MODEL_FLASH = gemini-2.5-flash`（升級=10~12.5 倍漲價）

| # | routeKey | 用途 | 升級判斷 |
|---|---|---|---|
| C1 | `grading.arbiter` / `phase_a_arbiter` / `consistency_judge` | Phase A3 一致性判官 | **不升**。已改確定性 `computeConsistencyStatus`，AI 路徑本來就縮了 |
| C2 | `grading.accessor` / `phase_b_accessor` / `grade_one` | Phase B 算分 | **不升**。純文字、temp 0、品質已整治 |
| C3 | `grading.explain` / `error_guidance` | 錯題解釋、on-demand 引導 | **不升**。純文字生成 |
| C4 | read 的 choice 家族（`cfg.model` 非 PRO）[:10189](../server/ai/staged-grading.js#L10189) | 其他科 single_choice 等 | **不升**（見下方反向評估 E5） |
| C5 | `perspective.detect_corners` | 紙張四角偵測 | **不升**。學生上傳量大、任務簡單 |
| C6 | `answer_key.reanalyze` / `tag_concepts`、`report.teacher_summary` / `domain_diagnosis` / `parent_comment` / `parent_diagnosis`、`admin.tag_aggregation` | 報表/標記類 | **不升**。純文字摘要，2.5 已驗收 |

C 層唯一值得**反向評估**的是 C4：2.5 讀不動密集勾選/字跡（已知病灶，靠 focused read 升 PRO 兜底）。若 3.7 能一次讀對而免掉整條升級鏈＋人工審查，10 倍單價未必虧 → 見 E5。

---

## 2. 升級前的硬性阻斷點（**不修完不准進沙盒量成本**）

| # | 位置 | 問題 | 修法 |
|---|---|---|---|
| ⛔ P1 | [model-adapter.js:246](../server/ai/model-adapter.js#L246) `supportsThinkingLevel = /3\.[56]-flash/i` | **3.7 不在白名單** → `thinking_level: MINIMAL` 被 strip → 退回 dynamic thinking。這正是 2026-07-22 切 3.6 當天踩過的坑（社會卷單次重批 NT$12、95% 是 thoughts） | 先探針確認 3.7 吃 MINIMAL（2.5 是 400），再把 regex 放寬成 `/3\.\d+-flash/` |
| ⛔ P2 | [admin/[action].js:3253](../api/admin/[action].js#L3253) `modelRates()` | 無 3.7 分支 → 落到 default `$1.50/$9.00`；**且 3.6 分支寫死 `$1.50/$7.50` 已過期**（實收 0.75/3.75）。費率權威在這裡 → 現在儀表板對 3.6 高估 2 倍 | 補 3.7 分支、修正 3.6 為促銷價、註記 2027-01-01 要改回 |
| ⚠️ P3 | [vertex-auth.js:54](../server/ai/vertex-auth.js#L54) | 3.x 只在 Vertex `global` endpoint 有。**3.7 是否已上 Vertex 未知** | 探針打一次 global endpoint；沒有的話 production（走 SA）無法升級，整案暫緩 |
| ⚠️ P4 | [staged-grading.js:64-68](../server/ai/staged-grading.js#L64-L68) `READ_MEDIA_RES`、[:776](../server/ai/staged-grading.js#L776) `sheetModelEligible` | regex 是 `/gemini-3/`、`/gemini-3\./` → 3.7 **會**命中（OK）。但整套 read 成本模型（合成圖、檔位 medium）建立在「3.x 每張圖固定 token 280/560/1120」上 | 探針量 3.7 的 `usageMetadata` 圖片 token，確認檔位仍固定且數值相同 |
| ⚠️ P5 | classify bbox 格式 | 已知 flash+thinking MINIMAL 會回 pixel bbox（現有自動 strip 邏輯） | 探針確認 3.7 回 normalized 0-1000 還是 pixel |
| ℹ️ P6 | [.env.example:14](../.env.example#L14)、env 白名單 [api/data/[action].js:3089](../api/data/[action].js#L3089) | `MODEL_PRO`/`MODEL_FLASH`/`JUDGE_MODEL` 已在白名單 | 無需改碼即可 env 切換／回退 ✅ |

---

## 3. 沙盒實驗設計

共用前提：
- 用 `SYSTEM_GEMINI_API_KEY`，實驗檔放 `local-only/exp-model37-2026-08-14/`
- **必鏡像 production input**：同 crop pipeline、同 `mediaResolution`、同 prompt、**同批次形狀**（8/10 教訓：單圖劣化 ≠ 批次劣化）
- GT 只挑「已人工確認過」的格，不用 AI 自己的輸出當 GT
- 每個實驗都要出「翻盤格清單」（不是只看總分/百分比）

### E0 — 探針（阻斷點驗證，~0.5h，全過才往下）

| 檢查 | 通過條件 |
|---|---|
| `thinking_level: MINIMAL` | HTTP 200 且 `thoughtsTokenCount = 0` |
| `mediaResolution` LOW/MEDIUM/HIGH | 三檔圖片 token 有明顯階梯、且與像素無關 |
| classify bbox 格式 | 記錄是 0-1000 還是 pixel |
| Vertex `global` endpoint | 200（404 ⇒ 整案暫緩，只能等） |
| `usageMetadata` 欄位 | prompt/candidates/thoughts/cached 齊全（計費依賴） |

**任一不過 → 停在這裡，寫結論、不進 E1。**

### E1 — classify（風險最高）

- 樣本：四模式矩陣 `wq/ao × photo/pdf` 各 3 卷，K 值照定案（多份 8／少份 5／單份 3）
- GT：production 現有最終 bbox（已人工確認的卷）
- 指標：① 整欄漂移率 ② 偷懶吐固定欄的發生率 ③ bbox IoU 中位 ④ peer-baseline 重跑觸發次數
- **否決線：任一模式的漂移率或偷懶率高於 3.6 即否決**（單調性——不接受「總體變好但某模式變差」）

### E2 — read（量最大）

- 範圍：只測現行走 3.6 的三層（國語全卷／check・ordering／英語・數學 text）
- 樣本：≥6 卷 × 3 輪，**production 同款批次呼叫**（8 圖一 call，不是單圖）
- 指標：① 與 GT 讀值一致率 ② 跨輪穩定率 ③ **英語標點保留率**（3-E-7「Yes, it is.」逗號專項）④ NR 率 ⑤ 國語「的→地」類系統性誤讀
- 否決線：任一項退步即否決；特別盯逗號/拼字（已有事故前科）

### E3 — 判官 3.5 → 3.7（錢最大，**最高優先**）

- 鏡像 `exp-judge-35v36` 的形狀，但樣本加大：**≥10 卷、≥150 個國字注音格 × 3 判官 × 2 輪**（8/08 教訓：3 卷 21 格不足以代表 production 分布）
- 一併測 A10 charerr 判官（同家族）
- 配置照 production：`JUDGE_HIGHRES_GENERATION_CONFIG`（鎖 HIGH）
- 指標：① **放水數（首要否決線）** ② 誤殺數 ③ 兩輪自翻數 ④ 2:1 分歧率 ⑤ 格外作答是否判 blank
- 判定：**逐格眼球裁決**，不看統計就下結論
- 否決線：放水 > 0 增量即否決（誤殺可走申訴、放水抓不到就是錯給分）
- 過關報酬：判官線單價 input −50%、output −58%

### E4 — 一次性 stage（extract / locate / VJ / level_judge / report）

- extract：8 卷答案卷回放，含密集勾選 A 大題 `multi_check`、克漏字逐詞、作圖題 parts/配分 clamp。指標＝題型分類正確率、題號 off-by-one、配分抽取正確率
- VJ：blank 偵測穩定度（真空白不可幻覺出筆跡）＋ grade 對錯，temp 0
- level_judge：直接餵 08-13 級分制沙盒那批（已有一致投票 GT），指標＝級分一致率、交老師比率
- report 類（A9）：低優先，最後跑，只看「有沒有變壞」

### E5 — 反向評估：2.5 → 3.7 值不值（只針對 C4）

- 假設：3.7 一次讀對密集勾選/字跡，可拔掉 focused read 第三讀＋部分升級鏈＋人工審查
- 算式：`(3.7 單價 × 一次讀) vs (2.5 單價 × 兩讀 + PRO 兜底 call + 審查人力)`
- 預設結論：不動。除非 E5 證明能**整段拔掉**升級鏈（省下的 call 數 > 12.5 倍單價差）

### E6 — 全庫回放 ＋ 反向檢查（上線閘門）

只有通過 E1~E4 的 stage 才進。跑全庫、產出「修好幾格 / **弄壞幾格**」對照表。弄壞 > 0 且非噪音 → 該 stage 退回。

---

## 4. 建議執行順序與判斷

| 順序 | 項目 | 動機 | 若過關的收益 |
|---|---|---|---|
| 1 | **P1 + P2 修補** | 阻斷點，且 P2 本身就是現在的帳單 bug（3.6 高估 2 倍） | 儀表板數字立刻變準 |
| 2 | **E0 探針** | 便宜、一票否決 | — |
| 3 | **E3 判官** | 錢最大、且 3.7 比現行 3.5 **便宜**，是唯一「品質不變也賺」的項目 | 系統最大成本線單價砍半 |
| 4 | **E2 read** | 量最大、同價換品質 | NR / 標點事故率下降 |
| 5 | **E1 classify** | 風險最高、同價換品質 | 漂移/偷懶下降 → 少一輪 retry |
| 6 | **E4 一次性 stage** | 量小、可人工修 | 邊際 |
| 7 | **E5 反向評估** | 預期否決，做完存檔 | 可能為零 |
| 8 | **E6 全庫回放** | 上線閘門 | — |

**灰度與回退**：全部靠 env，不改碼即可回退。
- A 層 → `MODEL_PRO=gemini-3.7-flash`（回退設回 `gemini-3.6-flash`）
- B 層 → `JUDGE_MODEL=gemini-3.7-flash`（回退設回 `gemini-3.5-flash`）
- 單題型灰度 → `TYPE_SPLIT_PRO_TYPES`
- 緊急全關 thinking → `THINKING_STRIP_ALL=1`

**逐 stage 上線，不要一次全切**（切 3.6 那次是全套一起切，事後才發現 thinking 白名單靜默失效）。

---

## 5. 待確認 / 未決

- 3.7 是否已上 Vertex `global` endpoint（E0 決定；沒有 ⇒ 整案暫緩）
- 3.7 的公開 benchmark 只有 coding/agentic 軸（DeepSWE 49.0→65.3、文件處理 22.0→34.0、AutomationBench 17.0→30.4），**沒有手寫 OCR / bbox 定位的數字** → 不能從 benchmark 推論我們在乎的軸，只能靠 E1/E2 實測
- 2027-01-01 促銷到期 → 定價模型需另開一版情境試算（與本升級案獨立）
