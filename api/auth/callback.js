import { handleCors } from '../../server/_cors.js'
import {
  parseCookies,
  getAuthCookieNames,
  clearOAuthCookies,
  setAuthCookies,
  exchangeCodeForSession,
  isSecureRequest
} from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

function getRequestOrigin(req) {
  const proto = req.headers?.['x-forwarded-proto'] || 'http'
  const host = req.headers?.host
  if (!host) return ''
  return `${proto}://${host}`
}

function getFrontendUrl(req) {
  return process.env.FRONTEND_URL || process.env.SITE_URL || getRequestOrigin(req)
}

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { code, error, error_description } = req.query || {}
  const codeValue = Array.isArray(code) ? code[0] : code
  if (error) {
    res.status(400).json({ error: error_description || error })
    return
  }

  if (!codeValue) {
    res.status(400).json({ error: 'Missing OAuth response' })
    return
  }

  const cookies = parseCookies(req)
  const { verifier: verifierCookie } = getAuthCookieNames()
  const verifier = cookies[verifierCookie]

  if (!verifier) {
    clearOAuthCookies(res, isSecureRequest(req))
    res.status(400).json({ error: 'Missing OAuth verifier' })
    return
  }

  try {
    const session = await exchangeCodeForSession(codeValue, verifier)
    clearOAuthCookies(res, isSecureRequest(req))

    const user = session.user
    if (!user) {
      res.status(500).json({ error: '登入失敗' })
      return
    }

    const supabaseAdmin = getSupabaseAdmin()
    const fullName =
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      ''
    const avatarUrl = user.user_metadata?.avatar_url || ''

    const nowIso = new Date().toISOString()

    const { data: existingProfile, error: existingError } = await supabaseAdmin
      .from('profiles')
      .select('id, role, permission_tier, ink_balance')
      .eq('id', user.id)
      .maybeSingle()

    if (existingError) {
      res.status(500).json({ error: '讀取使用者資料失敗' })
      return
    }

    let query
    if (existingProfile) {
      // 已存在的用戶：只更新基本資料，不覆蓋 role, permission_tier, ink_balance
      const updatePayload = {
        name: fullName,
        avatar_url: avatarUrl,
        updated_at: nowIso
      }
      query = supabaseAdmin.from('profiles').update(updatePayload).eq('id', user.id)
    } else {
      // 新用戶：創建完整的 profile
      const insertPayload = {
        id: user.id,
        email: user.email,
        name: fullName,
        avatar_url: avatarUrl,
        role: 'user',
        permission_tier: 'basic',
        ink_balance: 10,
        updated_at: nowIso
      }
      query = supabaseAdmin.from('profiles').insert(insertPayload)
    }

    const { error: profileError } = await query

    if (profileError) {
      res.status(500).json({ error: '建立使用者資料失敗' })
      return
    }

    setAuthCookies(res, session, isSecureRequest(req))

    const frontendUrl = getFrontendUrl(req)
    res.writeHead(302, { Location: frontendUrl || '/' })
    res.end()
  } catch (err) {
    clearOAuthCookies(res, isSecureRequest(req))
    res.status(500).json({ error: err instanceof Error ? err.message : '登入失敗' })
  }
}
