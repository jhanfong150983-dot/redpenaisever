// 2026-08-04 固定扣除計費(user 拍板:對外按動作定價、內部 token 帳只當毛利監控)。
// 2026-09-13 改「份」制(user 拍板、定價頁同步):
//   ・單位＝份(一位學生的一份考卷)。每按一次批改、成功的每一份扣 1(不分題數題型、重批照扣、失敗不扣)。
//   ・家長報告／訂正／學生自批 一律 0(功能開放與否改由學校方案等級決定，不用錢擋)。
//   ・既有餘額不換算:1 點＝1 份(profiles.ink_balance / schools.ink_balance 欄位名照舊、語意改份)。
//   ・兩種墨水:個人墨水(profiles.ink_balance)＋校園墨水(teacher_school_ink：學校從池裡配給老師、
//     只能用在該校班級的卷、可收回)。扣款順序:統一考卷→學校池;老師自建卷在該校班級→校園墨水優先、
//     不足的部分改扣個人;其餘→個人。
//   ⚠ DDL 手動跑:local-only/ddl-2026-09-13-teacher-school-ink.sql(表不存在時 fail-open＝視為校園墨水 0)。
//
// 邊界語意(user 過目):失敗不扣、重批照輪再扣、審查中斷(只跑 A 沒進 B)不扣、
//   人工改分不扣(scoreSource='manual' / fromManualScoreEdit)。
// 冪等:submissions.charged_graded_at 記「已為哪個 graded_at 收過費」——同輪重存不重扣、
//   重批(graded_at 變新)才再扣。
//
// ⚠ 開關:FLAT_BILLING='1' 啟用。啟用時 proxy/session/school 的舊三路扣款全部旁路
//   (usage 照記、不扣點),扣款只在動作完成點發生。預設關=行為與舊制完全相同。

// 2026-08-04 user 拍板:預設開。回退=FLAT_BILLING='0'(client 同步 VITE_FLAT_BILLING='0')
export const FLAT_BILLING_ENABLED = process.env.FLAT_BILLING !== '0'

/** 每份考卷扣幾份(=1)。保留函式簽名給舊呼叫點；題數不再影響價格。 */
export const SHEET_POINTS = 1
export function gradingActionPoints(_totalQuestions) {
  return SHEET_POINTS
}

export const PARENT_REPORT_POINTS_PER_STUDENT = 0
export const RECHECK_POINTS = 0

const isMissingTable = (err) => /teacher_school_ink|does not exist|relation .* not found|42P01/i.test(String(err?.message || err || ''))

/** 老師在各校的校園墨水餘額（表不存在 → []）。 */
export async function listCampusBalances(supabaseAdmin, profileId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('teacher_school_ink')
      .select('school_id, balance')
      .eq('profile_id', profileId)
    if (error) throw error
    const rows = (data ?? []).filter((r) => typeof r.balance === 'number')
    if (!rows.length) return []
    const { data: schools } = await supabaseAdmin
      .from('schools').select('id, name, report_school_name').in('id', rows.map((r) => r.school_id))
    const nameById = new Map((schools ?? []).map((s) => [s.id, s.report_school_name || s.name || '']))
    return rows.map((r) => ({ schoolId: r.school_id, schoolName: nameById.get(r.school_id) || '', balance: r.balance }))
  } catch (err) {
    if (!isMissingTable(err)) console.warn('[action-billing] listCampusBalances failed:', err?.message)
    return []
  }
}

/**
 * 計費對象解析(server 端權威、不信任 client header)。
 * 2026-08-04 修正(user 抓到):看「考卷」不看「人」——只有學校考卷(school_exam_classes
 *   掛的 assignment → school_exams.school_id)才走學校錢包。
 * 2026-09-13 校園墨水:其餘卷若掛在某校的班級(classrooms.school_id)、且老師在該校有校園墨水餘額>0
 *   → scope 'campus'(先扣校園、不足改扣個人)；否則個人。查詢失敗 fail-open 回個人。
 * @returns Map(assignmentId → {scope:'school'|'campus'|'personal', id, schoolId?})
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
  // 校園墨水：老師自建卷 → 班級所屬學校 → 該校有餘額才切 campus
  try {
    const rest = aids.filter((a) => map.get(a)?.scope === 'personal')
    if (rest.length) {
      const { data: asgs } = await supabaseAdmin
        .from('assignments').select('id, classroom_id').in('id', rest)
      const cids = [...new Set((asgs ?? []).map((a) => a.classroom_id).filter(Boolean))]
      if (cids.length) {
        const { data: classes } = await supabaseAdmin
          .from('classrooms').select('id, school_id').in('id', cids)
        const schoolByClass = new Map((classes ?? []).filter((c) => c.school_id).map((c) => [c.id, c.school_id]))
        const schoolIds = [...new Set([...schoolByClass.values()])]
        if (schoolIds.length) {
          const { data: wallets, error } = await supabaseAdmin
            .from('teacher_school_ink')
            .select('school_id, balance')
            .eq('profile_id', ownerId)
            .in('school_id', schoolIds)
          if (error) throw error
          const balBySchool = new Map((wallets ?? []).map((w) => [w.school_id, w.balance]))
          for (const a of asgs ?? []) {
            const sid = schoolByClass.get(a.classroom_id)
            if (sid && (balBySchool.get(sid) ?? 0) > 0) map.set(a.id, { scope: 'campus', id: ownerId, schoolId: sid })
          }
        }
      }
    }
  } catch (err) {
    if (!isMissingTable(err)) console.warn('[action-billing] campus resolve failed (fail-open personal):', err?.message)
  }
  return map
}

/** 單一 assignment 的便捷版(訂正/學生自批/家長報告用) */
export async function resolveBillingTarget(supabaseAdmin, ownerId, assignmentId = null) {
  const map = await resolveBillingTargetsByAssignment(supabaseAdmin, ownerId, assignmentId ? [assignmentId] : [])
  return map.get(assignmentId) ?? { scope: 'personal', id: ownerId }
}

