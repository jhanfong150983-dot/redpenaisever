// 2026-09-13 學校方案等級 Basic／PRO／PROMAX（user 拍板、與 /pricing 同步）。
//   原則：批改相關功能不分級；只有「不影響批改」的延伸功能分級。
//   權限：schools.plan 只有系統 admin 可改（api/admin school-wallet POST {schoolId, plan}）。
//   語意：方案只「加」權限——個人帳號原有的 Pro 權限（permissionTier/付費訂單）不受學校方案影響；
//         沒掛學校的卷（personal）一律不擋。
//   ⚠ DDL 手動：local-only/ddl-2026-09-13-school-plan.sql；欄位不存在時 fail-open＝視為 promax（不擋任何人）。
// client 鏡像：redpenai/src/lib/school-plan.ts（動一邊必動另一邊）

export const PLANS = ['basic', 'pro', 'promax']
export const PLAN_RANK = { basic: 0, pro: 1, promax: 2 }
export const PLAN_LABEL = { basic: 'Basic', pro: 'PRO', promax: 'PROMAX' }

/** 功能 → 最低方案 */
export const FEATURE_MIN_PLAN = {
  parentReport: 'pro',       // 家長報告（學校統一設定內容）
  reviewMode: 'pro',         // 檢討模式、樣態分析、概念雷達、學習追蹤
  schoolGrading: 'pro',      // 行政端統一批改、建立學校答案卷
  schoolReports: 'pro',      // 跨班校級報表、成績統計、學情分析（行政端）
  studentCorrection: 'promax', // 學生訂正與自助批改
  parentPush: 'promax'       // 家長推播（1Campus）
}

export function normalizePlan(v) {
  const p = String(v || '').trim().toLowerCase()
  return PLANS.includes(p) ? p : 'basic'
}

// 2026-09-18 user 拍板：砍會員／等級、功能全開。閘門保留但預設關；PLAN_GATING_ENABLED=1 才重新啟用分級。
export const PLAN_GATING_ENABLED = process.env.PLAN_GATING_ENABLED === '1'

export function planAllows(plan, feature) {
  if (!PLAN_GATING_ENABLED) return true
  const need = FEATURE_MIN_PLAN[feature]
  if (!need) return true
  return (PLAN_RANK[normalizePlan(plan)] ?? 0) >= PLAN_RANK[need]
}

const isMissingColumn = (err) => /plan|column .* does not exist|42703/i.test(String(err?.message || err || ''))

/** 學校方案（欄位不存在 → 'promax' fail-open；查無學校 → 'basic'） */
export async function getSchoolPlan(supabaseAdmin, schoolId) {
  if (!schoolId) return null
  try {
    const { data, error } = await supabaseAdmin.from('schools').select('plan').eq('id', schoolId).maybeSingle()
    if (error) throw error
    if (!data) return null
    return normalizePlan(data.plan)
  } catch (err) {
    if (isMissingColumn(err)) return 'promax'
    console.warn('[school-plan] getSchoolPlan failed (fail-open promax):', err?.message)
    return 'promax'
  }
}

/** 多校一次查（欄位不存在 → 全 promax） */
export async function getSchoolPlans(supabaseAdmin, schoolIds) {
  const ids = [...new Set((schoolIds ?? []).filter(Boolean))]
  const out = new Map()
  if (!ids.length) return out
  try {
    const { data, error } = await supabaseAdmin.from('schools').select('id, plan').in('id', ids)
    if (error) throw error
    for (const s of data ?? []) out.set(s.id, normalizePlan(s.plan))
  } catch (err) {
    for (const id of ids) out.set(id, 'promax')
    if (!isMissingColumn(err)) console.warn('[school-plan] getSchoolPlans failed (fail-open promax):', err?.message)
  }
  return out
}

/** 這份卷屬於哪所學校：統一考卷（school_exam_classes→school_exams）或班級（classrooms.school_id）；都沒有 → null（個人） */
export async function schoolIdForAssignment(supabaseAdmin, assignmentId) {
  if (!assignmentId) return null
  try {
    const { data: link } = await supabaseAdmin
      .from('school_exam_classes').select('exam_id').eq('assignment_id', assignmentId).maybeSingle()
    if (link?.exam_id) {
      const { data: exam } = await supabaseAdmin.from('school_exams').select('school_id').eq('id', link.exam_id).maybeSingle()
      if (exam?.school_id) return exam.school_id
    }
    const { data: asg } = await supabaseAdmin.from('assignments').select('classroom_id').eq('id', assignmentId).maybeSingle()
    if (!asg?.classroom_id) return null
    const { data: cls } = await supabaseAdmin.from('classrooms').select('school_id').eq('id', asg.classroom_id).maybeSingle()
    return cls?.school_id || null
  } catch (err) {
    console.warn('[school-plan] schoolIdForAssignment failed (treat as personal):', err?.message)
    return null
  }
}

/**
 * 這份卷能不能用某功能。個人卷（無學校）一律 ok。
 * @returns {{ ok:boolean, plan:string|null, schoolId:string|null, need:string }}
 */
export async function checkAssignmentPlan(supabaseAdmin, assignmentId, feature) {
  const need = FEATURE_MIN_PLAN[feature] || 'basic'
  const schoolId = await schoolIdForAssignment(supabaseAdmin, assignmentId)
  if (!schoolId) return { ok: true, plan: null, schoolId: null, need }
  const plan = await getSchoolPlan(supabaseAdmin, schoolId)
  return { ok: planAllows(plan ?? 'basic', feature), plan, schoolId, need }
}

export function planDeniedMessage(feature, plan) {
  const need = PLAN_LABEL[FEATURE_MIN_PLAN[feature] || 'basic']
  const cur = PLAN_LABEL[normalizePlan(plan)] || 'Basic'
  return `此功能屬於 ${need} 方案，貴校目前為 ${cur}。請聯絡 RedPen AI 升級。`
}
