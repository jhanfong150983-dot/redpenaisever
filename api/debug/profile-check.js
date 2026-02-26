import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  try {
    const { user } = await getAuthUser(req, res)
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const supabaseDb = getSupabaseAdmin()

    // 測試 1: 檢查環境變數
    const hasServiceKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY
    const hasUrl = !!process.env.SUPABASE_URL

    // 測試 2: 查詢所有 profiles (不過濾，看看總共有多少)
    const { data: allProfiles, error: allError } = await supabaseDb
      .from('profiles')
      .select('id, email, ink_balance')
      .limit(10)

    // 測試 3: 查詢當前用戶的 profile
    const { data: myProfile, error: myError } = await supabaseDb
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle()

    // 測試 4: 直接從 auth.users 查詢用戶
    const { data: authUser, error: authError } = await supabaseDb.auth.admin.getUserById(user.id)

    res.status(200).json({
      userId: user.id,
      email: user.email,
      checks: {
        hasServiceKey,
        hasUrl,
        serviceKeyLength: process.env.SUPABASE_SERVICE_ROLE_KEY?.length || 0
      },
      allProfiles: {
        count: allProfiles?.length || 0,
        error: allError?.message || null,
        data: allProfiles
      },
      myProfile: {
        found: !!myProfile,
        error: myError?.message || null,
        data: myProfile
      },
      authUser: {
        found: !!authUser,
        error: authError?.message || null
      }
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Server error',
      stack: err instanceof Error ? err.stack : undefined
    })
  }
}
