// 個人版份數定價（2026-09-18 user 拍板：砍會員／等級、單價固定、優惠只用「送份數」）。
//   ⚠ 這裡是權威；client 鏡像在 redpenai/src/lib/ink-pricing.ts，改一邊要同步另一邊。
//   - 每份固定 NT$5（含稅）；份數永不過期。
//   - 禮包（ink_packages）：drops 為購買份數、bonus_drops 為贈送份數；金額一律 drops × 單價（bonus 不收費）。
//   - 自訂份數：1 ~ CUSTOM_MAX 份、不送；金額 units × 單價。
export const INK_UNIT_PRICE_TWD = 5
export const CUSTOM_UNITS_MIN = 1
export const CUSTOM_UNITS_MAX = 5000

export function inkAmountTwd(units) {
  const n = Number.parseInt(String(units), 10)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n * INK_UNIT_PRICE_TWD
}
