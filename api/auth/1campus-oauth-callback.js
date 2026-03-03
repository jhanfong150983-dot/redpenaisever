/**
 * GET /api/auth/1campus-oauth-callback?code=XXX&state=YYY
 *
 * 1Campus OAuth 2.0 授權回呼處理器（Phase 2）
 * 流程：
 *   驗證 state cookie → 換取 tokens → 取得真實 Email
 *   → 儲存 tokens → Email 自動比對（帳號合併）→ Redirect 前端（含班級同步參數）
 */
import { handleCors } from '../../server/_cors.js'
import {
  setAuthCookies,
  isSecureRequest,
  parseCookies
} from '../../server/_auth.js'
import {
  getSupabaseAdmin,
  getSupabaseUrl,
  getSupabaseServiceRoleKey
} from '../../server/_supabase.js'
import { getEnvValue } from '../../server/_env.js'
import {
  exchangeCampus1OAuthCode,
  fetchCampus1UserInfo,
  isValidDsns
} from '../../server/_1campus.js'

const STATE_COOKIE_NAME = 'rp-campus1-state'

// ============================================================
// 工具函數
// ============================================================

function getFrontendUrl(req) {
  const frontendUrl = getEnvValue('FRONTEND_URL')
  if (frontendUrl) return frontendUrl.replace(/\/+$/, '')

  const host = String(req.headers?.host || '').toLowerCase()
  if (host.includes('localhost:3000') || host.includes('127.0.0.1:3000')) {
    return 'http://localhost:5173'
  }

  const proto = req.headers?.['x-forwarded-proto'] || 'http'
  return `${proto}://${host}`
}

function getOAuthCallbackUrl(req) {
  const fromEnv = getEnvValue('CAMPUS1_OAUTH_CALLBACK')
  if (fromEnv) return fromEnv

  const proto = req.headers?.['x-forwarded-proto'] || 'http'
  const host = req.headers?.host || 'localhost:3000'
  return `${proto}://${host}/api/auth/1campus-oauth-callback`
}

function getCookieSettings(secure) {
  const sameSite = getEnvValue('AUTH_COOKIE_SAME_SITE') || 'Lax'
  const domain = (getEnvValue('AUTH_COOKIE_DOMAIN') || '').trim()
  const effectiveSecure = sameSite.toLowerCase() === 'none' ? true : secure
  return { sameSite, domain, effectiveSecure }
}

function clearStateCookie(res, secure) {
  const { sameSite, domain, effectiveSecure } = getCookieSettings(secure)
  const parts = [
    `${STATE_COOKIE_NAME}=`,
    'Max-Age=0',
    'Path=/',
    `SameSite=${sameSite}`,
    'HttpOnly'
  ]
  if (domain) parts.push(`Domain=${domain}`)
  if (effectiveSecure) parts.push('Secure')

  const cookie = parts.join('; ')
  const existing = res.getHeader('Set-Cookie')
  if (!existing) {
    res.setHeader('Set-Cookie', [cookie])
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie])
  } else {
    res.setHeader('Set-Cookie', [existing, cookie])
  }
}

function getStringParam(req, name) {
  const val = req.query?.[name]
  if (typeof val === 'string') return val.trim()
  if (Array.isArray(val)) return String(val[0] || '').trim()
  return ''
}

/**
 * 建立 Supabase Session（用於帳號合併後切換到 Google 帳號）
 */
async function createSessionForEmail(email) {
  const supabaseAdmin = getSupabaseAdmin()
  const supabaseUrl = getSupabaseUrl()
  const serviceRoleKey = getSupabaseServiceRoleKey()

  const { data: linkData, error: linkError } =
    await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email
    })

  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(`生成登入連結失敗: ${linkError?.message || 'no OTP'}`)
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'email',
      email,
      token: linkData.properties.email_otp
    })
  })

  if (!response.ok) throw new Error('建立會話失敗')
  return response.json()
}

/**
 * 將 1Campus 虛擬帳號的資料合併到 Google 帳號
 * 移轉：classrooms、students、campus_classroom_sync、external_identities
 */
async function mergeCampus1IntoGoogleAccount(supabaseAdmin, oldUserId, googleUserId) {
  const nowIso = new Date().toISOString()

  await supabaseAdmin
    .from('classrooms')
    .update({ owner_id: googleUserId })
    .eq('owner_id', oldUserId)

  await supabaseAdmin
    .from('students')
    .update({ owner_id: googleUserId })
    .eq('owner_id', oldUserId)

  await supabaseAdmin
    .from('campus_classroom_sync')
    .update({ owner_id: googleUserId, updated_at: nowIso })
    .eq('owner_id', oldUserId)

  await supabaseAdmin
    .from('external_identities')
    .update({ user_id: googleUserId, updated_at: nowIso })
    .eq('user_id', oldUserId)
}

// ============================================================
// 主 Handler
// ============================================================

