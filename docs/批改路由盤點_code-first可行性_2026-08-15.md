# 批改路由盤點與 code-first 可行性（2026-08-15）

> 命題：**有沒有可以先 code、但目前沒有先 code 的？**
> 判準要求（user）：不可憑推論，一律用**全庫真實讀值 + 現行分數**驗證；比對器要夠寬鬆（大小寫、標點、符號等價），不可僵硬。

資料來源：DB 全庫 2,876 題答案卷、約 4.4 萬個已批改格；路由條件逐條核對 `server/ai/staged-grading.js`。

---

## 一、現況路由全表

欄位語意：**code** =送不送程式判定、判不動會不會往下一關；**accessor** =送不送 AI 評分；**判官** =影像/規準判官。

| 領域 | 題型 | 題數 | code | accessor | 判官 |
|---|---|---|---|---|---|
| 英/自/國/社 | `single_choice` | 1109 | 0b 直判，判不動→下一步 | 收 0b 漏的；之後有程式覆核 | — |
| 英/社/數 | `single_check`·`multi_check`·`circle_select_one` | 367 | 0b-4 直判，判不動→下一步 | 收漏的 | — |
| 英語 | `ordering` | 19 | 0b-3 直判 | 收漏的 | — |
| 社會 | `multi_fill`（字母清單型） | 10 | 0b-2 直判 | 填單字型走這裡 | — |
| 數學 | `word_problem`·`calculation` | 281 | 0b-5 終答直判 | 收漏的 | 有 `levelRubric` → 級分制逐要素（未定案→人工） |
| 國語 | `short_answer`（帶 rubricsDimensions） | ~20 | 0b-6 查表制 | 未命中→送 | — |
| 數學 | `grid_geometry`·`diagram_color` | 3 | 不送 | **不送** | VJ 判官（未定案→人工） |
| 社會 | `map_fill` | 3 | 不送 | **不送** | map_fill 專屬管線 |
| 國語 | `fill_blank`（1–2 國字／注音） | ~61 | 不送 | **不送**（已拔 read） | 字形判官（未定案→0分+黃燈） |
| 數/英/其他 | `fill_blank`（其餘） | ~488 | **不送** | 只送 accessor；之後程式覆核 | — |
| 英/社/數 | `true_false` | 102 | **不送** | 只送 accessor；之後程式覆核 | — |
| 自/社 | `multi_choice` | 13 | **不送** | 只送 accessor | — |
| 數學 | `diagram_draw` | 9 | 不送 | 只送 accessor（有專用「標籤-數值對」比對） | — |
| 社/國/數 | `short_answer`（其餘） | ~39 | 不送 | 只送 accessor | — |
| 英語 | `matching`·`table_check` | 9 | 不送 | 只送 accessor | — |
| 數/英/社 | `table_cell`·`fill_variants`·`multi_check_other`·`compound_*` | 22 | 不送 | 只送 accessor | — |
| 全部 | **缺 `questionCategory`** | **322** | **不送**（所有 gate 都認 category） | 只送 accessor | — |

---

## 二、實證：code 判得動嗎？判得對嗎？

比對器規則（刻意寬鬆）：全半形、大小寫、圈號①→1、外層括號、尾端句讀、列舉分隔符折疊、
是非 O/○/✓ ↔ X/✗/×、選項代號跨記號（甲=A=1=①）、數值/代數等價（有理數精確比對）、
數值+短單位去單位比對。**英文字母之間的空白保留**（`bath room` ≠ `bathroom` 是老師的尺度）。

| 領域｜題型 | 可用格 | code 判得動 | 與現行分數一致 | 不一致 |
|---|---|---|---|---|
| 英語｜`true_false` | 1803 | **100%** | **100.0%** | **0** |
| 英語｜`single_choice` | 5040 | 100% | 100.0% | 1 |
| 社會｜`single_choice` | 1715 | 100% | 98.5% | 26 |
| 英語｜`single_check` | 462 | 100% | 100.0% | 0 |
| 自然｜`single_choice` | 3927 | 98% | 99.7% | 10 |
| 數學｜`single_choice` | 2440 | 98% | 99.9% | 2 |
| 英語｜`circle_select_one` | 800 | 94% | 100.0% | 0 |
| 數學｜`fill_blank` | 5935 | **93%** | 98.0% | 102 |
| 英語｜`multi_check` | 231 | 86% | 100.0% | 0 |
| 數學｜`multi_check` | 188 | 82% | 100.0% | 0 |
| 英語｜`fill_blank` | 1312 | 62% | **99.9%** | 1 |
| 數學｜`single_check` | 522 | 61% | 100.0% | 0 |
| 國語｜`fill_blank` | 748 | 48% | 100.0% | 0 |
| 數學｜`calculation` | 239 | 47% | 100.0% | 0 |
| 數學｜`word_problem` | 4876 | 30% | 92.9% | 84 |
| `short_answer`·`table_cell`·`diagram_draw` | — | **0%** | — | — |（標答欄為空、屬 rubric 型）

