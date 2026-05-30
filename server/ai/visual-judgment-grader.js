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
  const refLine = ref ? `\n【題目要求（hint）】${ref}` : ''

  if (category === 'diagram_color') {
    return `這是一張**數學畫記/塗色題的答案卷**（老師畫的正解）。學生要在每個圖形上畫記或塗色作答。${refLine}

任務：找出**所有需要學生作答的獨立子元素**（每個圖形/區域一個），並寫出評判條件。

【輸出 JSON（純 JSON、無 markdown）】
{
  "itemLabels": ["左上半圓柱體", "右上長方體", "左下三角柱體", "右下五角柱體"],
  "condition": "每個柱體用藍筆描出至少一條合法柱高",
  "gradingDefinition": "柱高=連接前後兩底面的側稜（長度方向的邊）；**任何一條連接兩底面的側稜都算正確**（不只一條標準答案）；畫在底面內的邊／半徑／對角線＝錯。"
}

【規則】
- itemLabels：用「方位 + 圖形名」依「左上→右上→左下→右下」順序列出，每個獨立圖形一項。
- condition：一句話總結學生每項該做什麼。
- gradingDefinition：**寫清楚「什麼樣的作答算對」**，特別是「有多個等價合法位置」時要明講（避免之後被當成只有一個標準答案而誤殺）。
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
export function buildVjGradePrompt(itemLabels, gradingDefinition, notBlankIdxs) {
  const labels = Array.isArray(itemLabels) ? itemLabels : []
  const notBlank = Array.isArray(notBlankIdxs) ? notBlankIdxs : []
  const list = labels.map((label, i) => `  ${i + 1}. ${label}`).join('\n')
  const nbStr = notBlank.length ? notBlank.join('、') : '（無）'
  return `這是一份視覺作答題的學生作答，需逐項判斷對錯。

【子元素清單（共 ${labels.length} 項）】
${list}

【評判標準】${gradingDefinition || '依題意判斷學生作答是否正確。'}

【100% 正確的已知資訊，務必遵守】以下項目「確定有學生的作答筆跡」：項 ${nbStr}。
你**絕對不可判它沒畫(blank)**，請務必仔細找出學生那條筆跡並判斷對錯（correct/wrong）。
（未列在上面的項目可能沒畫，若真找不到才回 blank。）

逐項：先簡述你看到學生畫在哪，再給 verdict。
【輸出 JSON（純 JSON、無 markdown）】
{ "perItem": [ { "idx": 1, "seen": "...", "verdict": "correct|wrong|blank" } ] }
只輸出 JSON。`
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
  const gradeMap = new Map((grades || []).map((g) => [g.idx, g.verdict]))
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
      if (g === 'correct') { verdict = 'correct'; reason = '正確' }
      else if (g === 'blank') { verdict = 'blank'; reason = '未作答' }
      else { verdict = 'wrong'; reason = '位置/畫法不符' }
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
