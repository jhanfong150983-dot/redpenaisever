const INK_EXCHANGE_RATE = 33
const INPUT_USD_PER_MILLION = 0.5
const OUTPUT_USD_PER_MILLION = 3
const PLATFORM_FEE_TWD = 1

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
  const platformFee = baseTwd >= 1 ? PLATFORM_FEE_TWD : 0
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

  let inkSummary = {
    chargedPoints: 0,
    balanceBefore: null,
    balanceAfter: null,
    applied: true
  }

  if (cost.points > 0) {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('ink_balance')
      .eq('id', userId)
      .maybeSingle()

    if (profileError) {
      throw new Error('讀取使用者點數失敗')
    }

    const currentBalance =
      typeof profile?.ink_balance === 'number' ? profile.ink_balance : 0
    const nextBalance = currentBalance - cost.points

    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        ink_balance: nextBalance,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)

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
      user_id: userId,
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
        cost
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
