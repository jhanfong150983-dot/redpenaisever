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

function sanitizeEnvUrl(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function isLocalHostname(hostname) {
  const value = String(hostname || '').trim().toLowerCase()
  return value === 'localhost' || value === '127.0.0.1'
}

function replaceHostnameKeepingPort(url, hostname) {
  const parsed = new URL(url)
  parsed.hostname = hostname
  return parsed.toString().replace(/\/$/, '')
}

function getFrontendUrl(req) {
  const frontendUrl = sanitizeEnvUrl(process.env.FRONTEND_URL)
  const requestOrigin = getRequestOrigin(req)
  const requestHost = String(req.headers?.host || '')

  let requestHostname = ''
  try {
    requestHostname = new URL(requestOrigin).hostname
  } catch {
    requestHostname = requestHost.split(':')[0] || ''
  }

  if (frontendUrl) {
    try {
      const parsedFrontend = new URL(frontendUrl)
      if (isLocalHostname(parsedFrontend.hostname) && !isLocalHostname(requestHostname)) {
        return replaceHostnameKeepingPort(frontendUrl, requestHostname)
      }
      return frontendUrl
    } catch {
      return frontendUrl
    }
  }

  const siteUrl = sanitizeEnvUrl(process.env.SITE_URL)
  if (siteUrl) {
    try {
      const parsedSite = new URL(siteUrl)
      if (isLocalHostname(parsedSite.hostname) && !isLocalHostname(requestHostname)) {
        return replaceHostnameKeepingPort(siteUrl, requestHostname)
      }
      return siteUrl
    } catch {
      return siteUrl
    }
  }

  // 開發環境保險：若未設定 FRONTEND_URL，且目前是本地後端，預設導回 Vite 前端
  if (isLocalHostname(requestHostname) && requestHost.includes(':3000')) {
    return 'http://localhost:5173'
  }

  return requestOrigin
}

function normalizeEntry(rawValue) {
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized === 'teacher' || normalized === 'student') return normalized
  return ''
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie')
  if (!existing) {
    res.setHeader('Set-Cookie', [cookie])
    return
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie])
    return
  }
  res.setHeader('Set-Cookie', [existing, cookie])
}

function serializeClearLoginEntryCookie(secure) {
  const sameSite = String(process.env.AUTH_COOKIE_SAME_SITE || 'Lax').trim() || 'Lax'
  const domain = (process.env.AUTH_COOKIE_DOMAIN || '').trim()
  const effectiveSecure = sameSite.toLowerCase() === 'none' ? true : secure
  const parts = [
    'rp-login-entry=',
    'Max-Age=0',
    'Path=/',
    `SameSite=${sameSite}`
  ]
  if (domain) parts.push(`Domain=${domain}`)
  if (effectiveSecure) parts.push('Secure')
  parts.push('HttpOnly')
  return parts.join('; ')
}

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  // 1Campus OAuth callback 偵測：
  // 1Campus 廠商登記的 callback URL 是 /api/auth/callback，
  // 透過偵測 rp-campus1-state cookie 判斷是否為 1Campus 流程，
  // 若是則將所有 query 參數轉交 1Campus handler。
  const routingCookies = parseCookies(req)
  if (routingCookies['rp-campus1-state']) {
    const params = new URLSearchParams()
    const query = req.query || {}
    for (const [key, val] of Object.entries(query)) {
      params.set(key, Array.isArray(val) ? val[0] : String(val))
    }
    params.set('__step', 'oauth_callback')
    res.writeHead(302, { Location: `/api/auth/1campus?${params.toString()}` })
    res.end()
    return
  }

  const { code, error, error_description } = req.query || {}
  const codeValue = Array.isArray(code) ? code[0] : code
  const cookies = parseCookies(req)
  const entry = normalizeEntry(req.query?.entry) || normalizeEntry(cookies['rp-login-entry'])
  if (error) {
    res.status(400).json({ error: error_description || error })
    return
  }

  if (!codeValue) {
    res.status(400).json({ error: 'Missing OAuth response' })
    return
  }

  const oauthCookies = parseCookies(req)
  const { verifier: verifierCookie } = getAuthCookieNames()
  const verifier = oauthCookies[verifierCookie]

  if (!verifier) {
      clearOAuthCookies(res, isSecureRequest(req), req)
    res.status(400).json({ error: 'Missing OAuth verifier' })
    return
  }

  try {
    const session = await exchangeCodeForSession(codeValue, verifier)
      clearOAuthCookies(res, isSecureRequest(req), req)

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
      // 新用戶：先檢查是否有同 email 的孤立 1Campus 帳號（先用 1Campus 登入，Phase 2 未找到 Google 帳號的情境）
      const { data: orphanedProfile } = await supabaseAdmin
        .from('profiles')
        .select('id, role, permission_tier, ink_balance')
        .eq('email', user.email)
        .neq('id', user.id)
        .maybeSingle()

      if (orphanedProfile) {
        // 找到孤立的 1Campus 帳號，將所有資料搬移到新 Google 帳號
        const oldUserId = orphanedProfile.id
        const ownerTables = [
          'folders', 'assignments', 'submissions', 'classrooms', 'students',
          'campus_classroom_sync', 'ability_aggregates', 'ability_dictionary',
          'assignment_student_state', 'assignment_tag_aggregates', 'assignment_tag_state',
          'correction_attempt_logs', 'correction_question_items', 'deleted_records',
          'domain_tag_aggregates', 'tag_ability_map', 'tag_dictionary',
          'tag_dictionary_state', 'teacher_notifications', 'teacher_preferences'
        ]
        for (const table of ownerTables) {
          await supabaseAdmin.from(table).update({ owner_id: user.id }).eq('owner_id', oldUserId)
        }
        await supabaseAdmin
          .from('external_identities')
          .update({ user_id: user.id, updated_at: nowIso })
          .eq('user_id', oldUserId)
        await supabaseAdmin.from('profiles').delete().eq('id', oldUserId)
        await supabaseAdmin.auth.admin.deleteUser(oldUserId).catch(() => {})
      }

      // 創建新 Google profile，若有孤立帳號則繼承其 permission_tier 與 ink_balance
      const insertPayload = {
        id: user.id,
        email: user.email,
        name: fullName,
        avatar_url: avatarUrl,
        role: orphanedProfile?.role || 'user',
        permission_tier: orphanedProfile?.permission_tier || 'basic',
        ink_balance: orphanedProfile?.ink_balance ?? 10,
        updated_at: nowIso
      }
      query = supabaseAdmin.from('profiles').insert(insertPayload)
    }

    const { error: profileError } = await query

    if (profileError) {
      res.status(500).json({ error: '建立使用者資料失敗' })
      return
    }

      setAuthCookies(res, session, isSecureRequest(req), req)

    const frontendUrl = getFrontendUrl(req) || '/'
    const redirectLocation = entry
      ? `${frontendUrl}${frontendUrl.includes('?') ? '&' : '?'}entry=${encodeURIComponent(entry)}`
      : frontendUrl
    appendSetCookie(res, serializeClearLoginEntryCookie(isSecureRequest(req)))
    res.writeHead(302, { Location: redirectLocation })
    res.end()
  } catch (err) {
    clearOAuthCookies(res, isSecureRequest(req), req)
    res.status(500).json({ error: err instanceof Error ? err.message : '登入失敗' })
  }
}
