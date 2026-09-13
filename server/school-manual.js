// 2026-09-13 手動學校（非 1Campus）：行政批次上傳名冊 → 寫進與 1Campus 同步**同一套**名冊表
//   （school_classes / school_person / school_teacher_roster / school_class_courses），前端零改動；
//   老師用 Google 登入、Email 對到教師名冊 → school_teachers（source 'manual'）→ 鏡像「被指派的班」到教師端
//   （沿用 mirrorSchoolClassesToOwner，只鏡像 onlyClassIds）。
//   識別碼慣例（日後開通 1Campus 時靠學號接人）：班 `m:${schoolYear}:${className}`、學生 `m:${studentNumber}`、老師 `m:${email}`。
import crypto from 'node:crypto'
import { mirrorSchoolClassesToOwner, upsertSchoolPersonsForClassroom } from './school-membership.js'

const norm = (s) => String(s ?? '').trim()
const lower = (s) => norm(s).toLowerCase()
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
const isMissingTable = (e) => /does not exist|42P01/i.test(String(e?.message || e || ''))

export const manualClassId = (schoolYear, className) => `m:${schoolYear}:${norm(className)}`
export const manualStudentPid = (studentNumber) => `m:${norm(studentNumber)}`
export const manualTeacherId = (email) => `m:${lower(email)}`

/** 是否手動學校（沒有 1Campus dsns） */
export async function isManualSchool(supabaseAdmin, schoolId) {
  const { data } = await supabaseAdmin.from('schools').select('provider_dsns').eq('id', schoolId).maybeSingle()
  return !!data && !data.provider_dsns
}

/**
 * 批次匯入名冊（整校覆蓋式：本次沒出現的學生標 inactive、班級與任課以本次為準）。
 * @param {object} p
 * @param {string} p.schoolId
 * @param {number} p.schoolYear  民國學年（例 114）
 * @param {1|2} p.semester
 * @param {Array<{gradeYear?:number, className:string, seatNo:number, name:string, studentNumber:string, email?:string}>} p.students
 * @param {Array<{name:string, email:string, courses?:Array<{className:string, subject:string}>, homeroom?:string}>} p.teachers
 */
