// 2026-07-31 學校錢包共用扣款(user 拍板:行政端的 AI 一律扣學校錢包、教師端扣個人)。
// 原子扣減:樂觀鎖 ×4;允許單次成本造成的小幅負值飄移(入口以 balance>0 守門)。
// 消費者:批改 job(reason='grading_job')、行政端 client AI 呼叫(reason='school_ai')。

export async function debitSchoolInk(
  supabaseAdmin,
  { schoolId, points, actorProfileId = null, reason = 'grading_job', metadata = {} }
) {
  if (!points || points <= 0) return { ok: true, balance: null }
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: school } = await supabaseAdmin
      .from('schools')
      .select('ink_balance')
      .eq('id', schoolId)
      .maybeSingle()
    const before = typeof school?.ink_balance === 'number' ? school.ink_balance : 0
    const after = before - points
    const { data: updated, error } = await supabaseAdmin
      .from('schools')
      .update({ ink_balance: after, updated_at: new Date().toISOString() })
      .eq('id', schoolId)
      .eq('ink_balance', before)
      .select('id')
    if (error) {
      console.warn('[school-wallet] debit failed:', error.message)
      return { ok: false, balance: before }
    }
    if (updated?.length) {
      const { error: lErr } = await supabaseAdmin.from('school_ink_ledger').insert({
        school_id: schoolId,
        delta: -points,
        balance_after: after,
        reason,
        actor_profile_id: actorProfileId,
        metadata
      })
      if (lErr) console.warn('[school-wallet] ledger insert failed:', lErr.message)
      return { ok: true, balance: after }
    }
  }
  console.warn('[school-wallet] debit optimistic-lock exhausted schoolId=', schoolId)
  return { ok: false, balance: null }
}
