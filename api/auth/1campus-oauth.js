/**
 * GET /api/auth/1campus-oauth?dsns=YYY
 *
 * 啟動 1Campus OAuth 2.0 授權流程
 * 此端點在 1campus.js 設定 session cookie 後被呼叫
 * 流程：驗證登入狀態 → 產生 CSRF state → 設定 state cookie → Redirect 至廠商授權頁
 */
import crypto from 'crypto'
import { handleCors } from '../../server/_cors.js'
import { getAuthUser, isSecureRequest } from '../../server/_auth.js'
import { getEnvValue } from '../../server/_env.js'
import { isValidDsns } from '../../server/_1campus.js'

const CAMPUS1_OAUTH_AUTHORIZE = 'https://auth.ischool.com.tw/oauth/authorize.php'
const STATE_COOKIE_NAME = 'rp-campus1-state'
const STATE_TTL_SECONDS = 600

// ============================================================
// 工具函數
// ============================================================

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

function serializeStateCookie(value, secure) {
  const { sameSite, domain, effectiveSecure } = getCookieSettings(secure)
  const parts = [
    `${STATE_COOKIE_NAME}=${encodeURIComponent(value)}`,
    `Max-Age=${STATE_TTL_SECONDS}`,
    'Path=/',
    `SameSite=${sameSite}`,
    'HttpOnly'
  ]
  if (domain) parts.push(`Domain=${domain}`)
  if (effectiveSecure) parts.push('Secure')
  return parts.join('; ')
}

function appendSetCookie(res, cookie) {
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

// ============================================================
// 主 Handler
// ============================================================

export default async function handler(req, res) {
  if (handleCors(req, res)) return

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  // 必須已登入（由 1campus.js 設定 session cookie 後呼叫）
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  // 驗證 dsns
  const dsns = getStringParam(req, 'dsns')
  if (!dsns || !isValidDsns(dsns)) {
    res.status(400).json({ error: 'Invalid dsns' })
    return
  }

  // 確認 OAuth credentials 已設定
  const clientId = getEnvValue('CAMPUS1_CLIENT_ID')
  if (!clientId) {
    res.status(503).json({ error: '1Campus OAuth 未設定' })
    return
  }

  // 產生 CSRF 防護 state
  // state 格式：base64url({ nonce, dsns, userId })
  const nonce = crypto.randomBytes(16).toString('hex')
  const stateData = JSON.stringify({ nonce, dsns, userId: user.id })
  const stateB64 = Buffer.from(stateData).toString('base64url')

  // 設定 state cookie（HttpOnly，10 分鐘有效）
  const stateCookie = serializeStateCookie(stateB64, isSecureRequest(req))
  appendSetCookie(res, stateCookie)

  // 組建授權 URL
  const callbackUrl = getOAuthCallbackUrl(req)
  const authUrl =
    `${CAMPUS1_OAUTH_AUTHORIZE}?` +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: callbackUrl,
      scope: 'User.Mail,jasmine',
      state: stateB64
    }).toString()

  res.writeHead(302, { Location: authUrl })
  res.end()
}
