import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin, resetSupabaseClient } from '../../server/_supabase.js'

function getAuthMeLogLevel() {
  const raw = String(process.env.AUTH_ME_LOG_LEVEL || '').trim().toLowerCase()
  if (raw === 'off' || raw === 'basic' || raw === 'detail') return raw
  return process.env.NODE_ENV === 'production' ? 'off' : 'basic'
}

function shouldLogAuthMe(configuredLevel, requiredLevel = 'basic') {
  if (configuredLevel === 'off') return false
  if (requiredLevel === 'detail') return configuredLevel === 'detail'
  return configuredLevel === 'basic' || configuredLevel === 'detail'
}

function logAuthMe(configuredLevel, message, payload, requiredLevel = 'basic') {
  if (!shouldLogAuthMe(configuredLevel, requiredLevel)) return
  if (payload === undefined) {
    console.log(`[AUTH-ME][${requiredLevel}] ${message}`)
    return
  }
  console.log(`[AUTH-ME][${requiredLevel}] ${message}`, payload)
}

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  try {
    const authMeLogLevel = getAuthMeLogLevel()
    const { user, accessToken } = await getAuthUser(req, res)
    if (!user) {
      res.status(200).json({ user: null })
      return
    }

    logAuthMe(authMeLogLevel, 'authenticated user', {
      userId: user.id,
      email: user.email,
      hasAccessToken: !!accessToken
    })

    let profile = null
    let profileLoaded = false
    let profileError = null
    let studentContext = null
    let studentContexts = []

    // 重試機制：最多重試 2 次
    const maxRetries = 2
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // 後端始終使用 service role key 繞過 RLS
        const supabaseDb = getSupabaseAdmin()

        if (attempt > 0) {
          logAuthMe(authMeLogLevel, `profile query retry=${attempt + 1}`, {
            userId: user.id
          })
        }

        logAuthMe(authMeLogLevel, 'profile query start', {
          userId: user.id,
          attempt: attempt + 1
        }, 'detail')

        const { data, error } = await supabaseDb
          .from('profiles')
          .select('name, avatar_url, role, permission_tier, ink_balance')
          .eq('id', user.id)
          .maybeSingle()

        logAuthMe(authMeLogLevel, 'profile query result', {
          userId: user.id,
          attempt: attempt + 1,
          hasData: !!data,
          hasError: !!error,
          errorCode: error?.code,
          errorMessage: error?.message
        }, 'detail')

        if (error) {
          console.error('❌ Profile 查詢失敗:', {
            userId: user.id,
            attempt: attempt + 1,
            error: error.message,
            code: error.code,
            details: error.details,
            hint: error.hint
          })
          profileError = error.message

          // 如果是連線錯誤且還有重試次數，重置 client 後重試
          if (attempt < maxRetries - 1 && isConnectionError(error)) {
            console.log('🔄 偵測到連線錯誤，重置 Supabase client 後重試')
            resetSupabaseClient()
            await new Promise(resolve => setTimeout(resolve, 100)) // 延遲 100ms
            continue
          }
        } else if (data) {
          logAuthMe(authMeLogLevel, 'profile loaded', {
            userId: user.id,
            attempt: attempt > 0 ? attempt + 1 : 1,
            hasName: !!data.name,
            hasRole: !!data.role,
            inkBalance: data.ink_balance
          })

          // 清理資料：移除換行符號和多餘空白
          profile = {
            name: data.name?.trim(),
            avatar_url: data.avatar_url?.trim(),
            role: data.role?.trim()?.toLowerCase(),
            permission_tier: data.permission_tier?.trim()?.toLowerCase(),
            ink_balance: data.ink_balance
          }

          profileLoaded = true
          break // 成功，跳出重試迴圈
        } else {
          console.warn('[AUTH-ME] profile not found', user.id)
          profileError = 'Profile not found'
          // null 可能是 Supabase 瞬斷而非真的沒有 profile，允許重試
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, 200))
            continue
          }
          break
        }
      } catch (error) {
        console.error('[AUTH-ME] profile query exception', {
          userId: user.id,
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        })
        profileError = error instanceof Error ? error.message : 'Unknown error'

        // 如果是連線錯誤且還有重試次數，重置 client 後重試
        if (attempt < maxRetries - 1 && error instanceof Error && isConnectionError(error)) {
          console.log('🔄 偵測到連線例外，重置 Supabase client 後重試')
          resetSupabaseClient()
          await new Promise(resolve => setTimeout(resolve, 100))
          continue
        }

        profile = null
        profileLoaded = false
        break
      }
    }

    // 輔助函數：判斷是否為連線錯誤
    function isConnectionError(error) {
      const message = error.message?.toLowerCase() || ''
      return (
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('connection') ||
        message.includes('econnrefused') ||
        message.includes('fetch')
      )
    }

    try {
      const supabaseDb = getSupabaseAdmin()
      const normalizedEmail =
        typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
      const hasValidStudentEmail = (row) => {
        const studentEmail =
          typeof row?.email === 'string' ? row.email.trim().toLowerCase() : ''
        return Boolean(normalizedEmail) && Boolean(studentEmail) && studentEmail === normalizedEmail
      }

      // 同時查詢 auth_user_id 和 email 匹配的所有學生記錄（支援多教室）
      const [linkedByAuthIdResult, linkedByEmailResult] = await Promise.all([
        supabaseDb
          .from('students')
          .select('id, classroom_id, seat_number, name, owner_id, email, auth_user_id, updated_at')
          .eq('auth_user_id', user.id)
          .order('updated_at', { ascending: false }),
        normalizedEmail
          ? supabaseDb
              .from('students')
              .select('id, classroom_id, seat_number, name, owner_id, email, auth_user_id, updated_at')
              .eq('email', normalizedEmail)
              .order('updated_at', { ascending: false })
          : Promise.resolve({ data: [], error: null })
      ])

      if (linkedByAuthIdResult.error) {
        console.warn('⚠️ 讀取學生關聯失敗(auth_user_id):', linkedByAuthIdResult.error.message)
      }
      if (linkedByEmailResult.error) {
        console.warn('⚠️ 讀取學生關聯失敗(email):', linkedByEmailResult.error.message)
      }

      // 用 Map 根據 owner_id::id 去重合併
      const mergedRows = new Map()
      // auth_user_id 匹配：不需 email 驗證（1Campus SSO 綁定的學生沒有匹配 email）
      for (const row of linkedByAuthIdResult.data || []) {
        mergedRows.set(`${row.owner_id}::${row.id}`, row)
      }
      // email 匹配：需要 email 驗證
      for (const row of linkedByEmailResult.data || []) {
        if (!hasValidStudentEmail(row)) continue
        mergedRows.set(`${row.owner_id}::${row.id}`, row)
      }

      // 1Campus 學生帳號備用匹配：虛擬 email 格式為 campus1.{account}@{dsns}
      // 學生在 students 表的 email 格式通常為 {account}@smail.{dsns}
      // 例如 campus1.webber0610@hc.edu.tw → webber0610@smail.hc.edu.tw
      if (mergedRows.size === 0 && normalizedEmail.startsWith('campus1.') && normalizedEmail.includes('@')) {
        const atIdx = normalizedEmail.indexOf('@')
        const localPart = normalizedEmail.slice(0, atIdx)       // 'campus1.webber0610'
        const domain = normalizedEmail.slice(atIdx + 1)         // 'hc.edu.tw'
        const account = localPart.slice('campus1.'.length)      // 'webber0610'
        const smailEmail = `${account}@smail.${domain}`         // 'webber0610@smail.hc.edu.tw'
        const { data: smailRows } = await supabaseDb
          .from('students')
          .select('id, classroom_id, seat_number, name, owner_id, email, auth_user_id, updated_at')
          .eq('email', smailEmail)
          .order('updated_at', { ascending: false })
        for (const row of smailRows || []) {
          mergedRows.set(`${row.owner_id}::${row.id}`, row)
        }
        if ((smailRows || []).length > 0) {
          console.log(`[AUTH-ME] 1campus smail fallback matched ${smailRows.length} student(s) for ${smailEmail}`)
        }
      }

      const linkedStudents = Array.from(mergedRows.values())
        .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())

      // 批次綁定 auth_user_id（所有缺少綁定的記錄）
      const bindTargets = linkedStudents.filter((row) => row.auth_user_id !== user.id)
      if (bindTargets.length) {
        const nowIso = new Date().toISOString()
        const bindResults = await Promise.all(
          bindTargets.map((row) =>
            supabaseDb
              .from('students')
              .update({
                auth_user_id: user.id,
                updated_at: nowIso
              })
              .eq('id', row.id)
              .eq('owner_id', row.owner_id)
          )
        )
        const bindError = bindResults.find((r) => r.error)
        if (bindError?.error) {
          console.warn('⚠️ 學生 email 綁定 auth_user_id 失敗:', bindError.error.message)
        }
      }

      // 建立 studentContexts 陣列
      studentContexts = linkedStudents.map((s) => ({
        id: s.id,
        classroomId: s.classroom_id,
        seatNumber: s.seat_number,
        name: s.name,
        ownerId: s.owner_id,
        email: s.email ?? null
      }))

      // studentContext = 第一筆（向後相容）
      studentContext = studentContexts[0] || null
    } catch (studentResolveError) {
      console.warn('⚠️ 讀取學生關聯例外:', studentResolveError)
    }

    const profileRole = profile?.role || 'user'
    const resolvedRole =
      profileRole === 'admin'
        ? 'admin'
        : studentContext
          ? 'student'
          : profileRole

    let campus1Binding = null
    try {
      const supabaseDb = getSupabaseAdmin()
      const { data: campus1Data } = await supabaseDb
        .from('external_identities')
        .select('provider_account, provider_dsns, provider_meta')
        .eq('user_id', user.id)
        .eq('provider', 'campus1')
        .maybeSingle()

      if (campus1Data) {
        campus1Binding = {
          account: campus1Data.provider_account,
          dsns: campus1Data.provider_dsns,
          displayName: campus1Data.provider_meta?.displayName || '',
          roleType: campus1Data.provider_meta?.roleType || ''
        }
      }
    } catch (err) {
      console.warn('[AUTH-ME] campus1 binding query failed:', err?.message)
    }

    // 永遠不快取 /auth/me 回應，避免瞬斷的失敗結果被快取住
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')

    res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        name: profile?.name || user.user_metadata?.full_name || user.user_metadata?.name || '',
        avatarUrl: profile?.avatar_url || user.user_metadata?.avatar_url || '',
        role: resolvedRole,
        permissionTier: profile?.permission_tier || 'basic',
        inkBalance:
          profileLoaded && typeof profile?.ink_balance === 'number'
            ? profile.ink_balance
            : null,
        student: studentContext ?? undefined,
        students: studentContexts.length ? studentContexts : undefined,
        campus1Binding: campus1Binding ?? undefined
      },
      // 除錯資訊：讓前端知道是否從資料庫載入成功
      _debug: {
        profileLoaded,
        profileError,
        hasStudentContext: !!studentContext,
        dataSource: profileLoaded ? 'database' : 'oauth_metadata',
        timestamp: Date.now() // 加入時間戳，幫助除錯
      }
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' })
  }
}
