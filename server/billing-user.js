/**
 * billing-user.js
 *
 * 決定一個 AI 呼叫應該扣誰的墨水。
 *
 * 設計原則（2026-05-15 確立）：
 *   - 老師付費、學生免費
 *   - 學生呼叫 AI 時，墨水成本要記到該學生的「擁有老師」帳上
 *   - 老師 / admin 呼叫 AI 時，墨水成本扣自己
 *
 * 判別方式：
 *   `students.auth_user_id` 是學生綁定的 Supabase auth user id。
 *   如果認證的 user.id 在這欄位裡找得到 → 是學生，billingUserId = students.owner_id（老師）
 *   否則 → 是老師 / admin，billingUserId = user.id（自己）
 *
 * 注意：role 欄位無法區分（學生跟老師目前都是 'user'），必須走 students 表查。
 */

/**
 * @param {object} supabaseAdmin - service-role supabase client
 * @param {string} authUserId   - 來自 getAuthUser 的 user.id
 * @returns {Promise<{
 *   billingUserId: string,   // 真正要扣墨水的 profile.id
 *   actorUserId: string,     // 實際發出 request 的 user.id（學生時跟 billingUserId 不同）
 *   isStudent: boolean,      // 是否為學生身分（決定 ledger metadata）
 * }>}
 */
export async function resolveBillingUserId(supabaseAdmin, authUserId) {
  if (!authUserId) {
    throw new Error('resolveBillingUserId: authUserId is required')
  }

  const { data: studentRow, error } = await supabaseAdmin
    .from('students')
    .select('owner_id')
    .eq('auth_user_id', authUserId)
    .not('owner_id', 'is', null)
    .limit(1)
    .maybeSingle()

  if (error) {
    // 查不到 / DB 錯誤都當成「不是學生」處理，讓老師/admin 流程繼續走
    // 學生失敗會在後續 balance 檢查時被擋下（balance=0、無 session），不會誤扣
    console.warn('[billing-user] resolve failed, fallback to self-billing:', error.message)
    return { billingUserId: authUserId, actorUserId: authUserId, isStudent: false }
  }

  if (studentRow?.owner_id) {
    return {
      billingUserId: studentRow.owner_id,
      actorUserId: authUserId,
      isStudent: true,
    }
  }

  return { billingUserId: authUserId, actorUserId: authUserId, isStudent: false }
}