export async function importManualRoster(supabaseAdmin, { schoolId, schoolYear, semester, students, teachers }) {
  const nowIso = new Date().toISOString()
  const sy = Number(schoolYear) || null
  const sem = Number(semester) === 2 ? 2 : 1
  const errors = []

  // ── 1) 班級（由學生名冊與任課推得）──
  const classMap = new Map() // className → {gradeYear, count}
  for (const s of students) {
    const cn = norm(s.className); if (!cn) continue
    const c = classMap.get(cn) || { gradeYear: null, count: 0 }
    if (s.gradeYear != null && Number.isFinite(Number(s.gradeYear))) c.gradeYear = Number(s.gradeYear)
    c.count += 1
    classMap.set(cn, c)
  }
  for (const t of teachers) {
    for (const c of t.courses ?? []) { const cn = norm(c.className); if (cn && !classMap.has(cn)) classMap.set(cn, { gradeYear: null, count: 0 }) }
    if (t.homeroom && !classMap.has(norm(t.homeroom))) classMap.set(norm(t.homeroom), { gradeYear: null, count: 0 })
  }
  const homeroomByClass = new Map()
  for (const t of teachers) if (norm(t.homeroom)) homeroomByClass.set(norm(t.homeroom), t)
  const classRows = [...classMap.entries()].map(([cn, c]) => {
    const hr = homeroomByClass.get(cn)
    return {
      school_id: schoolId, campus_class_id: manualClassId(sy, cn), class_name: cn,
      grade_year: c.gradeYear, class_no: null, school_year: sy, semester: sem,
      teacher_name: hr ? norm(hr.name) || null : null, student_count: c.count, updated_at: nowIso,
      homeroom_teacher_id: hr ? manualTeacherId(hr.email) : null,
      homeroom_teacher_acc: hr ? lower(hr.email) || null : null,
      homeroom_teacher_name: hr ? norm(hr.name) || null : null,
    }
  })
  for (const part of chunk(classRows, 200)) {
    const { error } = await supabaseAdmin.from('school_classes').upsert(part, { onConflict: 'school_id,campus_class_id' })
    if (error) throw new Error('school_classes upsert failed: ' + error.message)
  }

  // ── 2) 學生（PK 學號；既有列沿用 id）──
  const { data: existing } = await supabaseAdmin.from('school_person').select('id, provider_student_id, status, student_number').eq('school_id', schoolId)
  const byPid = new Map((existing ?? []).filter((p) => p.provider_student_id).map((p) => [String(p.provider_student_id), p]))
  const seenPid = new Set()
  const personRows = []
  for (const s of students) {
    const sn = norm(s.studentNumber), cn = norm(s.className)
    if (!sn || !cn) { errors.push(`學生「${norm(s.name)}」缺學號或班級`); continue }
    const pid = manualStudentPid(sn)
    if (seenPid.has(pid)) { errors.push(`學號 ${sn} 重複`); continue }
    seenPid.add(pid)
    const cur = byPid.get(pid)
    personRows.push({
      id: cur?.id || 'sp_' + crypto.randomBytes(8).toString('hex'),
      school_id: schoolId, provider_student_id: pid,
      name: norm(s.name) || null, email: s.email && String(s.email).includes('@') ? lower(s.email) : null,
      student_number: sn, status: 'active', departed_status: null, parent_bound_count: null,
      campus_class_id: manualClassId(sy, cn), seat_no: Number.isFinite(Number(s.seatNo)) ? Number(s.seatNo) : null, last_seen_at: nowIso,
    })
  }
  for (const part of chunk(personRows, 500)) {
    const { error } = await supabaseAdmin.from('school_person').upsert(part, { onConflict: 'id' })
    if (error) throw new Error('school_person upsert failed: ' + error.message)
  }
  // 本次沒出現的 → inactive（畢業／轉出）
  const missing = (existing ?? []).filter((p) => p.provider_student_id && String(p.provider_student_id).startsWith('m:') && !seenPid.has(String(p.provider_student_id)) && (p.status ?? 'active') === 'active')
  for (const part of chunk(missing.map((p) => p.id), 200)) {
    await supabaseAdmin.from('school_person').update({ status: 'inactive', departed_status: '未在本次名冊' }).in('id', part)
  }

  // ── 3) 教師名冊＋任課 ──
  const teacherRows = [], courseRows = []
  for (const t of teachers) {
    const email = lower(t.email); if (!email || !email.includes('@')) { errors.push(`老師「${norm(t.name)}」Email 無效`); continue }
    const tid = manualTeacherId(email)
    teacherRows.push({ school_id: schoolId, campus_teacher_id: tid, teacher_name: norm(t.name) || null, teacher_acc: email, updated_at: nowIso })
    for (const c of t.courses ?? []) {
      const cn = norm(c.className), subj = norm(c.subject)
      if (!cn || !subj) continue
      courseRows.push({
        school_id: schoolId, campus_class_id: manualClassId(sy, cn), class_no: null, class_name: cn, course_name: `${cn} ${subj}`, subject: subj,
        campus_teacher_id: tid, teacher_acc: email, teacher_name: norm(t.name) || null,
        school_year: sy, semester: sem, source: 'manual', updated_at: nowIso,
      })
    }
  }
  for (const part of chunk(teacherRows, 200)) {
    const { error } = await supabaseAdmin.from('school_teacher_roster').upsert(part, { onConflict: 'school_id,campus_teacher_id' })
    if (error) throw new Error('school_teacher_roster upsert failed: ' + error.message)
  }
  // 任課：本學年學期的 manual 列先清再寫（以本次為準）
  await supabaseAdmin.from('school_class_courses').delete().eq('school_id', schoolId).eq('source', 'manual').eq('school_year', sy).eq('semester', sem)
  for (const part of chunk(courseRows, 200)) {
    const { error } = await supabaseAdmin.from('school_class_courses').upsert(part, { onConflict: 'school_id,campus_class_id,course_name,campus_teacher_id,school_year,semester' })
    if (error) throw new Error('school_class_courses upsert failed: ' + error.message)
  }

  // ── 4) 已登入過的老師：歸戶＋鏡像 ──
  const emails = teacherRows.map((t) => t.teacher_acc)
  let enrolled = 0, mirroredClasses = 0
  if (emails.length) {
    const { data: profs } = await supabaseAdmin.from('profiles').select('id, email').in('email', emails)
    for (const p of profs ?? []) {
      const r = await enrollAndMirror(supabaseAdmin, { schoolId, userId: p.id, email: lower(p.email) })
      if (r.enrolled) enrolled += 1
      mirroredClasses += r.classes
    }
  }
  return { classes: classRows.length, students: personRows.length, inactivated: missing.length, teachers: teacherRows.length, courses: courseRows.length, enrolled, mirroredClasses, errors }
}

