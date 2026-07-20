/**
 * Visual-Judgment Grader — VJ 題（diagram_color / map_symbol / grid_geometry）評分模組
 *
 * 背景：這些題答案是「學生畫在圖上的線/符號/形狀」，無法轉錄成文字、對錯要看圖判。
 * 舊路線（AI1/AI2 自由散文描述 → AI3 文字 Jaccard → flash 文字評分）對「畫柱高」86% 假性送審、分數不可信。
 *
 * 定案架構（2026-05-29/30 真資料實測，數習P66-69 q2-1：自動88%、100%準、0 false-blank）：
 *   A0(PRO)   ：看答案卷 crop → vjRubric{ itemLabels[], condition, gradingDefinition }
 *   Phase A   ：兩個專用 blank reader（FLASH）只判「每個子元素有沒有畫」→ 逐項一致性（無 AI3）
 *               不一致 / 都說空白 → 送審；都說有畫 → auto_not_blank
 *   Phase B(PRO)：對「確認非空白」的子元素，帶權威參數「這項一定有畫、務必別判沒畫、看仔細」
 *               + gradingDefinition → 逐項 correct/wrong；確認-blank 直接 0（未作答、不送 AI）
 *
 * 純函式、無 HTTP、無 staged-grading 內部 state 依賴（同 map-fill-grader.js）。
 * staged-grading.js 負責用 executeStage 包 prompt + parse；模型分流見 model-config STAGE_MODEL：
 *   GRADING_VJ_RUBRIC=PRO、GRADING_VJ_BLANK=FLASH(gated)、GRADING_VJ_GRADE=PRO。
 */

export const VISUAL_JUDGMENT_TYPES = new Set([
  'diagram_color', 'map_symbol', 'grid_geometry'
])

// ── 通用 JSON 解析 ──────────────────────────────────────────────────────────
function parseJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null
  let t = rawText.replace(/```json|```/g, '').trim()
  const s = t.indexOf('{'); const e = t.lastIndexOf('}')
  if (s >= 0 && e > s) t = t.slice(s, e + 1)
  try { return JSON.parse(t) } catch { return null }
}

// ── Stage A0：答案卷 crop → vjRubric ─────────────────────────────────────────
// category：questionCategory；refText：referenceAnswer / answer（題意 hint）
export function buildVjRubricPrompt(category, refText) {
  const ref = String(refText ?? '').trim()
  // ⚠️ 文字提示常把形狀標錯（如把平行四邊形柱寫成長方柱、1/4圓柱寫成半圓柱）→ 標為「可能不準、別照抄」
  const refLine = ref ? `\n【文字提示（可能把形狀標錯，只當定位參考、不要照抄）】${ref}` : ''

  if (category === 'diagram_color') {
    return `這是一張**數學畫記/塗色題的答案卷**（老師畫的正解）。學生要在每個圖形上畫記或塗色作答。${refLine}

任務：找出**所有需要學生作答的獨立子元素**（每個圖形/區域一個），**逐一仔細辨識它實際是什麼立體**，並寫出評判條件。

【辨識立體形狀的規則（最重要，直接影響之後批改）】
- **以你看到的圖為準**，逐一數每個立體的面、看底面是什麼形狀再命名；**不要照抄上面的文字提示**。
- 常見：三角柱、長方體、長方柱、正方體、圓柱、半圓柱、**四分之一圓柱**、**梯形柱**、**平行四邊形柱**、五角柱…
- ⚠️ 斜的四邊形柱**不是**長方柱（長方柱有直角）；只露 1/4 圓弧的**不是**半圓柱。
- ⚠️ **區分長方柱 vs 平行四邊形柱**：長方柱（含長方體）側面是長方形、側邊本身就是高、**不會另外畫高**；若圖上某面**中間畫了一條輔助高（通常虛線）**，代表斜邊不是高、必須另標高 → 那是**平行四邊形柱或梯形柱**（看底面是平行四邊形還是梯形）。

【輸出 JSON（純 JSON、無 markdown）】
{
  "itemLabels": ["左上四分之一圓柱", "右上平行四邊形柱", "左下三角柱", "右下梯形柱"],
  "condition": "每個柱體用藍筆描出至少一條合法柱高",
  "gradingDefinition": "柱高=連接兩底面的側稜（長度方向的邊）；**任何一條連接兩底面的側稜都算正確**（不只一條標準答案）；描在底面的邊／內部的高（輔助高）／半徑／對角線＝錯。"
}

【規則】
- itemLabels：用「方位 + **你辨識出的正確立體名**」依「左上→右上→左下→右下」順序列出，每個獨立圖形一項。
- gradingDefinition：寫清楚「什麼算對」，「有多個等價合法側稜」時明講（避免誤殺）。
- 只看印刷正解、不臆造看不到的圖形。
只輸出 JSON。`
  }

  // map_symbol / grid_geometry：通用框架（沿用同 schema，落地前各型 harness 驗證 gradingDefinition）
  const typeHint = category === 'map_symbol'
    ? '學生在地圖/圖上畫符號或標位置。gradingDefinition 要寫清楚「正確符號 + 正確相對位置」的判準。'
    : '學生在格線上畫指定幾何圖形。gradingDefinition 要寫清楚「正確形狀 + 尺寸(格數) + 位置」的判準，並註明等價的合法畫法。'
  return `這是一張**視覺作答題的答案卷**（老師畫的正解）。${refLine}

任務：找出所有需要學生作答的獨立子元素，並寫出評判條件。${typeHint}

【輸出 JSON】
{ "itemLabels": ["...", "..."], "condition": "...", "gradingDefinition": "..." }

依閱讀順序列出 itemLabels，只看印刷正解、不臆造。只輸出 JSON。`
}

