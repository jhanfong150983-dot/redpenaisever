// 沙盒費率單一來源(2026-08-08 建立)。
//
// ⛔⛔ 為什麼有這個檔:2026-08-08 沙盒腳本各自硬寫費率,且把 gemini-3.5-flash 寫成
//   $0.30/$2.50(官方實為 $1.50/$9.00)→ 整個降本結論被誤導(國語每份誤算成 4.87、
//   實際 7.16;還推出「判官 pin 3.5 便宜 5 倍」這種完全講反的結論)。
//   **費率權威 = api/admin/[action].js 的 modelRates()**;本檔逐字鏡像它。
//   新沙盒一律 `import { modelRates, costTwd } from '../_rates.mjs'`,不要再自己寫數字。
//
// 對照(USD / 1M tokens):
//   gemini-3.6-flash  1.50 / 7.50
//   gemini-3.5-flash  1.50 / 9.00   ← 輸出比 3.6 貴
//   gemini-2.5-flash  0.075 / 0.30  ← 便宜 20 倍
//   2.5-flash-lite    0.10 / 0.40
//   *pro              1.25 / 5.00

export const USD_TO_TWD = 33

/** 逐字鏡像 api/admin/[action].js modelRates() */
export function modelRates(model) {
  const m = String(model || '')
  if (m.includes('2.5-flash-lite')) return { inUsd: 0.10, outUsd: 0.40 }
  if (m.includes('2.5-flash')) return { inUsd: 0.075, outUsd: 0.30 }
  if (m.includes('3.6-flash')) return { inUsd: 1.50, outUsd: 7.50 }
  if (m.includes('3.5-flash')) return { inUsd: 1.50, outUsd: 9.00 }
  if (m.includes('3-flash-preview')) return { inUsd: 1.50, outUsd: 9.00 }
  if (m.includes('pro')) return { inUsd: 1.25, outUsd: 5.00 }
  return { inUsd: 1.50, outUsd: 9.00 }
}

/**
 * 單次呼叫成本(TWD)。thinking tokens 按輸出價計(儀表板同口徑;漏算會少算過半)。
 * @param {string} model
 * @param {object} u usageMetadata(或 {promptTokenCount, candidatesTokenCount, thoughtsTokenCount})
 * @param {number} [cachedTokens] 命中快取的 token 數(該部分收 10%)
 */
export function costTwd(model, u = {}, cachedTokens = 0) {
  const r = modelRates(model)
  const inTok = Number(u.promptTokenCount) || 0
  const cached = Math.max(0, Math.min(inTok, Number(cachedTokens) || 0))
  const billIn = (inTok - cached) + cached * 0.1
  const out = (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0)
  return (billIn / 1e6 * r.inUsd + out / 1e6 * r.outUsd) * USD_TO_TWD
}

/** usageMetadata 裡的圖片 token(promptTokensDetails 的 IMAGE modality) */
export function imageTokensOf(u = {}) {
  return (u.promptTokensDetails ?? []).find((d) => d.modality === 'IMAGE')?.tokenCount ?? 0
}
