/**
 * bbox-math-eq-blank.js — v2 (crop-based)
 *
 * 數學算式 □ 答題格專用 AI override（hint 含「算式」+「□」）。
 *
 * v1 (ddcbe31) reverted reason：
 *   - 送整張 4 頁 merged image 給 Pro → Pro 找到別頁的 □、座標跳到 y=0.194
 *   - 多 1 個 Pro call (~60s) → pipeline budget overrun、AI2 timeout 全空
 *
 * v2 修法：
 *   1. 用 classify bbox.y 當 anchor、crop 整張卷子的 y±0.03 那一塊（單頁 1/30 高度）
 *   2. 送 cropped 小圖給 Pro 3.1（速度快、~10s 不爆 budget）
 *   3. 拿回 crop 座標 bbox、remap 回 full image
 *   4. Sanity: y 偏離 anchor < 0.025、h < 0.02、w < 0.03 才接受
 *
 * 觸發條件 (math 專屬、natural / social 不會):
 *   anchorHint 含「算式」 且 含「□」
 *
 * Test (local v5 prompt + Pro 3.1)：6/6 math 1-4-1+1-4-2 (3 sub × 2 □)
 */

import { callGeminiGenerateContent } from './model-adapter.js'

function isMathEqBlankQid(question) {
  if (!question) return false
  const hint = String(question.anchorHint || '')
  return /算式/.test(hint) && /□/.test(hint)
}

/** crop image to y range (normalized) and return new base64 + crop offset */
async function cropImageByY(imageBase64, mimeType, yStartNorm, yEndNorm) {
  const { default: sharp } = await import('sharp')
  const buf = Buffer.from(imageBase64, 'base64')
  const meta = await sharp(buf).metadata()
  const fullH = meta.height
  const fullW = meta.width
  const yStartPx = Math.max(0, Math.floor(yStartNorm * fullH))
  const yEndPx = Math.min(fullH, Math.ceil(yEndNorm * fullH))
  const cropH = yEndPx - yStartPx
  if (cropH <= 0) return null
  const cropped = await sharp(buf)
    .extract({ left: 0, top: yStartPx, width: fullW, height: cropH })
    .jpeg({ quality: 88 })
    .toBuffer()
  return {
    base64: cropped.toString('base64'),
    mimeType: 'image/jpeg',
    cropYStart: yStartPx / fullH,  // normalized
    cropYEnd: yEndPx / fullH,
    cropHeightNorm: cropH / fullH,
    fullW, fullH
  }
}

async function classifyOneGroup(group, cropInfo, ctx) {
  const { model, apiKey, logger } = ctx
  const blankDescriptions = group.map((q, idx) =>
    `  □${idx + 1} (qid=${q.questionId}): ${q.anchorHint || '無 landmark'}`
  ).join('\n')

  const prompt = `這張圖是試卷一頁中的「算式答題區域」crop（只含 1 道題目附近）。

任務：找出指定題目「算式中多個 □ 答題格」的 bbox。

【本題 ${group.length} 個 □（依序）】
${blankDescriptions}

【關鍵】
1. 答題位置 = 算式中可以填入運算符號或數字的 □ 方框
2. **絕對禁止**框到題幹敘述的 □（如「下面算式的 □ 裡要填入...」這種題幹佔位符）
3. **絕對禁止**框到計算數字（如 4.73、2.73）
4. **絕對禁止**框到第一行題目算式（如「2 1/5 × 4.73 − 2.73 × 2 1/5」、那行無答題 □）
5. 答題 □ 在學生答案行（含「=」開頭）

【bbox size 限制】
- h: 0.005 ~ 0.025（單行字高、相對整張 crop 圖）
- w: 0.015 ~ 0.035（單字寬）
- 過大 = 框錯、請重新檢查

【做法】
1. 找算式塊
2. 跳過第一行（題目算式無 □）
3. 找學生答案行（"=" 開頭、有 □）
4. 依 hint landmark 描述、從左到右框出每個 □

回傳 JSON（normalized 0~1、相對本 crop 圖）：
{
  "blanks": [
    { "qid": "1-4-1", "x": 0.xxx, "y": 0.xxx, "w": 0.xxx, "h": 0.xxx, "left_landmark": "<左>", "right_landmark": "<右>" },
    ...
  ]
}

w/h 必須 > 0、x/y/w/h 都 0~1。只回 JSON、不要 markdown。`

  const result = await callGeminiGenerateContent({
    apiKey,
    model,
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: cropInfo.mimeType, data: cropInfo.base64 } }, { text: prompt }] }],
    payload: { generationConfig: { temperature: 0, responseMimeType: 'application/json' } }
  })
  if (!result.ok) {
    logger?.(`math-eq-blank crop classify failed status=${result.status}`)
    return null
  }
  const text = result.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed?.blanks) ? parsed.blanks : null
  } catch { return null }
}