export function parseVjRubricResult(rawText) {
  const p = parseJson(rawText)
  if (!p || !Array.isArray(p.itemLabels)) return null
  const itemLabels = p.itemLabels.map((s) => String(s ?? '').trim()).filter(Boolean)
  if (itemLabels.length === 0) return null
  return {
    itemLabels,
    condition: String(p.condition ?? '').trim(),
    gradingDefinition: String(p.gradingDefinition ?? '').trim()
  }
}

// ── Phase A：專用 blank reader（FLASH）只判「每個子元素有沒有畫」 ─────────────
// 不轉錄、不判對錯、不假設顏色。兩個獨立 reader 比一致性。
export function buildVjBlankPrompt(itemLabels) {
  const arr = Array.isArray(itemLabels) ? itemLabels : []
  const list = arr.map((label, i) => `  ${i + 1}. ${label}`).join('\n')
  return `這是一份視覺作答題的學生作答（學生在每個元素上手繪作答，例如描線、畫符號、塗色）。

【子元素清單（共 ${arr.length} 項，逐項對應、不可增減、不可改順序）】
${list}

你只做一件事：逐項判斷學生「**有沒有在這個元素上加上任何手繪筆跡/作答**」。
- 有任何學生手繪的線條/符號/塗色/筆跡（不論顏色、不管畫對畫錯、不管畫在哪）→ "yes"
- 完全沒有學生加上的筆跡 → "no"
- 注意：圖形本身的彩色印刷外框/格線/題目印的字**不算**；只看學生加上去的。仔細看淡的、短的、小的筆跡。
- **不要判斷對錯、不要描述位置**，只回有沒有畫。

【輸出 JSON（純 JSON、無 markdown）】
{ "perItem": [ { "idx": 1, "hasMark": "yes" }, { "idx": 2, "hasMark": "no" } ] }
必須回剛好 ${arr.length} 項、idx 一一對應。只輸出 JSON。`
}

export function parseVjBlankResult(rawText, expectedCount) {
  const p = parseJson(rawText)
  const arr = Array.isArray(p?.perItem) ? p.perItem : null
  if (!arr) return null
  const map = new Map()
  for (const it of arr) {
    const idx = Number(it?.idx)
    if (!Number.isFinite(idx) || idx < 1) continue
    let v = String(it?.hasMark ?? '').trim().toLowerCase()
    map.set(idx, v === 'yes' ? 'yes' : v === 'no' ? 'no' : (v ? 'yes' : 'no'))
  }
  const out = []
  for (let i = 1; i <= expectedCount; i++) out.push({ idx: i, hasMark: map.get(i) || 'no' })
  return out
}

