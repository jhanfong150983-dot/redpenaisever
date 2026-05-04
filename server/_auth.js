import crypto from 'crypto'
import {
  getSupabaseServiceRoleKey,
  getSupabaseUrl
} from './_supabase.js'

const ACCESS_COOKIE = 'rp-access-token'
const REFRESH_COOKIE = 'rp-refresh-token'
const VERIFIER_COOKIE = 'rp-oauth-verifier'

export function getAuthCookieNames() {
  return {
    access: ACCESS_COOKIE,
    refresh: REFRESH_COOKIE,
    verifier: VERIFIER_COOKIE
  }
}

export function parseCookies(req) {
  const header = req.headers?.cookie || ''
  return header.split(';').reduce((acc, pair) => {
    const trimmed = pair.trim()
    if (!trimmed) return acc
    const index = trimmed.indexOf('=')
    if (index === -1) return acc
    const key = trimmed.slice(0, index)
    const value = trimmed.slice(index + 1)
    acc[key] = decodeURIComponent(value)
    return acc
  }, {})
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  parts.push(`Path=${options.path || '/'}`)
  if (options.domain) parts.push(`Domain=${options.domain}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`)
  return parts.join('; ')
}

function normalizeHostname(rawHost) {
  return String(rawHost || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
}

function isCookieDomainMatch(hostname, cookieDomain) {
  const host = normalizeHostname(hostname)
  const domain = String(cookieDomain || '').trim().toLowerCase().replace(/^\./, '')
  if (!host || !domain) return false
  return host === domain || host.endsWith(`.${domain}`)
}

function resolveCookieDomain(configuredDomain, req) {
  const domain = String(configuredDomain || '').trim()
  if (!domain) return undefined

  const requestHost = req?.headers?.host
  if (!requestHost) return undefined

  if (!isCookieDomainMatch(requestHost, domain)) {
    return undefined
  }

  return domain
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

export function isSecureRequest(req) {
  const proto = req.headers?.['x-forwarded-proto']
  if (proto) return proto === 'https'
  return process.env.NODE_ENV === 'production'
}

function getCookieSettings(secure, req) {
  const rawSameSite = String(process.env.AUTH_COOKIE_SAME_SITE || 'Lax').trim()
  const sameSite = rawSameSite || 'Lax'
  const domain = resolveCookieDomain(process.env.AUTH_COOKIE_DOMAIN || '', req)

  // SameSite=None requires Secure by browser policy.
  const effectiveSecure =
    sameSite.toLowerCase() === 'none'
      ? true
      : secure

  return {
    secure: effectiveSecure,
    sameSite,
    domain
  }
}

export function setAuthCookies(res, session, secure, req) {
  const settings = getCookieSettings(secure, req)
  const accessCookie = serializeCookie(ACCESS_COOKIE, session.access_token, {
    httpOnly: true,
    secure: settings.secure,
    sameSite: settings.sameSite,
    domain: settings.domain,
    maxAge: session.expires_in ?? 3600
  })
  const refreshCookie = serializeCookie(REFRESH_COOKIE, session.refresh_token, {
    httpOnly: true,
    secure: settings.secure,
    sameSite: settings.sameSite,
    domain: settings.domain,
    maxAge: 60 * 60 * 24 * 30
  })
  appendSetCookie(res, accessCookie)
  appendSetCookie(res, refreshCookie)
}

export function clearAuthCookies(res, secure, req) {
  const settings = getCookieSettings(secure, req)
  const accessCookie = serializeCookie(ACCESS_COOKIE, '', {
    httpOnly: true,
    secure: settings.secure,
    sameSite: settings.sameSite,
    domain: settings.domain,
    maxAge: 0
  })
  const refreshCookie = serializeCookie(REFRESH_COOKIE, '', {
    httpOnly: true,
    secure: settings.secure,
    sameSite: settings.sameSite,
    domain: settings.domain,
    maxAge: 0
  })
  appendSetCookie(res, accessCookie)
  appendSetCookie(res, refreshCookie)
}

export function setOAuthCookies(res, { verifier }, secure, req) {
  const settings = getCookieSettings(secure, req)
  const verifierCookie = serializeCookie(VERIFIER_COOKIE, verifier, {
    httpOnly: true,
    secure: settings.secure,
    sameSite: settings.sameSite,
    domain: settings.domain,
    maxAge: 300
  })
  appendSetCookie(res, verifierCookie)
}

export function clearOAuthCookies(res, secure, req) {
  const settings = getCookieSettings(secure, req)
  const verifierCookie = serializeCookie(VERIFIER_COOKIE, '', {
    httpOnly: true,
    secure: settings.secure,
    sameSite: settings.sameSite,
    domain: settings.domain,
    maxAge: 0
  })
  appendSetCookie(res, verifierCookie)
}

export function buildOAuthUrl({ redirectTo, codeChallenge }) {
  const base = `${getSupabaseUrl()}/auth/v1/authorize`
  const params = new URLSearchParams({
    provider: 'google',
    redirect_to: redirectTo,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  })
  return `${base}?${params.toString()}`
}

export function generateOAuthVerifier() {
  const verifier = base64Url(crypto.randomBytes(32))
  const challenge = base64Url(
    crypto.createHash('sha256').update(verifier).digest()
  )
  return { verifier, challenge }
}

function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export async function exchangeCodeForSession(code, verifier) {
  const supabaseUrl = getSupabaseUrl()
  const serviceRoleKey = getSupabaseServiceRoleKey()
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase server credentials are missing')
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      auth_code: code,
      code_verifier: verifier
    })
  })

  const data = await response.json()
  if (!response.ok) {
    const message = data?.error_description || data?.error || '登入失敗'
    throw new Error(message)
  }

  return data
}

