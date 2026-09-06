// 2026-09-06 建卷 AI 週上限（免費但鎖次數）——user 拍板。
//   目的：建卷/解析不扣點數(免費)，但每個 AI 建卷 run 都燒成本；用「每週次數上限」擋 bug/濫用、封頂成本。
//   計數對象＝建卷相關 route（解析題本 locate、擷取答案 extract、重解析 reanalyze、生成卷解題 solve、讀參考 read_reference）。
//     ⚠ reanalyze(重解析) 是獨立 route，一定要納入否則重解析漏記。KP(tag_concepts) 不計＝免費。
//   角色：系統 admin(開發者) 不限；學校行政(school_admins) 高上限；一般老師低上限。
//   視窗：每週一 00:00（台灣時區）滾動歸零——用 created_at >= 本週一，不需排程。
import { getSupabaseAdmin } from './_supabase.js'

export const BUILD_ROUTES = [
  'answer_key.locate',
  'answer_key.extract',
  'answer_key.reanalyze',
  'answer_key.solve',
  'answer_key.read_reference',
]
export const TEACHER_WEEKLY_BUILD_CAP = 10 // 科任/個人：≈5 份（1 份 2 run）＋重解析餘裕
export const ADMIN_WEEKLY_BUILD_CAP = 80   // 學校行政：一次設多年級全科綽綽有餘

export function isBuildRoute(routeKey) {
  return typeof routeKey === 'string' && BUILD_ROUTES.includes(routeKey)
}

/** 本週一 00:00（台灣 UTC+8）對應的 UTC ISO 字串 */
function weekStartUtcISO() {
  const now = Date.now()
  const tw = new Date(now + 8 * 3600 * 1000) // 位移到台灣牆上時鐘（以 UTC 欄位表示）
  const daysSinceMon = (tw.getUTCDay() + 6) % 7 // 週一=0
  const monTwWall = Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate() - daysSinceMon, 0, 0, 0, 0)
  return new Date(monTwWall - 8 * 3600 * 1000).toISOString() // 換回真實 UTC
}

/**
 * 回傳某 user 的本週建卷額度狀態。
 * { used, cap, remaining, isSchoolAdmin, unlimited }
 *   unlimited=true（系統 admin）時 cap/remaining 為 null。
 */
export async function getBuildQuota(userId, supabaseAdmin = getSupabaseAdmin()) {
  // 系統 admin（開發者，profiles.role='admin'）不限
  let isSystemAdmin = false
  try {
    const { data: prof } = await supabaseAdmin.from('profiles').select('role').eq('id', userId).maybeSingle()
    isSystemAdmin = String(prof?.role || '').trim().toLowerCase() === 'admin'
  } catch { /* fail-open：查不到當非 admin */ }
  if (isSystemAdmin) return { used: 0, cap: null, remaining: null, isSchoolAdmin: false, unlimited: true }

  // 學校行政（school_admins 有掛）→ 高上限
  let isSchoolAdmin = false
  try {
    const { data: sa } = await supabaseAdmin.from('school_admins').select('school_id').eq('profile_id', userId).limit(1)
    isSchoolAdmin = Array.isArray(sa) && sa.length > 0
  } catch { /* fail-open */ }
  const cap = isSchoolAdmin ? ADMIN_WEEKLY_BUILD_CAP : TEACHER_WEEKLY_BUILD_CAP

  let used = 0
  try {
    const { count } = await supabaseAdmin
      .from('ink_session_usage')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('route_key', BUILD_ROUTES)
      .gte('created_at', weekStartUtcISO())
    used = count ?? 0
  } catch { /* fail-open：查不到當 0（不誤擋） */ }

  return { used, cap, remaining: Math.max(0, cap - used), isSchoolAdmin, unlimited: false }
}
