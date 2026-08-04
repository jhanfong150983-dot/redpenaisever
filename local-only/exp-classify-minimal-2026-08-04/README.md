# classify thinking 降本沙盒(2026-08-04)— 判決:不可降,thinking 是 classify 的品質必需品

**目標**:classify 佔批改成本 75%、其中 thinking 佔 58%。驗證能否在品質不變下關掉/限制 thinking。

**Fixture**:行政英語TEST 五年3班 座1(`1785430466309-pjibhofgt`、3 頁 PDF 合併圖、48 題)。
GT = production `phase_a_state.classifyResult.alignedQuestions`(統一框後、user 已驗證 81 分正確)。
判準 = FocusRepair 同款幾何(x 重疊 ≥50% 且列 y 差 ≤0.015)。第 1 頁 22 題。

## 各臂結果(model=gemini-3.6-flash、鏡像 production prompt/全圖)

| 臂 | thoughts | 命中(對 GT) | 現象 |
|---|---|---|---|
| A dynamic ×5 | 6~12K | 12/9/5/0/0 | 3/5 次框架正確;2/5 次整頁漂移(已知老毛病、production 靠 K-median+peer-rerun 吸收) |
| B MINIMAL ×5 | 0 | **0/0/0/0/0** | 5/5 把第 1 頁攤到 y 0.12~0.51(跨進第 2 頁)——彼此一致、但框架全錯 |
| B' MINIMAL+明確頁界 ×3 | 0 | 0/0/0 | 頁界寫進 prompt 也救不回;**B'3 直接吐 pixel 座標**(五月雷重現) |
| C budget=1024+頁界 ×2 | **6~7K(未被限制)** | 3/0 | 3.6-flash **無視 thinkingBudget 整數上限** |
| C budget=512+頁界 ×1 | 0 | 0 | 塌縮成 MINIMAL 行為 + pixel 座標 |

## 結論
1. **3.6-flash 的 classify 必須保留 dynamic thinking**——多頁合併圖的頁面框架推斷就發生在 thinking 裡,
   關掉(MINIMAL / budget≤512)= 框架系統性全錯 + 偶發 pixel 座標;budget=1024 被靜默忽略、省不到。
2. 五月「classify 不帶 thinkingConfig」的決策是對的,本次以 GT 對照坐實。
3. **classify 的降本槓桿不是 thinking、是「少呼叫」**=統一框範本(已存在;2026-08-03 修了借用邏輯
   挑 sampleCount 最高)。範本命中 → classify 全跳過 → 英語每份 NT$5.1、達標。
4. read 線(re_read/detail_read)的 MINIMAL 早已生效(thoughts=0),不需再動。

## 過程教訓
- 首輪 fixture 拿錯卷(陳楷勛未批改卷、無 GT)白花 NT$24 → 加了「GT 空即中止」保險。
- 沙盒總花費 ≈ NT$70。

原始資料:`result.json`(單發探針)、`run5-result.json`(5×5 對 GT)、`boundary-result.json`、`budget-result.json`。
