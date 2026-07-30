import crypto from 'node:crypto'
import {
  getJasmineAccessToken,
  fetchCampus1ClassStudents,
  fetchCampus1StudentDeparted
} from './_1campus.js'

function toIntOrNull(v) {
  const n = parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? n : null
}

function chunkArray(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// PostgREST 預設 1000 筆 cap:整校 person(關埔 ~1,900)必須分頁撈
async function fetchAllPersonRows(supabaseAdmin, schoolId) {
  const all = []
  const pageSize = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('school_person')
      .select('id, provider_student_id, name, email, student_number, status, parent_bound_count')
      .eq('school_id', schoolId)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error('school_person select failed: ' + error.message)
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  return all
}

// 2026-07-25 學校端子計畫1:1Campus 老師自動歸校(school_teachers)。
// 規則(user 拍板):學校功能=1Campus 連動學校專屬——dsns 找得到 schools 列才歸,
// 找不到=該校尚未導入、靜默跳過;個人用戶不受影響。
// fail-open:歸校失敗絕不影響登入/同步主流程(只 warn)。
// onConflict ignoreDuplicates:已存在(含後台設為 removed 的)一律不動——被移除的老師不會被自動復活。
export async function enrollSchoolTeacher(supabaseAdmin, { userId, dsns, schoolId }) {
  try {
    if (!userId) return
    let sid = schoolId ?? null
    if (!sid && dsns) {
      const { data } = await supabaseAdmin
        .from('schools')
        .select('id')
        .eq('provider_dsns', dsns)
        .limit(1)
      sid = data?.[0]?.id ?? null
    }
    if (!sid) return
    const { error } = await supabaseAdmin
      .from('school_teachers')
      .upsert(
        { school_id: sid, teacher_user_id: userId, status: 'active', source: 'campus1' },
        { onConflict: 'school_id,teacher_user_id', ignoreDuplicates: true }
      )
    if (error) console.warn('[school-teachers] enroll upsert failed:', error.message)
  } catch (e) {
    console.warn('[school-teachers] enroll failed:', e?.message)
  }
}

// 2026-07-30 學校端子計畫2:學生歸戶管線(school_person + student_person_link)。
// 規則=production 既有慣例:「同校同 provider_student_id=同一人」、match_source='provider_student_id'、
// confidence='auto'、person id 格式 sp_<16hex>。原歸戶只做過一次性 backfill(程式不在 repo)、
// 新同步學生從此自動歸戶。冪等:person 靠唯一索引 (school_id, provider_student_id) upsert、
// link 靠 PK student_id ignoreDuplicates(既有連結一律不動)。fail-open 不影響同步主流程。
export async function upsertSchoolPersonsForClassroom(supabaseAdmin, { schoolId, classroomId }) {
  try {
    if (!schoolId || !classroomId) return { persons: 0, links: 0 }
    // ⚠ production students 表沒有 student_number 欄位(2026-07-30 實測 400)——不可 select 它
    const { data: studs, error: selErr } = await supabaseAdmin
      .from('students')
      .select('id, name, email, provider_student_id')
      .eq('classroom_id', classroomId)
    if (selErr) { console.warn('[school-person] students select failed:', selErr.message); return { persons: 0, links: 0 } }
    const withPid = (studs ?? []).filter((s) => s.provider_student_id != null && String(s.provider_student_id).trim() !== '')
    if (!withPid.length) return { persons: 0, links: 0 }

    // 以 pid 去重後 upsert school_person(已存在者僅回讀 id、不覆寫既有資料)
    const byPid = new Map()
    for (const s of withPid) {
      const pid = String(s.provider_student_id)
      if (!byPid.has(pid)) byPid.set(pid, s)
    }
    const pids = [...byPid.keys()]
    const { data: existing } = await supabaseAdmin
      .from('school_person')
      .select('id, provider_student_id')
      .eq('school_id', schoolId)
      .in('provider_student_id', pids)
    const personByPid = new Map((existing ?? []).map((p) => [String(p.provider_student_id), p.id]))

    const newRows = pids
      .filter((pid) => !personByPid.has(pid))
      .map((pid) => {
        const s = byPid.get(pid)
        return {
          id: 'sp_' + crypto.randomBytes(8).toString('hex'),
          school_id: schoolId,
          name: s.name ?? null,
          provider_student_id: pid,
          email: s.email ?? null,
          status: 'active',
        }
      })
    if (newRows.length) {
      // 唯一索引 (school_id, provider_student_id) 防併發重複;衝突=別的同步剛建好 → 忽略後回讀
      const { error: insErr } = await supabaseAdmin
        .from('school_person')
        .upsert(newRows, { onConflict: 'school_id,provider_student_id', ignoreDuplicates: true })
      if (insErr) console.warn('[school-person] upsert failed:', insErr.message)
      const { data: refreshed } = await supabaseAdmin
        .from('school_person')
        .select('id, provider_student_id')
        .eq('school_id', schoolId)
        .in('provider_student_id', pids)
      for (const p of refreshed ?? []) personByPid.set(String(p.provider_student_id), p.id)
    }

    // 2026-07-30 連結自愈:students 列的比對鍵是座號,學期中名冊重排時同一列可能換人
    // (學號被同步刷新)——自動建立的既有連結若 person 學號≠此列現在的學號,跟著現況改指;
    // 人工確認過的連結(confidence≠'auto')永不自動改動。
    const { data: existingLinks } = await supabaseAdmin
      .from('student_person_link')
      .select('student_id, person_id, confidence')
      .in('student_id', withPid.map((s) => s.id))
    const linkByStudent = new Map((existingLinks ?? []).map((l) => [l.student_id, l]))

    const newLinks = []
    let healed = 0
    for (const s of withPid) {
      const personId = personByPid.get(String(s.provider_student_id))
      if (!personId) continue
      const cur = linkByStudent.get(s.id)
      if (!cur) {
        newLinks.push({ student_id: s.id, person_id: personId, match_source: 'provider_student_id', confidence: 'auto' })
      } else if (cur.person_id !== personId && cur.confidence === 'auto') {
        const { error: healErr } = await supabaseAdmin
          .from('student_person_link')
          .update({ person_id: personId, match_source: 'provider_student_id', confidence: 'auto' })
          .eq('student_id', s.id)
        if (healErr) console.warn('[school-person] link heal failed:', healErr.message)
        else healed += 1
      }
    }
    if (newLinks.length) {
      const { error: linkErr } = await supabaseAdmin
        .from('student_person_link')
        .upsert(newLinks, { onConflict: 'student_id', ignoreDuplicates: true })
      if (linkErr) console.warn('[school-person] link upsert failed:', linkErr.message)
    }
    return { persons: newRows.length, links: newLinks.length, healed }
  } catch (e) {
    console.warn('[school-person] pipeline failed:', e?.message)
    return { persons: 0, links: 0, healed: 0 }
  }
}

// ============================================================
// 2026-07-30 Step 3.5:行政端全校名冊同步
// getClassStudent(不帶參數)一次拿全校班級+學生 → school_classes 參考表 + school_person SSoT。
// 邊界(user 拍板):不代建老師的 classrooms/students(老師同步時按學號自動 link 收斂);
// 全校同步是姓名/email 的權威來源(老師管線只建不改);轉出=getStudentDeparted 權威清查、
// 只標記 status='inactive'+departed_status、永不刪除;復學(重新出現在名冊)自動翻回 active。
// ============================================================
export async function syncSchoolRoster(supabaseAdmin, { schoolId, dsns }) {
  const token = await getJasmineAccessToken()
  const classes = await fetchCampus1ClassStudents(dsns, token)
  const nowIso = new Date().toISOString()

  // 1) 彙整班級與學生(pid 去重;同生多班取先見的資料)
  const classRows = []
  const studentByPid = new Map()
  let parentFieldPresent = false
  for (const cls of classes) {
    const classId = String(cls.classID ?? '').trim()
    if (!classId) continue
    const students = Array.isArray(cls.student) ? cls.student : []
    const semesterNum = toIntOrNull(cls.semester)
    classRows.push({
      school_id: schoolId,
      campus_class_id: classId,
      class_name: String(cls.className || '').trim() || null,
      grade_year: toIntOrNull(cls.gradeYear),
      class_no: cls.classNo != null ? String(cls.classNo).trim() || null : null,
      school_year: toIntOrNull(cls.schoolYear),
      semester: semesterNum === 1 || semesterNum === 2 ? semesterNum : null,
      teacher_name: String(cls.teacher?.teacherName || '').trim() || null,
      student_count: students.length,
      updated_at: nowIso
    })
    for (const s of students) {
      const pid = s.studentID != null && String(s.studentID).trim() ? String(s.studentID).trim() : null
      if (!pid) continue
      if (Array.isArray(s.parent)) parentFieldPresent = true
      if (!studentByPid.has(pid)) {
        studentByPid.set(pid, {
          name: String(s.studentName || '').trim() || null,
          email: s.email && String(s.email).includes('@') ? String(s.email).trim().toLowerCase() : null,
          studentNumber: s.studentNumber != null && String(s.studentNumber).trim() ? String(s.studentNumber).trim() : null,
          parentCount: Array.isArray(s.parent) ? s.parent.length : null,
          // 目前在籍班籍(getClassStudent 一生一班):學校檢視班級名冊靠它
          classId,
          seatNo: toIntOrNull(s.seatNo)
        })
      }
    }
  }

  // 2) 班級參考表整批 upsert(PK=school_id+campus_class_id)
  for (const chunk of chunkArray(classRows, 200)) {
    const { error } = await supabaseAdmin
      .from('school_classes')
      .upsert(chunk, { onConflict: 'school_id,campus_class_id' })
    if (error) throw new Error('school_classes upsert failed: ' + error.message)
  }

  // 3) person upsert:既有列沿用原 id(links 引用它、絕不能換),新列生成 sp_ id
  const existing = await fetchAllPersonRows(supabaseAdmin, schoolId)
  const personByPid = new Map(
    existing.filter((p) => p.provider_student_id != null).map((p) => [String(p.provider_student_id), p])
  )
  const upsertRows = []
  let newCount = 0
  let reactivated = 0
  for (const [pid, s] of studentByPid) {
    const cur = personByPid.get(pid)
    if (!cur) {
      newCount += 1
      upsertRows.push({
        id: 'sp_' + crypto.randomBytes(8).toString('hex'),
        school_id: schoolId,
        provider_student_id: pid,
        name: s.name,
        email: s.email,
        student_number: s.studentNumber,
        status: 'active',
        departed_status: null,
        parent_bound_count: s.parentCount,
        campus_class_id: s.classId ?? null,
        seat_no: s.seatNo,
        last_seen_at: nowIso
      })
    } else {
      if (cur.status && cur.status !== 'active') reactivated += 1
      upsertRows.push({
        id: cur.id,
        school_id: schoolId,
        provider_student_id: pid,
        name: s.name ?? cur.name,
        email: s.email ?? cur.email,
        student_number: s.studentNumber ?? cur.student_number,
        status: 'active',
        departed_status: null,
        parent_bound_count: s.parentCount ?? cur.parent_bound_count,
        campus_class_id: s.classId ?? null,
        seat_no: s.seatNo,
        last_seen_at: nowIso
      })
    }
  }
  for (const chunk of chunkArray(upsertRows, 500)) {
    const { error } = await supabaseAdmin.from('school_person').upsert(chunk, { onConflict: 'id' })
    if (error) throw new Error('school_person upsert failed: ' + error.message)
  }

  // 4) 轉出清查:DB 有、本次全校名冊沒出現 → getStudentDeparted 權威確認才標記(fail-open)
  const missing = existing.filter(
    (p) => p.provider_student_id != null && !studentByPid.has(String(p.provider_student_id))
  )
  let departedMarked = 0
  if (missing.length) {
    try {
      const ids = missing
        .map((p) => Number(p.provider_student_id))
        .filter((n) => Number.isFinite(n))
      const departed = []
      for (const chunk of chunkArray(ids, 100)) {
        departed.push(...(await fetchCampus1StudentDeparted(dsns, chunk, token)))
      }
      const depByPid = new Map(departed.map((d) => [String(d.studentID), d]))
      for (const p of missing) {
        const d = depByPid.get(String(p.provider_student_id))
        if (!d) continue
        const { error } = await supabaseAdmin
          .from('school_person')
          .update({ status: 'inactive', departed_status: String(d.status || '').trim() || null })
          .eq('id', p.id)
        if (error) console.warn('[roster-sync] mark departed failed:', error.message)
        else departedMarked += 1
      }
    } catch (e) {
      console.warn('[roster-sync] departed check failed (non-blocking):', e?.message)
    }
  }

  const parentBound = [...studentByPid.values()].filter((s) => (s.parentCount ?? 0) > 0).length
  return {
    classes: classRows.length,
    studentsSeen: studentByPid.size,
    newPersons: newCount,
    reactivated,
    missingChecked: missing.length,
    departedMarked,
    parentFieldPresent,
    parentBound
  }
}
