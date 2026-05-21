/**
 * pricing-config.js — 2026-05-22 扣款公式中央化
 *
 * 之前常數分散在 proxy.js 跟 ink-session.js 兩個檔、容易不同步。
 * 改公式只改這個檔案、兩個地方一起生效。
 *
 * 公式：
 *   baseUsd     = (input/1M × INPUT_USD_PER_MILLION) + (output/1M × OUTPUT_USD_PER_MILLION)
 *   baseTwd     = baseUsd × INK_EXCHANGE_RATE
 *   points      = ceil(baseTwd) + PLATFORM_FEE_TWD   // 2026-05-22 拔掉 baseTwd>=1 條件
 */

export const INK_EXCHANGE_RATE = 33

// 2026-05-22: 公式校準對齊 Gemini 3.5 Flash 真實訂價 ($1.50 input / $9 output per 1M)
// 加 33% input markup + 11% output markup，作為毛利底（後續 maintenance fee 再加 NT$2）
export const INPUT_USD_PER_MILLION = 2
export const OUTPUT_USD_PER_MILLION = 10

// 2026-05-22: 平台維護費從 NT$1 提高到 NT$2、並拔掉 baseTwd>=1 條件
// 原本小於 NT$1 的 call 平台費歸零（學生訂正等 micro-call 不收費，bug）
// 現在無條件 +PLATFORM_FEE_TWD
export const PLATFORM_FEE_TWD = 2