// 直接打 Supabase Auth REST API，避免使用 supabase-js 的 auth helper。
// 後者會把使用者 session 寫進 client 記憶體，污染共用的 cached admin client，
// 導致後續 .from() 查詢以使用者身分而非 service_role 跑、被 RLS 擋下。
async function fetchAuthUserViaRest(supabaseUrl, serviceRoleKey, accessToken) {
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${accessToken}`
      }
    })
    if (!response.ok) return { user: null, ok: false }
    const user = await response.json()
    if (!user?.id) return { user: null, ok: false }
    return { user, ok: true }
  } catch {
    return { user: null, ok: false }
  }
}

async function refreshSessionViaRest(supabaseUrl, serviceRoleKey, refreshToken) {
  try {
    const response = await fetch(
      `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ refresh_token: refreshToken })
      }
    )
    if (!response.ok) return { session: null, user: null, ok: false }
    const data = await response.json()
    if (!data?.access_token || !data?.refresh_token || !data?.user) {
      return { session: null, user: null, ok: false }
    }
    return {
      session: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in ?? 3600
      },
      user: data.user,
      ok: true
    }
  } catch {
    return { session: null, user: null, ok: false }
  }
}

export async function getAuthUser(req, res) {
  const cookies = parseCookies(req)
  const accessToken = cookies[ACCESS_COOKIE]
  const refreshToken = cookies[REFRESH_COOKIE]

  if (!accessToken && !refreshToken) return { user: null, accessToken: null }

  const supabaseUrl = getSupabaseUrl()
  const serviceRoleKey = getSupabaseServiceRoleKey()
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase server credentials are missing')
  }

  if (accessToken) {
    const { user, ok } = await fetchAuthUserViaRest(supabaseUrl, serviceRoleKey, accessToken)
    if (ok && user) {
      return { user, session: null, accessToken }
    }
  }

  if (refreshToken) {
    const { session, user, ok } = await refreshSessionViaRest(
      supabaseUrl,
      serviceRoleKey,
      refreshToken
    )

    if (!ok || !session || !user) {
      clearAuthCookies(res, isSecureRequest(req), req)
      return { user: null, accessToken: null }
    }

    setAuthCookies(res, session, isSecureRequest(req), req)
    return {
      user,
      session,
      accessToken: session.access_token
    }
  }

  clearAuthCookies(res, isSecureRequest(req), req)
  return { user: null, accessToken: null }
}