// ── 逐項 blank 分類（單一 PRO reader、inline、無 AI3） ───────────────────────
// 實測（vj-pro-blank-stability）：PRO blank 偵測 5 次 88/88 逐柱完全一致、座號24 每次認出空白
// → 單一 PRO reader 即足夠（第二個 PRO reader 會給相同答案、零額外資訊）。
// blankRead：[{idx, hasMark}]；回 {perItem, anyReview}
// status: 'auto_not_blank'（有畫 yes → 自動送 grade）| 'review_blank'（空白 no → 送審確認）
export function classifyVjBlank(itemLabels, blankRead) {
  const labels = Array.isArray(itemLabels) ? itemLabels : []
  const m = new Map((blankRead || []).map((x) => [x.idx, x.hasMark]))
  const perItem = labels.map((label, i) => {
    const idx = i + 1
    const v = m.get(idx) || 'no'
    return { idx, label, hasMark: v, status: v === 'yes' ? 'auto_not_blank' : 'review_blank' }
  })
  return { perItem, anyReview: perItem.some((p) => p.status !== 'auto_not_blank') }
}

// ── Phase B：grade（PRO）帶權威 blank 參數 ───────────────────────────────────
// itemLabels、gradingDefinition 來自 vjRubric；notBlankIdxs：已確認非空白的 idx（只評這些）
// category：questionCategory；hasReference：是否附了【正確答案圖】（作圖/地圖符號題用）
export function buildVjGradePrompt(category, itemLabels, gradingDefinition, notBlankIdxs, hasReference) {
  const labels = Array.isArray(itemLabels) ? itemLabels : []
  const notBlank = Array.isArray(notBlankIdxs) ? notBlankIdxs : []
  const list = labels.map((label, i) => `  ${i + 1}. ${label}`).join('\n')
  const nbStr = notBlank.length ? notBlank.join('、') : '（無）'
  const blankGuard = `【100% 正確的已知資訊，務必遵守】以下項目「確定有學生的作答筆跡」：項 ${nbStr}。
你**絕對不可判它沒畫(blank)**，請務必仔細找出學生那條筆跡並判斷對錯（correct/wrong）。
（未列在上面的項目可能沒畫，若真找不到才回 blank。）`
  const jsonOut = `【輸出 JSON（純 JSON、無 markdown）】
{ "perItem": [ { "idx": 1, "seen": "...", "verdict": "correct|wrong|blank" } ] }
只輸出 JSON。`

  // 2026-07-21：作圖/地圖符號題改「結構比對」（治「AI 自己數方格報錯座標→把畫對的判 0」；
  //   沙盒實測附正解圖能止住亂數座標的幻覺）。diagram_color（描柱高/塗色）維持原本已驗證的藍筆 prompt。
  if (category === 'grid_geometry' || category === 'map_symbol') {
    const refIntro = hasReference
      ? '附兩張圖：**【正確答案圖】**（老師畫的標準答案）與**【學生作答圖】**（要批改的），兩張畫在**相同版面**（相同格線／地圖／對稱軸）上。'
      : '附【學生作答圖】。'
    const refRule = hasReference
      ? `【最關鍵：跟「正確答案圖」比對，不要自己報座標】
- 逐項把「學生作答圖」的該元素，拿去跟「正確答案圖」對應元素**比對**，判斷是否**結構等價**——形狀、大小（相對格數）、相對於軸／基準的位置一致。`
      : `【最關鍵：判斷結構、不要自己報座標】
- 逐項判斷學生畫的該元素，形狀／大小／相對位置是否符合評判標準。`
    return `這是一份視覺作答題的學生作答，需逐項判斷對錯。${refIntro}

【子元素清單（共 ${labels.length} 項）】
${list}

【評判標準】${gradingDefinition || '依題意判斷學生作答是否正確。'}

${blankGuard}

${refRule}
- ⚠ **容許手繪誤差**：線條抖動、不直、輕微偏移、未完全閉合但形狀可辨，一律算 correct。
- ⚠ **絕對不要自己數方格、報絕對座標**（如「應在 (4,1)、你畫在 (5,2)」）——你數格容易數錯。
- 只要學生畫的結構一致就 correct；只有**明顯形狀不同／漏畫該元素／位置關係錯**才 wrong。判不出來時傾向 correct（寧可不冤枉）。

逐項：先簡述你看到學生畫什麼${hasReference ? '、跟正解圖差在哪' : ''}，再給 verdict。
${jsonOut}`
  }

  // diagram_color（描柱高/塗色）：維持原本已驗證的 prompt（只算藍筆、忽略印刷線）。
  return `這是一份視覺作答題的學生作答，需逐項判斷對錯。

【子元素清單（共 ${labels.length} 項）】
${list}

【評判標準】${gradingDefinition || '依題意判斷學生作答是否正確。'}

${blankGuard}

【最關鍵：只算學生的藍筆，忽略題目印刷的線】
學生用「藍色筆」描柱高作答。圖上**原本就印好**的線——特別是題目用來標示「底面的高」的**虛線/輔助線**、以及柱體的印刷外框——都**不是學生畫的**。
- 判斷時**只看學生新加上去的藍色筆跡**描在哪條邊，拿它對照標準判對錯。
- **絕對不要**把印刷的虛線、輔助高、外框當成學生作答而判錯。
- 學生若描了多條或有少許雜筆，以**最明顯、最完整描在某一條邊**的那條為準。

逐項：先簡述你看到學生畫在哪，再給 verdict。
${jsonOut}`
}

