import crypto from 'crypto'
import { getSupabaseAdmin, getSupabaseUrl } from './_supabase.js'

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

function getCookieSettings(secure) {
  const rawSameSite = String(process.env.AUTH_COOKIE_SAME_SITE || 'Lax').trim()
  const sameSite = rawSameSite || 'Lax'
  const domain = (process.env.AUTH_COOKIE_DOMAIN || '').trim() || undefined

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

export function setAuthCookies(res, session, secure) {
  const settings = getCookieSettings(secure)
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

export function clearAuthCookies(res, secure) {
  const settings = getCookieSettings(secure)
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

export function setOAuthCookies(res, { verifier }, secure) {
  const settings = getCookieSettings(secure)
  const verifierCookie = serializeCookie(VERIFIER_COOKIE, verifier, {
    httpOnly: true,
    secure: settings.secure,
    sameSite: settings.sameSite,
    domain: settings.domain,
    maxAge: 300
  })
  appendSetCookie(res, verifierCookie)
}

export function clearOAuthCookies(res, secure) {
  const settings = getCookieSettings(secure)
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
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
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

export async function getAuthUser(req, res) {
  const cookies = parseCookies(req)
  const accessToken = cookies[ACCESS_COOKIE]
  const refreshToken = cookies[REFRESH_COOKIE]

  if (!accessToken && !refreshToken) return { user: null, accessToken: null }

  const supabaseAdmin = getSupabaseAdmin()

  if (accessToken) {
    const { data, error } = await supabaseAdmin.auth.getUser(accessToken)
    if (!error && data?.user) {
      return { user: data.user, session: null, accessToken }
    }
  }

  if (refreshToken) {
    const { data, error } = await supabaseAdmin.auth.refreshSession({
      refresh_token: refreshToken
    })

    if (error || !data?.session || !data.user) {
      clearAuthCookies(res, isSecureRequest(req))
      return { user: null, accessToken: null }
    }

    setAuthCookies(res, data.session, isSecureRequest(req))
    return {
      user: data.user,
      session: data.session,
      accessToken: data.session.access_token
    }
  }

  clearAuthCookies(res, isSecureRequest(req))
  return { user: null, accessToken: null }
}