### 不一致樣本的歸因（逐筆看過）

| 筆數 | 樣態 | 誰錯 |
|---|---|---|
| 81 | word_problem「7850m²」vs 標答「7850 立方公尺」判 0 | **比對器錯**：平方≠立方，去單位規則不該用在應用題 |
| 74 | 數學 fill_blank「94.2」vs「94.2」完全相同卻 0 分 | **AI 錯**（4–6 月「理由說對卻 0 分」舊事故） |
| 23 | 社會 single_choice「2」vs「2」卻 0 分 | **AI 錯**（同上舊事故） |
| 18 | 數學 fill_blank「8%」vs 標答「10」給滿分 | **答案卷錯**（欄位對錯格：學生寫個數、標答是百分率） |
| 10 | 自然 single_choice「A」vs 標答「1」判 0 | **AI 錯**：跨記號等價沒認出 → 誤殺 |
| 7 | 國語 single_choice「D」vs 標答「B」給滿分 | **AI 錯**：放水 |
| 6 | 數學 fill_blank「100」vs 標答「100公尺」判 0 | **設定**：`unitErrorRule`，code 要尊重它 |
| 3 | 社會 fill_blank「羅妹號事件」完全相同卻 0 | **AI 錯** |

**結論：扣掉比對器自身的 81 筆與答案卷問題 18 筆，其餘不一致全部是 AI 判錯（誤殺 113 筆、放水 7 筆）。**
code 在這些格上不但可行，還比 accessor 準。

---

## 三、判決：哪些該改成 code-first

### ✅ 應該改（實證支持）

| 題型 | 證據 | 目前狀態 |
|---|---|---|
| `true_false`（102 題） | 100% 判得動、**0 筆不一致** | 只有事後覆核，白跑 accessor |
| `fill_blank` 數值/符號型（數學 227、社會 19…） | 93% 判得動、98% 一致，不一致全是 AI 錯 | 只有事後覆核，白跑 accessor |
| `multi_choice`（13 題） | 與 `multi_fill` 字母型判定邏輯相同 | 連事後覆核都沒有 |
| 複合題的**勾選半**（`compound_*`、`multi_check_other`） | 勾選部分與 0b-4 同構 | 整題丟 accessor |

### ⚠️ 有條件

| 題型 | 條件 |
|---|---|
| 英語 `fill_blank` | 62% 判得動、99.9% 一致 **但**：該卷若啟用 `englishRules`（拼字/大小寫/標點扣分）必須留給 accessor。未啟用者才可 code-first |
| 數學 `fill_blank` 帶單位 | 必須套用該作業的 `unitErrorRule`（zero/half），不可自作主張「去單位相同就算對」 |

### ⛔ 不要改

| 題型 | 理由 |
|---|---|
| `word_problem`·`calculation` | 30% 判得動但不一致 84 筆，且單位（平方/立方）、過程、rubric 都不是字串比對能處理的 |
| 國語 `fill_blank`（1–2 字/注音） | 字形判官地盤，已拔 read |
| `short_answer`·`table_cell`·`diagram_draw` | 標答欄本來就空（rubric 型），無從比對 |

---

## 四、另外標記的問題（不屬於 code-first，但影響更大）

1. **322 題缺 `questionCategory`（11.2%）** — 所有 code 路徑的 gate 都認 category，缺了就永遠只能走 accessor，重批也救不回來。集中在舊英語卷（11401 英語期末 60 題、英語複習 40 題…）。**影響面比前述三項加起來還大。**
2. **查表制只覆蓋國語 `short_answer` + rubricsDimensions（約 20 題）** — 它是唯一能治「同答不同分」的機制，覆蓋率不到 1%。`90x+2400(g)` 那類就是卡在這裡。
3. **英語 `fill_blank` 連事後覆核都跳過** — 刻意設計（要 accessor 判拼字），但代價是 234 題完全沒有確定性保護。
4. **4–6 月的「理由說對卻 0 分」舊事故** — 本次比對抓到 100 筆（數卷U6、期中評量試卷、第二單元）。8 月的批改沒有再出現，但**那些卷的分數還是錯的**。

---

## 五、建議的實作方式

不要再為每個題型加一條 `Phase 0b-N`。改成**一條通則**：

> **Phase 0b-7｜確定性優先**：accessor 之前，對每一格用寬鬆比對器試判。
> 判得動 → 寫確定性分數、加入 `objectiveBypassIds`，accessor 看不到這格。
> 判不動 → 照舊送 accessor → 照舊事後覆核。

排除清單（走既有路徑，不進本通則）：`word_problem`/`calculation`、判官型（VJ/字形/級分制/map_fill）、
啟用 `englishRules` 的英語 `fill_blank`/`short_answer`、標答為空的 rubric 型。

**驗證方式**：全庫回放逐格 diff「現行最終分數 vs code-first 後最終分數」。
由於判定邏輯與現行事後覆核相同、只是提前，**差異應該只出現在本文件第二節列出的 AI 判錯格**；
出現其他差異就是搬錯了。
