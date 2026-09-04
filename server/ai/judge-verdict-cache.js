// ═══ 判官判定冷凍（通用版，2026-09-04 user 拍板「系統統一」）═══════════════════
//
// 【統一模型】（user 定案）
//   第零層  老師人工改分——永久凍結，壓過一切（source='teacher'）
//   第一路  文字：read 每次重跑 → 判分層凍結（code 確定性＝天然凍結／查表制＝值凍結）
//   第二路  圖像：判官看圖 → **同指紋一律冷凍**（本模組）
//
// 本模組把 VJ 已驗證的冷凍模式（vj-verdict-cache.js）推廣到其餘四個「重批必重跑」的判官：
//   字形(glyph)／注音(zhuyin)／級分制(level)／rubric 判官(rubric)。
//   VJ 自己的表維持不動（已上線、有老師回寫流程掛著）。
//
// 【為什麼要冷凍】LLM 服務端不保證可重現——VJ 實測 input_tokens 跨批次完全相同、
//   output 每輪都變；本專案 2026-08-31 也實證跨場次判官會漂（同圖同參數、隔幾小時答案不同）。
//   沒有冷凍＝每次重批分數可能翻盤（最傷老師信任）＋判官錢重付。
//
// 【鍵】sha1( 每張圖的 sha1 ＋ 設定簽章 sha1 ＋ prompt 版本 )
//   ・圖 hash 一律 hash **實際送進模型的 bytes**（放大後/畫紅框後），
//     裁圖或放大參數改動 → bytes 變 → 自然重判，不用另外管版本。
//   ・任一成分改變 → cache miss → 重判。「凍結」與「不被舊版綁死」同時成立。
//
// 【fail-open】表不存在／查詢失敗 → 當作沒有快取，照舊跑判官。DDL 未跑也不會壞。
//   kill switch：JUDGE_FREEZE='0'（讀寫全停）。
//
// ⚠ 動任何判官的 prompt／投票規則時，**必須**改對應的版本號，否則舊判定被沿用、
//   新修法對既有卷無效（重批看起來成功、實際跑的是舊邏輯——這比壞掉更難發現）。

import crypto from 'node:crypto'

export const JUDGE_PROMPT_VERSIONS = {
  glyph: 'glyph-2026-08-31-lazy3',          // 惰性第三票版（同 prompt ×2~3、一票否決）
  zhuyin: 'zy-2026-08-30-panel3-lazy3',     // 三判官 v2 ＋ 惰性第三票（含標準圖比對）
  level: 'level-2026-08-14-element-x1',     // 逐要素 1 次呼叫、code 彙總級分
  rubric: 'rubric-2026-09-04-v1',           // 看圖逐維度判分（evidence 先於 score）
}

const sha1 = (s) => crypto.createHash('sha1').update(String(s ?? '')).digest('hex')

export const judgeFreezeEnabled = () => process.env.JUDGE_FREEZE !== '0'

/**
 * @param {'glyph'|'zhuyin'|'level'|'rubric'} kind
 * @param {string[]} imageBase64s 實際送進模型的每張圖 bytes（順序固定：學生圖在前、參考圖在後）
 * @param {unknown} configSig 設定簽章素材（標準答案／rubric 內容…），JSON.stringify 後 hash
 */
export function buildJudgeCacheKey(kind, imageBase64s, configSig) {
  const ver = JUDGE_PROMPT_VERSIONS[kind]
  if (!ver) return null
  const imgs = (imageBase64s ?? []).filter(Boolean)
  if (imgs.length === 0) return null
  const imgPart = imgs.map((b) => sha1(b)).join('|')
  return sha1(`${kind}|${imgPart}|${sha1(JSON.stringify(configSig ?? null))}|${ver}`)
}

/** @returns null（無快取/表不存在/關閉）| { payload, score, maxScore, confidence, source } */
export async function loadJudgeVerdict(supabase, cacheKey) {
  if (!supabase || !cacheKey || !judgeFreezeEnabled()) return null
  try {
    const { data, error } = await supabase
      .from('judge_verdict_cache')
      .select('payload, score, max_score, confidence, source')
      .eq('cache_key', cacheKey)
      .maybeSingle()
    if (error || !data || data.payload == null) return null
    return {
      payload: data.payload,
      score: data.score === null ? null : Number(data.score),
      maxScore: data.max_score === null ? null : Number(data.max_score),
      confidence: data.confidence === null ? null : Number(data.confidence),
      source: String(data.source ?? 'ai'),
    }
  } catch { return null }
}

export async function saveJudgeVerdict(supabase, cacheKey, { kind, payload, score, maxScore, confidence, assignmentId, submissionId, questionId, model }) {
  if (!supabase || !cacheKey || !judgeFreezeEnabled()) return false
  try {
    // ⚠ ignoreDuplicates：既有列（含 source='teacher'）保持不動，AI 永不覆蓋老師的裁決。
    const { error } = await supabase.from('judge_verdict_cache').upsert({
      cache_key: cacheKey,
      kind,
      assignment_id: assignmentId ?? null,
      submission_id: submissionId ?? null,
      question_id: String(questionId ?? ''),
      payload: payload ?? {},
      score: score ?? null,
      max_score: maxScore ?? null,
      confidence: confidence ?? null,
      source: 'ai',
      model: model ?? null,
    }, { onConflict: 'cache_key', ignoreDuplicates: true })
    return !error
  } catch { return false }
}
