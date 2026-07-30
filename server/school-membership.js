import crypto from 'node:crypto'

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
    const { data: studs } = await supabaseAdmin
      .from('students')
      .select('id, name, email, provider_student_id, student_number')
      .eq('classroom_id', classroomId)
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
          student_number: s.student_number ?? null,
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

    const linkRows = withPid
      .map((s) => {
        const personId = personByPid.get(String(s.provider_student_id))
        return personId
          ? { student_id: s.id, person_id: personId, match_source: 'provider_student_id', confidence: 'auto' }
          : null
      })
      .filter(Boolean)
    if (linkRows.length) {
      const { error: linkErr } = await supabaseAdmin
        .from('student_person_link')
        .upsert(linkRows, { onConflict: 'student_id', ignoreDuplicates: true })
      if (linkErr) console.warn('[school-person] link upsert failed:', linkErr.message)
    }
    return { persons: newRows.length, links: linkRows.length }
  } catch (e) {
    console.warn('[school-person] pipeline failed:', e?.message)
    return { persons: 0, links: 0 }
  }
}