// 個人扣點:樂觀鎖 ×4、地板 0(入口以 balance>0 守門;單動作造成的透支吸收)
// 2026-08-04 user 拍板:admin 也照扣(原免扣 bypass 移除)——測試要還原實際扣點行為,點數自己加。
async function debitPersonalInk(supabaseAdmin, { profileId, points }) {
  if (!points || points <= 0) return { ok: true, balance: null }
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('ink_balance')
      .eq('id', profileId)
      .maybeSingle()
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
 * 校園墨水異動（正＝配發入帳、負＝扣款或收回）。樂觀鎖 ×4；扣到 0 為止（回實際扣掉的量 charged）。
 * 表不存在 → {ok:false, missing:true}。
 * @returns { ok, balance, charged }
 */
export async function adjustCampusInk(supabaseAdmin, { schoolId, profileId, delta, reason, actorProfileId = null, metadata = {} }) {
  if (!delta) return { ok: true, balance: null, charged: 0 }
  for (let attempt = 0; attempt < 4; attempt++) {
    let before = 0, exists = false
    try {
      const { data: row, error } = await supabaseAdmin
        .from('teacher_school_ink').select('balance').eq('school_id', schoolId).eq('profile_id', profileId).maybeSingle()
      if (error) throw error
      exists = !!row; before = typeof row?.balance === 'number' ? row.balance : 0
    } catch (err) {
      if (isMissingTable(err)) return { ok: false, balance: null, charged: 0, missing: true }
      console.warn('[action-billing] campus read failed:', err?.message); return { ok: false, balance: null, charged: 0 }
    }
    const applied = delta < 0 ? -Math.min(before, -delta) : delta
    const after = before + applied
    if (applied === 0) return { ok: true, balance: before, charged: 0 }
    let updated
    if (exists) {
      const r = await supabaseAdmin.from('teacher_school_ink')
        .update({ balance: after, updated_at: new Date().toISOString() })
        .eq('school_id', schoolId).eq('profile_id', profileId).eq('balance', before).select('profile_id')
      if (r.error) { console.warn('[action-billing] campus update failed:', r.error.message); return { ok: false, balance: before, charged: 0 } }
      updated = r.data
    } else {
      const r = await supabaseAdmin.from('teacher_school_ink')
        .insert({ school_id: schoolId, profile_id: profileId, balance: after }).select('profile_id')
      if (r.error) { if (/duplicate|23505/i.test(r.error.message)) continue; console.warn('[action-billing] campus insert failed:', r.error.message); return { ok: false, balance: 0, charged: 0 } }
      updated = r.data
    }
    if (updated?.length) {
      const { error: lErr } = await supabaseAdmin.from('teacher_school_ink_ledger').insert({
        school_id: schoolId, profile_id: profileId, delta: applied, balance_after: after, reason, actor_profile_id: actorProfileId, metadata
      })
      if (lErr) console.warn('[action-billing] campus ledger insert failed:', lErr.message)
      return { ok: true, balance: after, charged: -Math.min(0, applied) }
    }
  }
  console.warn('[action-billing] campus optimistic-lock exhausted', schoolId, profileId)
  return { ok: false, balance: null, charged: 0 }
}

/**
 * 整筆扣款(依 target 分流)。
 *   school → 學校池(debitSchoolInk 含 ledger)；campus → 校園墨水優先、不足改扣個人；personal → 個人。
 * @returns { ok, balance, scope, campusBalance?, personalBalance?, campusCharged?, personalCharged? }
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
  if (target.scope === 'campus' && target.schoolId) {
    const c = await adjustCampusInk(supabaseAdmin, {
      schoolId: target.schoolId, profileId: target.id, delta: -points, reason, actorProfileId, metadata
    })
    const remainder = points - (c.ok ? c.charged : 0)
    let p = { ok: true, balance: null }
    if (remainder > 0) p = await debitPersonalInk(supabaseAdmin, { profileId: target.id, points: remainder })
    return {
      ok: (c.ok || c.missing) && p.ok, scope: 'campus',
      balance: c.balance, campusBalance: c.balance, personalBalance: p.balance,
      campusCharged: c.ok ? c.charged : 0, personalCharged: remainder
    }
  }
  const r = await debitPersonalInk(supabaseAdmin, { profileId: target.id, points })
  return { ...r, scope: 'personal', personalBalance: r.balance, personalCharged: points }
}
