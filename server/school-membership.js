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
