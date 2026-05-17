/**
 * bbox-math-eq-blank.js
 *
 * 專用 AI override：math 算式內 □ 答題格（hint 含「算式」+「□」+ landmark）
 *
 * Why:
 *   通用 classify prompt 對「算式中多個 □」結構容易抓錯位置（將 1-4-1 框到 1-4-2 位置、
 *   或框到題幹的 □、或框到 (4.73 等計算數字）。
 *   實驗證明 Pro 3.1 + v5-style landmark prompt 可 100% 找對。
 *
 * Detection:
 *   anchorHint 含「算式」字眼 + 含「□」 → 屬於此類型
 *
 * Flow:
 *   1. 檢查 alignedQuestions 中是否有 math 算式 □ qids
 *   2. 若有、用 classify 給的 bbox.y 推估該題範圍、crop 那塊
 *   3. 用 v5-style 專用 prompt 呼叫 AI
 *   4. 回傳 override map
 *
 * Cost: 多 1 次 AI call per 算式 □ 題組（math 1-4 是 2 qid 合 1 call）
 */

import { callGeminiGenerateContent } from './model-adapter.js'

function isMathEqBlankQid(question) {
  if (!question) return false
  const hint = String(question.anchorHint || '')
  return /算式/.test(hint) && /□/.test(hint)
}

/**
 * 對 math 算式 □ 群組（同一題的多個 □、如 1-4-1 + 1-4-2）一次呼叫 AI 取得所有 bbox
 * @param {Array} group qids 屬於同題（如 1-4 系列）
 * @param {string} imageBase64 整張卷的 base64
 * @param {string} imageMime
 * @param {Object} ctx { model, apiKey, logger }
 */
async function classifyOneGroup(group, imageBase64, imageMime, ctx) {
  const { model, apiKey, logger } = ctx
  // 取得本題的所有 □ hint
  const blankDescriptions = group.map((q, idx) => {
    return `  □${idx + 1} (qid=${q.questionId}): ${q.anchorHint || '無 landmark'}`
  }).join('\n')

  const prompt = `這張圖是試卷一頁。

任務：找出指定題目「算式中多個 □ 答題格」的 bbox。

【本題包含 ${group.length} 個 □（依序）】
${blankDescriptions}

【關鍵原則】
1. 答題位置 = 算式中可以填入運算符號或數字的 □ 方框
2. **絕對禁止**框到題幹敘述的 □（如「下面算式的 □ 裡要填入...」）
3. **絕對禁止**框到計算數字（如 "4.73"、"2.73"）
4. **絕對禁止**框到第一行題目算式（如「2 1/5 × 4.73 − 2.73 × 2 1/5」、那行無 □）
5. □ 在學生答案行（通常是「= ... □ ... □ ...」格式）

【bbox size 限制（重要）】
- h: 0.005 ~ 0.020 之間（單行印刷字高）
- w: 0.015 ~ 0.035（單一字寬）
- 若 bbox 過大、表示框錯、請重新檢查

【做法】
1. 在圖中找到該題的算式塊
2. 跳過第一行（題目算式、無 □）
3. 找學生答案行（含「=」開頭、有 □）
4. 依 hint 的 landmark 描述、依序框出每個 □（從左到右）

回傳 JSON（normalized 0~1 浮點、相對整張圖）：
{
  "blanks": [
    { "qid": "1-4-1", "x": 0.xxx, "y": 0.xxx, "w": 0.xxx, "h": 0.xxx, "left_landmark": "<左邊 landmark text>", "right_landmark": "<右邊 landmark text>" },
    { "qid": "1-4-2", "x": 0.xxx, "y": 0.xxx, "w": 0.xxx, "h": 0.xxx, "left_landmark": "...", "right_landmark": "..." }
  ]
}

座標 0-1 normalized。w/h 必須 > 0。只回 JSON、不要 markdown。`

  const result = await callGeminiGenerateContent({
    apiKey,
    model,
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: imageMime, data: imageBase64 } }, { text: prompt }] }],
    payload: { generationConfig: { temperature: 0, responseMimeType: 'application/json' } }
  })
  if (!result.ok) {
    logger?.('math-eq-blank classify failed', { status: result.status, group: group.map(g => g.questionId) })
    return null
  }
  const text = result.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed?.blanks) ? parsed.blanks : null
  } catch {
    return null
  }
}

/**
 * @param {Array} alignedQuestions 已分類完成、含 answerBbox 的 questions
 * @param {Object} imageInline { mimeType, data: base64 }
 * @param {Object} answerKey
 * @param {Object} ctx { model, apiKey, logger }
 * @returns {Promise<{ alignedQuestions, overrides }>}
 */
export async function applyMathEqBlankOverride(alignedQuestions, imageInline, answerKey, ctx) {
  if (!Array.isArray(alignedQuestions) || alignedQuestions.length === 0) {
    return { alignedQuestions, overrides: [] }
  }
  // Build question lookup by qid for hint access
  const akMap = new Map()
  for (const q of (answerKey?.questions || [])) akMap.set(q.id, q)

  // 找符合條件的 qids
  const candidates = alignedQuestions
    .map(q => ({ q, ak: akMap.get(q.questionId) }))
    .filter(({ ak }) => isMathEqBlankQid(ak))

  if (candidates.length === 0) {
    return { alignedQuestions, overrides: [] }
  }

  // Group by question 「題號根」(qid prefix 不含最後一段 ordinal)
  // 例：1-4-1 + 1-4-2 → group key "1-4"
  const groups = new Map()
  for (const c of candidates) {
    const parts = c.q.questionId.split('-')
    const groupKey = parts.slice(0, -1).join('-')  // "1-4"
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey).push({ ...c, anchorHint: c.ak?.anchorHint })
  }

  const overrides = []
  const overrideMap = new Map()  // qid → bbox
  for (const [groupKey, items] of groups) {
    items.sort((a, b) => a.q.questionId.localeCompare(b.q.questionId))
    const groupForAi = items.map(it => ({ questionId: it.q.questionId, anchorHint: it.anchorHint }))
    const blanks = await classifyOneGroup(groupForAi, imageInline.data, imageInline.mimeType, ctx)
    if (!blanks) continue
    for (const b of blanks) {
      if (!b?.qid || typeof b.x !== 'number' || !(b.w > 0) || !(b.h > 0)) continue
      // sanity check：size 不能太大
      if (b.h > 0.04 || b.w > 0.05) {
        ctx.logger?.(`math-eq-blank reject oversized bbox qid=${b.qid} w=${b.w} h=${b.h}`)
        continue
      }
      overrideMap.set(b.qid, { x: b.x, y: b.y, w: b.w, h: b.h })
    }
  }

  if (overrideMap.size === 0) {
    return { alignedQuestions, overrides: [] }
  }

  const out = alignedQuestions.map(q => {
    const newBbox = overrideMap.get(q.questionId)
    if (!newBbox) return q
    overrides.push({
      qid: q.questionId,
      before: q.answerBbox,
      after: newBbox,
      method: 'math_eq_blank_override'
    })
    return { ...q, answerBbox: newBbox }
  })

  return { alignedQuestions: out, overrides }
}
