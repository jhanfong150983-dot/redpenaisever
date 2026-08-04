// 2026-08-04 固定扣除計費(user 拍板:對外按動作定價、內部 token 帳只當毛利監控)。
//
// 舊制=每次 AI 呼叫按 token+平台費零碎扣;新制=「動作」完成時整筆扣:
//   批改一份·一輪(Phase B 寫入分數時):依題數級距 5/10/15/20 點
//   家長報告進階(每生):2 點;學生訂正:1 點;其餘(檢討單/分析/答案卷建置/錯題引導)免費
//
// 邊界語意(user 過目):失敗不扣、重批照輪再扣、審查中斷(只跑 A 沒進 B)不扣、
//   人工改分不扣(scoreSource='manual' / fromManualScoreEdit)。
// 冪等:submissions.charged_graded_at 記「已為哪個 graded_at 收過費」——同輪重存不重扣、
//   重批(graded_at 變新)才再扣。
//
// ⚠ 開關:FLAT_BILLING='1' 啟用。啟用時 proxy/session/school 的舊三路扣款全部旁路
//   (usage 照記、不扣點),扣款只在動作完成點發生。預設關=行為與舊制完全相同。
//   「旁路」與「完成扣」必須同版部署後才能開,否則出現免費空窗。

// 2026-08-04 user 拍板:預設開。回退=FLAT_BILLING='0'(client 同步 VITE_FLAT_BILLING='0')
export const FLAT_BILLING_ENABLED = process.env.FLAT_BILLING !== '0'

// 題數級距(定價報表 2026-08 定案;0/未知題數保守當標準卷,避免免費漏洞)
export function gradingActionPoints(totalQuestions) {
  const n = Number(totalQuestions) || 0
  if (n <= 0) return 10
  if (n <= 20) return 5
  if (n <= 40) return 10
  if (n <= 60) return 15
  return 20
}

export const PARENT_REPORT_POINTS_PER_STUDENT = 2
export const RECHECK_POINTS = 1

/**
 * 計費對象解析(server 端權威、不信任 client header)。
 * 2026-08-04 修正(user 抓到):看「考卷」不看「人」——只有學校考卷(school_exam_classes
 *   掛的 assignment → school_exams.school_id)才走學校錢包;其餘一律個人 ink_balance。
 *   舊版看 owner 是否為某校 exam_owner → 行政/admin 帳號連自己私人班的作業都誤扣學校錢包。
 *   查詢失敗 fail-open 回個人(寧可個人路線的 admin 免扣、不誤扣學校)。
 * @returns Map(assignmentId → {scope:'school'|'personal', id})
 */
export async function resolveBillingTargetsByAssignment(supabaseAdmin, ownerId, assignmentIds) {
  const map = new Map()
  const aids = [...new Set((assignmentIds ?? []).filter(Boolean))]
  for (const a of aids) map.set(a, { scope: 'personal', id: ownerId })
  if (aids.length === 0) return map
  try {
    const { data: links } = await supabaseAdmin
      .from('school_exam_classes')
      .select('exam_id, assignment_id')
      .in('assignment_id', aids)
    if (links?.length) {
      const examIds = [...new Set(links.map((l) => l.exam_id))]
      const { data: exams } = await supabaseAdmin
        .from('school_exams').select('id, school_id').in('id', examIds)
      const schoolByExam = new Map((exams ?? []).map((e) => [e.id, e.school_id]))
      for (const l of links) {
        const sid = schoolByExam.get(l.exam_id)
        if (sid) map.set(l.assignment_id, { scope: 'school', id: sid })
      }
    }
  } catch { /* fail-open → 個人 */ }
  return map
}

/** 單一 assignment 的便捷版(訂正/學生自批/家長報告用) */
export async function resolveBillingTarget(supabaseAdmin, ownerId, assignmentId = null) {
  const map = await resolveBillingTargetsByAssignment(supabaseAdmin, ownerId, assignmentId ? [assignmentId] : [])
  return map.get(assignmentId) ?? { scope: 'personal', id: ownerId }
}

// 個人扣點:樂觀鎖 ×4、地板 0(入口以 balance>0 守門;單動作造成的透支吸收)
async function debitPersonalInk(supabaseAdmin, { profileId, points }) {
  if (!points || points <= 0) return { ok: true, balance: null }
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('ink_balance, role')
      .eq('id', profileId)
      .maybeSingle()
    if (profile?.role === 'admin') return { ok: true, balance: profile?.ink_balance ?? null, adminBypass: true }
    const before = typeof profile?.ink_balance === 'number' ? profile.ink_balance : 0
    const after = Math.max(0, before - points)
    const { data: updated, error } = await supabaseAdmin
      .from('profiles')
      .update({ ink_balance: after, updated_at: new Date().toISOString() })
      .eq('id', profileId)
      .eq('ink_balance', before)
      .select('id')
    if (error) { console.warn('[action-billing] personal debit failed:', error.message); return { ok: false, balance: before } }
    if (updated?.length) return { ok: true, balance: after }
  }
  console.warn('[action-billing] personal debit optimistic-lock exhausted profile=', profileId)
  return { ok: false, balance: null }
}

/**
 * 整筆扣款(依 target 分流)。school 走既有 debitSchoolInk(含 ledger);personal 直扣 profiles。
 * @returns { ok, balance, scope }
 */
export async function chargeFlatPoints(supabaseAdmin, { target, points, actorProfileId = null, reason, metadata = {} }) {
  if (!points || points <= 0) return { ok: true, balance: null, scope: target.scope }
  if (target.scope === 'school') {
    const { debitSchoolInk } = await import('./school-wallet.js')
    const r = await debitSchoolInk(supabaseAdmin, {
      schoolId: target.id, points, actorProfileId, reason, metadata
    })
    return { ...r, scope: 'school' }
  }
  const r = await debitPersonalInk(supabaseAdmin, { profileId: target.id, points })
  return { ...r, scope: 'personal' }
}
