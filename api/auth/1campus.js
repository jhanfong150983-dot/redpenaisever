/**
 * GET /api/auth/1campus?code=XXX&dsns=YYY
 *
 * 1Campus SSO 入口處理器（Phase 1）
 * 流程：驗證 Identity Code → 查找/建立帳號 → 建立 Supabase Session → 設定 Cookie → Redirect
 */
import { handleCors } from '../../server/_cors.js'
import {
  setAuthCookies,
  isSecureRequest
} from '../../server/_auth.js'
import {
  getSupabaseAdmin,
  getSupabaseUrl,
  getSupabaseServiceRoleKey
} from '../../server/_supabase.js'
import { getEnvValue } from '../../server/_env.js'
import {
  isValidDsns,
  fetchCampus1Identity,
  buildCampus1VirtualEmail,
  buildCampus1DisplayName
} from '../../server/_1campus.js'

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

function ssoErrorRedirect(res, req, errorCode) {
  const frontendUrl = getFrontendUrl(req)
  res.writeHead(302, { Location: `${frontendUrl}?sso_error=${errorCode}` })
  res.end()
}

function getStringParam(req, name) {
  const val = req.query?.[name]
  if (typeof val === 'string') return val.trim()
  if (Array.isArray(val)) return String(val[0] || '').trim()
  return ''
}

/**
 * 建立 Supabase 使用者 Session（generateLink → verify OTP）
 * 後端直接取得 session，不寄出 email
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

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}))
    throw new Error(
      errData?.error_description || errData?.error || '建立會話失敗'
    )
  }

  return response.json()
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

  // ── 1. 驗證 URL 參數 ──────────────────────────────────────
  const code = getStringParam(req, 'code')
  const dsns = getStringParam(req, 'dsns')

  if (!code || code.length > 512) {
    ssoErrorRedirect(res, req, 'invalid_params')
    return
  }

  if (!dsns || !isValidDsns(dsns)) {
    ssoErrorRedirect(res, req, 'invalid_params')
    return
  }

  // ── 2. 呼叫 1Campus Identity API ──────────────────────────
  let identity
  try {
    identity = await fetchCampus1Identity(dsns, code)
  } catch (err) {
    console.error('[1campus SSO] Identity API failed:', err?.message)
    ssoErrorRedirect(res, req, 'identity_failed')
    return
  }

  // ── 3. 角色過濾（目前僅支援教師）────────────────────────────
  if (identity?.roleType !== 'teacher') {
    ssoErrorRedirect(res, req, 'unsupported_role')
    return
  }

  const account = String(identity.account || '').trim()
  if (!account) {
    ssoErrorRedirect(res, req, 'identity_failed')
    return
  }

  const teacherID = String(identity.teacherID || '').trim()
  const displayName = buildCampus1DisplayName(identity)
  const virtualEmail = buildCampus1VirtualEmail(account, dsns)
  const supabaseAdmin = getSupabaseAdmin()
  const nowIso = new Date().toISOString()

  // ── 4. 查找或建立帳號 ─────────────────────────────────────
  let userId
  try {
    // 4a. 查 external_identities
    const { data: existingIdentity, error: identityError } =
      await supabaseAdmin
        .from('external_identities')
        .select('user_id, provider_meta')
        .eq('provider', 'campus1')
        .eq('provider_account', account)
        .maybeSingle()

    if (identityError) throw new Error('查詢身份記錄失敗')

    if (existingIdentity) {
      // 已有記錄：更新 provider_meta，取得 user_id
      userId = existingIdentity.user_id
      const updatedMeta = {
        ...(existingIdentity.provider_meta || {}),
        teacherID,
        displayName,
        dsns,
        lastLoginAt: nowIso
      }
      await supabaseAdmin
        .from('external_identities')
        .update({ provider_meta: updatedMeta, updated_at: nowIso })
        .eq('provider', 'campus1')
        .eq('provider_account', account)
    } else {
      // 4b. 無記錄：查 profiles 看是否有虛擬 email 的舊帳號
      const { data: existingProfile } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('email', virtualEmail)
        .maybeSingle()

      if (existingProfile) {
        // 已有虛擬 email 帳號但無 identity 記錄 → 補寫記錄
        userId = existingProfile.id
      } else {
        // 全新使用者：建立 Supabase auth 帳號
        const { data: newUserData, error: createError } =
          await supabaseAdmin.auth.admin.createUser({
            email: virtualEmail,
            email_confirm: true,
            user_metadata: { full_name: displayName }
          })

        if (createError) throw new Error(`建立帳號失敗: ${createError.message}`)
        userId = newUserData.user.id

        // 建立 profiles 記錄
        const { error: profileError } = await supabaseAdmin
          .from('profiles')
          .insert({
            id: userId,
            email: virtualEmail,
            name: displayName,
            role: 'user',
            permission_tier: 'basic',
            ink_balance: 10,
            updated_at: nowIso
          })

        if (profileError) {
          console.warn('[1campus SSO] Profile insert failed:', profileError.message)
        }
      }

      // 寫入 external_identities
      const meta = { teacherID, displayName, dsns, lastLoginAt: nowIso }
      const { error: insertError } = await supabaseAdmin
        .from('external_identities')
        .insert({
          user_id: userId,
          provider: 'campus1',
          provider_account: account,
          provider_dsns: dsns,
          provider_meta: meta
        })

      if (insertError) throw new Error(`建立身份記錄失敗: ${insertError.message}`)
    }
  } catch (err) {
    console.error('[1campus SSO] findOrCreateUser failed:', err?.message)
    ssoErrorRedirect(res, req, 'create_user_failed')
    return
  }

  // ── 5. 建立 Session ─────────────────────────────────────
  let session
  try {
    session = await createSessionForEmail(virtualEmail)
    if (!session?.access_token) throw new Error('Session 缺少 access_token')
  } catch (err) {
    console.error('[1campus SSO] Session creation failed:', err?.message)
    ssoErrorRedirect(res, req, 'session_failed')
    return
  }

  // ── 6. 設定 Cookies ───────────────────────────────────────
  setAuthCookies(res, session, isSecureRequest(req))

  // ── 7. Redirect ───────────────────────────────────────────
  // 若有設定 OAuth（Phase 2），先走 OAuth 取得真實 email + Jasmine token
  const clientId = getEnvValue('CAMPUS1_CLIENT_ID')
  const frontendUrl = getFrontendUrl(req)

  if (clientId) {
    // Redirect 到 OAuth 啟動端點
    const oauthParams = new URLSearchParams({ dsns })
    res.writeHead(302, {
      Location: `/api/auth/1campus-oauth?${oauthParams.toString()}`
    })
  } else {
    // Phase 1 only：直接導回前端
    res.writeHead(302, {
      Location: `${frontendUrl}?sso_provider=campus1`
    })
  }
  res.end()
}
