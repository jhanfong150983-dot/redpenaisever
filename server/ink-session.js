import { resolveBillingUserId } from './billing-user.js'
import {
  INK_EXCHANGE_RATE,
  INPUT_USD_PER_MILLION,
  OUTPUT_USD_PER_MILLION,
  PLATFORM_FEE_TWD
} from './pricing-config.js'

export function computeInkPointsFromTokens({
  inputTokens,
  outputTokens,
  totalTokens
}) {
  const safeInputTokens = Number(inputTokens) || 0
  const safeOutputTokens = Number(outputTokens) || 0
  const safeTotalTokens =
    Number(totalTokens) || safeInputTokens + safeOutputTokens

  const baseUsd =
    (safeInputTokens / 1_000_000) * INPUT_USD_PER_MILLION +
    (safeOutputTokens / 1_000_000) * OUTPUT_USD_PER_MILLION
  const baseTwd = baseUsd * INK_EXCHANGE_RATE
  const baseTwdRounded = Math.ceil(baseTwd)
  // 2026-05-22: 拔掉 baseTwd>=1 條件——學生訂正 / 微 call 也要收平台費
  const platformFee = PLATFORM_FEE_TWD
  const points = baseTwdRounded + platformFee

  return {
    inputTokens: safeInputTokens,
    outputTokens: safeOutputTokens,
    totalTokens: safeTotalTokens,
    baseUsd,
    baseTwd,
    baseTwdRounded,
    platformFee,
    points
  }
}

export async function settleInkSession({
  supabaseAdmin,
  userId,
  sessionId
}) {
  const { data: usageRows, error: usageError } = await supabaseAdmin
    .from('ink_session_usage')
    .select('input_tokens, output_tokens, total_tokens')
    .eq('session_id', sessionId)
    .eq('user_id', userId)

  if (usageError) {
    throw new Error('讀取批改會話用量失敗')
  }

  const totals = (usageRows ?? []).reduce(
    (acc, row) => {
      acc.inputTokens += Number(row?.input_tokens) || 0
      acc.outputTokens += Number(row?.output_tokens) || 0
      acc.totalTokens += Number(row?.total_tokens) || 0
      return acc
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  )

  const cost = computeInkPointsFromTokens({
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    totalTokens:
      totals.totalTokens > 0
        ? totals.totalTokens
        : totals.inputTokens + totals.outputTokens
  })

  // 解析計費對象：學生 → 老師 owner_id；老師/admin → 自己
  // session 的 user_id 是 actor（可能是學生）；扣款要打到 billingUserId（學生時是老師）
  const billing = await resolveBillingUserId(supabaseAdmin, userId)
  const billingUserId = billing.billingUserId
  const isStudentActor = billing.isStudent

  // 查詢計費對象（老師 / 自己）的 role / balance，admin 不扣墨水
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('ink_balance, role')
    .eq('id', billingUserId)
    .maybeSingle()

  if (profileError) {
    throw new Error('讀取使用者點數失敗')
  }

  const isAdmin = profile?.role === 'admin'
  const currentBalance =
    typeof profile?.ink_balance === 'number' ? profile.ink_balance : 0

  let inkSummary = {
    chargedPoints: 0,
    balanceBefore: currentBalance,
    balanceAfter: currentBalance,
    applied: true
  }

  if (cost.points > 0 && !isAdmin) {
    // floor at 0：避免 session usage 累積成本超過老師當前餘額時把帳戶扣成負數
    // 老師餘額不夠時，這次照扣到 0，下一次開 session 會被擋
    const nextBalance = Math.max(0, currentBalance - cost.points)

    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        ink_balance: nextBalance,
        updated_at: new Date().toISOString()
      })
      .eq('id', billingUserId)

    if (updateError) {
      throw new Error('更新使用者點數失敗')
    }

    inkSummary = {
      chargedPoints: cost.points,
      balanceBefore: currentBalance,
      balanceAfter: nextBalance,
      applied: true
    }

    const { error: ledgerError } = await supabaseAdmin.from('ink_ledger').insert({
      user_id: billingUserId,
      delta: -cost.points,
      reason: 'gemini_session_settlement',
      metadata: {
        sessionId,
        usage: {
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          totalTokens: cost.totalTokens,
          calls: usageRows?.length ?? 0
        },
        cost,
        actorUserId: userId,
        billedTo: isStudentActor ? 'teacher_owner' : 'self'
      }
    })

    if (ledgerError) {
      console.warn('Ink ledger insert failed:', ledgerError)
    }
  }

  return {
    inkSummary,
    cost,
    totals,
    usageCount: usageRows?.length ?? 0
  }
}
