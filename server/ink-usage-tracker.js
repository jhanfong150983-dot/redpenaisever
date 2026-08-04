/**
 * ink-usage-tracker.js — 2026-05-22 Token 用量寫入 helper
 *
 * 設計：
 *   1. 用 AsyncLocalStorage 跨整個 async chain 傳 trackContext
 *   2. proxy.js 入口 trackingContext.run({...}, () => runAiPipeline(...))
 *   3. 各層（executeStage / executeSinglePipelineCall / applyMathEqBlankOverride）
 *      callGeminiGenerateContent 完成後呼叫 recordTokenUsage()
 *   4. recordTokenUsage 從 trackingContext.getStore() 拿 actorUserId/billingUserId/isAdmin/inkSessionId
 *
 * 為什麼用 ALS：
 *   executeStage 有 30+ 個 caller、不可能每個都改 signature 多傳 trackContext。
 *   ALS 跨 Promise/async 邊界自動傳遞，最小程式碼侵入。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { computeInkPointsFromTokens } from './ink-session.js'

export const trackingContext = new AsyncLocalStorage()

/**
 * 寫 1 row 到 ink_session_usage
 *
 * @param {Object} args
 * @param {Object} args.usageMetadata - Gemini API 回應的 usageMetadata
 * @param {string} args.routeKey - AI stage route key (例如 'grading.classify')
 * @param {string} args.modelName - 實際被 Google 呼叫到的 model（含 fallback 後）
 */
export async function recordTokenUsage({ usageMetadata, routeKey, modelName }) {
  const ctx = trackingContext.getStore()
  if (!ctx?.supabaseAdmin || !ctx?.actorUserId) return  // 沒 context 或沒 user → 不寫
  if (!usageMetadata || typeof usageMetadata !== 'object') return

  const inputTokens = Number(usageMetadata.promptTokenCount) || 0
  const outputTokens = Number(usageMetadata.candidatesTokenCount) || 0
  const totalTokens =
    Number(usageMetadata.totalTokenCount) || inputTokens + outputTokens

  const { error } = await ctx.supabaseAdmin
    .from('ink_session_usage')
    .insert({
      user_id: ctx.actorUserId,
      session_id: ctx.inkSessionId || null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      usage_metadata: usageMetadata,
      route_key: routeKey || null,
      model_name: modelName || null,
      billing_user_id: ctx.billingUserId || ctx.actorUserId,
      is_admin_test: Boolean(ctx.isAdmin),
      // 2026-05-23: 補上 assignment/submission 給「按作業拆解」分析
      assignment_id: ctx.assignmentId || null,
      submission_id: ctx.submissionId || null
    })
  if (error) {
    console.warn(
      `[ink-usage-tracker] insert failed routeKey=${routeKey} model=${modelName}:`,
      error.message
    )
  }

  // 2026-07-30 學校統一批改 job:billingScope='school' 時把本次 call 的點數累加進 ALS 的
  // schoolCost 累加器——不逐 call 寫 DB(一卷 20-40 個 AI call 會灌爆 ledger),
  // 由 job worker 每卷結束後一次性扣 schools.ink_balance + 寫一筆 school_ink_ledger。
  // 個人/session 計費路徑(無 billingScope)完全不受影響。
  // 2026-08-04 固定扣除:啟用時學校端不再 per-call 累加扣款(usage 照記),
  //   批改扣款改在 save-grading 依題數整筆扣學校錢包。
  const flatBilling = process.env.FLAT_BILLING === '1'
  if (!flatBilling && ctx.billingScope === 'school' && ctx.schoolCost && typeof ctx.schoolCost.points === 'number') {
    try {
      const cost = computeInkPointsFromTokens({ inputTokens, outputTokens, totalTokens })
      ctx.schoolCost.points += cost?.points || 0
      ctx.schoolCost.calls = (ctx.schoolCost.calls || 0) + 1
    } catch (e) {
      console.warn('[ink-usage-tracker] school cost accumulate failed:', e?.message)
    }
  }
}

/**
 * 從 callGeminiGenerateContent 的 result 中萃取實際被呼叫的 model name
 * （含 fallback 後）
 */
export function extractModelNameFromResult(result, fallbackModel) {
  const modelPath = result?.modelPath
  if (typeof modelPath === 'string' && modelPath) {
    return modelPath.replace(/^models\//, '')
  }
  return fallbackModel || null
}
