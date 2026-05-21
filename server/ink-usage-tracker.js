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
      is_admin_test: Boolean(ctx.isAdmin)
    })
  if (error) {
    console.warn(
      `[ink-usage-tracker] insert failed routeKey=${routeKey} model=${modelName}:`,
      error.message
    )
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