export default async function handler(req, res) {
  if (handleCors(req, res)) return

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const frontendUrl = getFrontendUrl(req)
  const secure = isSecureRequest(req)

  // ── 處理 OAuth 錯誤 ────────────────────────────────────────
  if (req.query?.error) {
    clearStateCookie(res, secure)
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  // ── 驗證 code 和 state ─────────────────────────────────────
  const code = getStringParam(req, 'code')
  const state = getStringParam(req, 'state')

  if (!code || !state) {
    clearStateCookie(res, secure)
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  // ── 驗證 state cookie（CSRF 防護）────────────────────────────
  const cookies = parseCookies(req)
  const cookieStateRaw = cookies[STATE_COOKIE_NAME] || ''
  const cookieState = cookieStateRaw
    ? decodeURIComponent(cookieStateRaw)
    : ''
  clearStateCookie(res, secure)

  if (!cookieState || cookieState !== state) {
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  // ── 解碼 state 資料 ───────────────────────────────────────
  let stateData
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64url').toString())
  } catch {
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  const { dsns, userId: campus1UserId } = stateData

  if (!dsns || !isValidDsns(dsns) || !campus1UserId) {
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  const supabaseAdmin = getSupabaseAdmin()
  const callbackUrl = getOAuthCallbackUrl(req)

  // ── 換取 OAuth Tokens ─────────────────────────────────────
  let tokenData
  try {
    tokenData = await exchangeCampus1OAuthCode(code, callbackUrl)
  } catch (err) {
    console.error('[1campus OAuth callback] Token exchange failed:', err?.message)
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  const accessToken = tokenData.access_token
  const refreshToken = tokenData.refresh_token
  const expiresIn = tokenData.expires_in || 3600
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

  // ── 取得真實 Email ─────────────────────────────────────────
  let realEmail = ''
  try {
    const userInfo = await fetchCampus1UserInfo(accessToken)
    realEmail = typeof userInfo.mail === 'string' ? userInfo.mail.trim() : ''
  } catch (err) {
    console.warn('[1campus OAuth callback] UserInfo failed (non-blocking):', err?.message)
  }

  // ── 取得 identity 記錄以更新 tokens ──────────────────────────
  const { data: identityData, error: identityError } = await supabaseAdmin
    .from('external_identities')
    .select('provider_meta, provider_account')
    .eq('user_id', campus1UserId)
    .eq('provider', 'campus1')
    .maybeSingle()

  // ── 儲存 OAuth tokens 至 provider_meta ────────────────────
  if (!identityError && identityData) {
    const updatedMeta = {
      ...(identityData.provider_meta || {}),
      oauth_access_token: accessToken,
      oauth_refresh_token: refreshToken,
      oauth_token_expires_at: tokenExpiresAt,
      ...(realEmail ? { real_email: realEmail } : {})
    }
    await supabaseAdmin
      .from('external_identities')
      .update({ provider_meta: updatedMeta, updated_at: new Date().toISOString() })
      .eq('user_id', campus1UserId)
      .eq('provider', 'campus1')
  }

  // ── Email 自動比對（嘗試合併 Google 帳號）──────────────────
  let finalUserId = campus1UserId

  if (realEmail) {
    try {
      // 查找同 email 的 Google 帳號（排除目前 campus1 user）
      const { data: googleProfile } = await supabaseAdmin
        .from('profiles')
        .select('id, email')
        .eq('email', realEmail)
        .neq('id', campus1UserId)
        .maybeSingle()

      if (googleProfile) {
        // 找到 Google 帳號 → 合併 1Campus 資料到 Google 帳號
        await mergeCampus1IntoGoogleAccount(
          supabaseAdmin,
          campus1UserId,
          googleProfile.id
        )
        finalUserId = googleProfile.id

        // 為 Google 帳號建立新的 session（替換 1Campus 的 cookie）
        const newSession = await createSessionForEmail(realEmail)
        if (newSession?.access_token) {
          setAuthCookies(
            res,
            {
              access_token: newSession.access_token,
              refresh_token: newSession.refresh_token,
              expires_in: newSession.expires_in || 3600
            },
            secure
          )
        }
      }
    } catch (err) {
      console.error(
        '[1campus OAuth callback] Email auto-match failed (non-blocking):',
        err?.message
      )
    }

    // 若目前 profile 仍是虛擬 email，更新為真實 email
    try {
      await supabaseAdmin
        .from('profiles')
        .update({ email: realEmail, updated_at: new Date().toISOString() })
        .eq('id', finalUserId)
        .like('email', 'campus1.%')
    } catch (err) {
      console.warn('[1campus OAuth callback] Update real email failed:', err?.message)
    }
  }

  // ── Redirect 前端（附帶班級同步參數）────────────────────────
  const teacherID = String(
    identityData?.provider_meta?.teacherID || ''
  )

  const redirectParams = new URLSearchParams({
    sso_provider: 'campus1',
    sso_sync: '1',
    sso_dsns: dsns
  })
  if (teacherID) redirectParams.set('sso_teacher_id', teacherID)

  res.writeHead(302, { Location: `${frontendUrl}?${redirectParams.toString()}` })
  res.end()
}