/**
 * Main entry：對 math 算式 □ qids 做 crop + Pro AI 校正
 */
export async function applyMathEqBlankOverride(alignedQuestions, imageInline, answerKey, ctx) {
  if (!Array.isArray(alignedQuestions) || alignedQuestions.length === 0) {
    return { alignedQuestions, overrides: [] }
  }
  const akMap = new Map()
  for (const q of (answerKey?.questions || [])) akMap.set(q.id, q)

  const candidates = alignedQuestions
    .map(q => ({ q, ak: akMap.get(q.questionId) }))
    .filter(({ ak }) => isMathEqBlankQid(ak))

  if (candidates.length === 0) return { alignedQuestions, overrides: [] }
  ctx.logger?.(`math-eq-blank trigger detected: ${candidates.map(c => c.q.questionId).join(',')}`)

  // Group by qid prefix (excluding last segment) — e.g., 1-4-1 + 1-4-2 → "1-4"
  const groups = new Map()
  for (const c of candidates) {
    const parts = c.q.questionId.split('-')
    const groupKey = parts.slice(0, -1).join('-')
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey).push({ ...c, anchorHint: c.ak?.anchorHint })
  }

  const overrides = []
  const overrideMap = new Map()

  for (const [groupKey, items] of groups) {
    items.sort((a, b) => a.q.questionId.localeCompare(b.q.questionId))

    // 用 group 內第一個有 bbox 的 qid 當 y anchor
    const anchorItem = items.find(it => it.q.answerBbox?.y != null) || items[0]
    const anchorY = anchorItem.q.answerBbox?.y ?? null
    if (anchorY == null) {
      ctx.logger?.(`math-eq-blank skip group=${groupKey}: no anchor y`)
      continue
    }

    // Crop ±0.03 around anchor y
    const cropPad = 0.03
    const yStart = Math.max(0, anchorY - cropPad)
    const yEnd = Math.min(1, anchorY + cropPad)
    const cropInfo = await cropImageByY(imageInline.data, imageInline.mimeType, yStart, yEnd)
    if (!cropInfo) {
      ctx.logger?.(`math-eq-blank skip group=${groupKey}: crop failed`)
      continue
    }

    const groupForAi = items.map(it => ({ questionId: it.q.questionId, anchorHint: it.anchorHint }))
    const blanks = await classifyOneGroup(groupForAi, cropInfo, ctx)
    if (!blanks) continue

    for (const b of blanks) {
      if (!b?.qid || typeof b.x !== 'number' || !(b.w > 0) || !(b.h > 0)) continue
      // Remap crop coords to full image coords
      const fullY = cropInfo.cropYStart + b.y * cropInfo.cropHeightNorm
      const fullH = b.h * cropInfo.cropHeightNorm
      const fullX = b.x  // x is already full-width-relative (we didn't crop horizontally)
      const fullW = b.w
      // Sanity: y offset from anchor < 0.025
      if (Math.abs(fullY - anchorY) > 0.025) {
        ctx.logger?.(`math-eq-blank reject qid=${b.qid} y too far from anchor (fullY=${fullY.toFixed(4)} anchor=${anchorY.toFixed(4)})`)
        continue
      }
      // Sanity: size
      if (fullH > 0.02 || fullW > 0.05) {
        ctx.logger?.(`math-eq-blank reject qid=${b.qid} oversized (w=${fullW.toFixed(4)} h=${fullH.toFixed(4)})`)
        continue
      }
      overrideMap.set(b.qid, { x: fullX, y: fullY, w: fullW, h: fullH })
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
      method: 'math_eq_blank_override_v2'
    })
    return { ...q, answerBbox: newBbox }
  })

  return { alignedQuestions: out, overrides }
}
