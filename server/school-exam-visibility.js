/**
 * 2026-08-03 Step 11:學校考卷「誰看得到」的單一判定來源。
 *
 * 規則(兩條,任一成立即可見,且一律唯讀):
 *   ① 任課:school_class_courses 有 (teacher_acc, campus_class_id) 且 subject == 考卷科目
 *   ② 導師:school_classes.homeroom_teacher_acc == 本人 → 該班所有科目
 *
 * ⚠ 這份邏輯同時被成績查詢(api/data/[action].js)和圖片下載(api/storage/download.js)使用。
 *   兩邊必須共用,否則會出現「看得到分數卻載不出作答照片」或更糟的「載得到不該看的圖」。
 */

/** 老師的 1Campus 身分可能跨校(一人多校) → 回傳每所學校對應的帳號 */
export async function resolveTeacherCampusIdentity(supabaseDb, userId) {
  const { data: idents, error } = await supabaseDb
    .from('external_identities')
    .select('provider_dsns, provider_account')
    .eq('provider', 'campus1')
    .eq('user_id', userId)
  if (error) throw error
  const rows = (idents ?? []).filter((it) => it.provider_dsns && it.provider_account)
  if (rows.length === 0) return []
  const dsnsList = [...new Set(rows.map((r) => String(r.provider_dsns)))]
  const { data: schools, error: sErr } = await supabaseDb
    .from('schools')
    .select('id, name, provider_dsns')
    .in('provider_dsns', dsnsList)
  if (sErr) throw sErr
  const schoolByDsns = new Map((schools ?? []).map((s) => [String(s.provider_dsns), s]))
  const out = []
  for (const r of rows) {
    const s = schoolByDsns.get(String(r.provider_dsns))
    if (!s) continue
    out.push({ schoolId: s.id, schoolName: s.name || '', acc: String(r.provider_account).trim() })
  }
  return out
}

/**
 * 這位老師在這些學校的可見範圍。
 * @returns Map<`${schoolId}|${campusClassId}`, Set<subject> | '*'>('*' = 導師,全科)
 */
export async function buildTeacherVisibility(supabaseDb, identities) {
  const visibleByClass = new Map()
  for (const idn of identities) {
    const [{ data: courseRows, error: cErr }, { data: hrRows, error: hErr }] = await Promise.all([
      supabaseDb
        .from('school_class_courses')
        .select('campus_class_id, subject')
        .eq('school_id', idn.schoolId)
        .eq('teacher_acc', idn.acc),
      supabaseDb
        .from('school_classes')
        .select('campus_class_id')
        .eq('school_id', idn.schoolId)
        .eq('homeroom_teacher_acc', idn.acc)
    ])
    if (cErr) throw cErr
    if (hErr) throw hErr
    for (const r of courseRows ?? []) {
      if (!r.campus_class_id || !r.subject) continue
      const k = `${idn.schoolId}|${r.campus_class_id}`
      const cur = visibleByClass.get(k)
      if (cur === '*') continue
      if (cur instanceof Set) cur.add(String(r.subject))
      else visibleByClass.set(k, new Set([String(r.subject)]))
    }
    for (const r of hrRows ?? []) {
      if (!r.campus_class_id) continue
      visibleByClass.set(`${idn.schoolId}|${r.campus_class_id}`, '*')
    }
  }
  return visibleByClass
}

export function canSeeClassSubject(visibleByClass, schoolId, campusClassId, subject) {
  const v = visibleByClass.get(`${schoolId}|${campusClassId}`)
  if (!v) return false
  if (v === '*') return true
  return subject ? v.has(String(subject)) : false
}

/**
 * 單一作業(某班某卷)這位老師是否有唯讀檢視權。
 * 非學校考卷的作業一律回 false——那條路走原本的 owner 判定。
 */
export async function canTeacherViewSchoolExamAssignment(supabaseDb, userId, assignmentId) {
  if (!assignmentId) return false
  const { data: ec, error: ecErr } = await supabaseDb
    .from('school_exam_classes')
    .select('exam_id, campus_class_id')
    .eq('assignment_id', assignmentId)
    .maybeSingle()
  if (ecErr || !ec) return false
  const { data: exam, error: eErr } = await supabaseDb
    .from('school_exams')
    .select('id, school_id, subject')
    .eq('id', ec.exam_id)
    .maybeSingle()
  if (eErr || !exam) return false
  const identities = (await resolveTeacherCampusIdentity(supabaseDb, userId)).filter(
    (i) => i.schoolId === exam.school_id
  )
  if (identities.length === 0) return false
  const vis = await buildTeacherVisibility(supabaseDb, identities)
  return canSeeClassSubject(vis, exam.school_id, String(ec.campus_class_id), exam.subject)
}