export function parseVjGradeResult(rawText, expectedCount) {
  const p = parseJson(rawText)
  const arr = Array.isArray(p?.perItem) ? p.perItem : null
  if (!arr) return null
  const map = new Map()
  for (const it of arr) {
    const idx = Number(it?.idx)
    if (!Number.isFinite(idx) || idx < 1) continue
    let v = String(it?.verdict ?? '').trim().toLowerCase()
    if (!['correct', 'wrong', 'blank'].includes(v)) v = 'wrong'
    map.set(idx, { idx, verdict: v, seen: String(it?.seen ?? '').trim() })
  }
  const out = []
  for (let i = 1; i <= expectedCount; i++) out.push(map.get(i) || { idx: i, verdict: 'blank', seen: '' })
  return out
}

// ── 聚合分數 ────────────────────────────────────────────────────────────────
// itemLabels；blankConfirmed:[{idx,isBlank}]（老師/共識確認）；grades:[{idx,verdict}]（只非空白項有）
// maxScore：題滿分。回 {score, isCorrect, vjItemResults, scoringReason}
export function aggregateVjScore(itemLabels, blankConfirmed, grades, maxScore) {
  const labels = Array.isArray(itemLabels) ? itemLabels : []
  const blankMap = new Map((blankConfirmed || []).map((b) => [b.idx, !!b.isBlank]))
  const gradeMap = new Map((grades || []).map((g) => [g.idx, g])) // 保留整個 {verdict, seen}
  const n = labels.length
  let pass = 0
  const vjItemResults = []
  for (let i = 0; i < n; i++) {
    const idx = i + 1
    const label = labels[i]
    let verdict, reason
    if (blankMap.get(idx)) { verdict = 'blank'; reason = '未作答' }
    else {
      const g = gradeMap.get(idx)
      const v = g?.verdict
      const seen = String(g?.seen ?? '').trim() // AI 逐柱「看到學生畫在哪」
      if (v === 'correct') { verdict = 'correct'; reason = '正確' }
      else if (v === 'blank') { verdict = 'blank'; reason = '未作答' }
      else { verdict = 'wrong'; reason = seen || '位置/畫法不符' } // ⭐ wrong 用 AI 的 seen 當精確理由
    }
    if (verdict === 'correct') pass++
    vjItemResults.push({ idx, label, verdict, reason })
  }
  const ms = Number.isFinite(maxScore) ? maxScore : n
  const score = n > 0 ? Math.round(ms * pass / n) : 0
  const isCorrect = score === ms && ms > 0
  const fails = vjItemResults.filter((r) => r.verdict !== 'correct')
  const scoringReason = fails.length === 0
    ? `全部 ${n} 項正確。`
    : `通過 ${n - fails.length}/${n} 項。` + fails.map((f) => `「${f.label}」${f.reason}`).join('；')
  return { score, maxScore: ms, isCorrect, vjItemResults, scoringReason }
}
