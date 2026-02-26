import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin, resetSupabaseClient } from '../../server/_supabase.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  try {
    const { user, accessToken } = await getAuthUser(req, res)
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    // 詳細記錄用戶資訊
    console.log('👤 用戶認證資訊:', {
      userId: user.id,
      email: user.email,
      hasAccessToken: !!accessToken,
      userKeys: Object.keys(user)
    })

    let profile = null
    let profileLoaded = false
    let profileError = null

    // 重試機制：最多重試 2 次
    const maxRetries = 2
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // 後端始終使用 service role key 繞過 RLS
        const supabaseDb = getSupabaseAdmin()

        if (attempt > 0) {
          console.log(`🔁 重試 profile 查詢 (第 ${attempt + 1} 次)`)
        } else {
          console.log('🔍 查詢 profile:', user.id)
        }

        // 詳細記錄查詢資訊
        console.log('📊 查詢詳情:', {
          userId: user.id,
          userIdType: typeof user.id,
          userIdLength: user.id?.length,
          clientCreatedAt: supabaseDb?._createdAt || 'unknown'
        })

        const { data, error } = await supabaseDb
          .from('profiles')
          .select('name, avatar_url, role, permission_tier, ink_balance')
          .eq('id', user.id)
          .maybeSingle()

        // 詳細記錄查詢結果
        console.log('📊 查詢結果:', {
          hasData: !!data,
          hasError: !!error,
          dataKeys: data ? Object.keys(data) : [],
          errorCode: error?.code,
          errorMessage: error?.message
        })

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
          console.log('✅ Profile 載入成功:', {
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
          console.warn('⚠️ Profile 不存在於資料庫:', user.id)
          profileError = 'Profile not found'
          break // 沒有資料，不需重試
        }
      } catch (error) {
        console.error('❌ Profile 查詢例外:', {
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

    // 如果 profile 載入失敗，設定 Cache-Control 避免快取錯誤回應
    if (!profileLoaded) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    }

    res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        name: profile?.name || user.user_metadata?.full_name || user.user_metadata?.name || '',
        avatarUrl: profile?.avatar_url || user.user_metadata?.avatar_url || '',
        role: profile?.role || 'user',
        permissionTier: profile?.permission_tier || 'basic',
        inkBalance:
          profileLoaded && typeof profile?.ink_balance === 'number'
            ? profile.ink_balance
            : null
      },
      // 除錯資訊：讓前端知道是否從資料庫載入成功
      _debug: {
        profileLoaded,
        profileError,
        dataSource: profileLoaded ? 'database' : 'oauth_metadata',
        timestamp: Date.now() // 加入時間戳，幫助除錯
      }
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' })
  }
}