/** 老師在該校被指派的班（任課 ∪ 導師） */
export async function assignedClassIds(supabaseAdmin, { schoolId, email }) {
  const acc = lower(email)
  const [{ data: courses }, { data: hr }] = await Promise.all([
    supabaseAdmin.from('school_class_courses').select('campus_class_id').eq('school_id', schoolId).eq('teacher_acc', acc),
    supabaseAdmin.from('school_classes').select('campus_class_id').eq('school_id', schoolId).eq('homeroom_teacher_acc', acc),
  ])
  return [...new Set([...(courses ?? []), ...(hr ?? [])].map((r) => String(r.campus_class_id)).filter(Boolean))]
}

async function enrollAndMirror(supabaseAdmin, { schoolId, userId, email }) {
  const { data: cur } = await supabaseAdmin.from('school_teachers').select('status').eq('school_id', schoolId).eq('teacher_user_id', userId).maybeSingle()
  const enrolled = !cur
  if (!cur) {
    const { error } = await supabaseAdmin.from('school_teachers').upsert({ school_id: schoolId, teacher_user_id: userId, status: 'active', source: 'manual' }, { onConflict: 'school_id,teacher_user_id', ignoreDuplicates: true })
    if (error) console.warn('[school-manual] enroll failed:', error.message)
  }
  const ids = await assignedClassIds(supabaseAdmin, { schoolId, email })
  let classes = 0
  if (ids.length) {
    try {
      const r = await mirrorSchoolClassesToOwner(supabaseAdmin, { schoolId, ownerId: userId, onlyClassIds: ids })
      classes = r.classes
    } catch (e) { console.warn('[school-manual] mirror failed:', e?.message) }
  }
  return { enrolled, classes }
}

// 登入時的自動歸戶：每位使用者 10 分鐘最多查一次
const lastCheck = new Map()
/** Google 登入的老師：Email 在任何手動學校的教師名冊 → 歸戶＋鏡像指派班。fail-open。 */
export async function enrollManualTeacherByEmail(supabaseAdmin, { userId, email }) {
  const acc = lower(email)
  if (!userId || !acc) return { schools: 0 }
  const ts = lastCheck.get(userId); if (ts && Date.now() - ts < 10 * 60e3) return { schools: 0, cached: true }
  lastCheck.set(userId, Date.now())
  try {
    const { data: rows, error } = await supabaseAdmin.from('school_teacher_roster').select('school_id').eq('teacher_acc', acc)
    if (error) throw error
    const sids = [...new Set((rows ?? []).map((r) => r.school_id))]
    if (!sids.length) return { schools: 0 }
    const { data: schools } = await supabaseAdmin.from('schools').select('id, provider_dsns').in('id', sids)
    let n = 0
    for (const s of schools ?? []) {
      if (s.provider_dsns) continue // 1Campus 校走 1Campus 登入歸戶
      await enrollAndMirror(supabaseAdmin, { schoolId: s.id, userId, email: acc }); n += 1
    }
    return { schools: n }
  } catch (e) {
    if (!isMissingTable(e)) console.warn('[school-manual] enrollByEmail failed:', e?.message)
    return { schools: 0 }
  }
}

export { upsertSchoolPersonsForClassroom }
