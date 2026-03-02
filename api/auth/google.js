import { handleCors } from '../../server/_cors.js'
import {
  buildOAuthUrl,
  generateOAuthVerifier,
  setOAuthCookies,
  isSecureRequest
} from '../../server/_auth.js'
import { getSupabaseUrl } from '../../server/_supabase.js'

function getRequestOrigin(req) {
  const proto = req.headers?.['x-forwarded-proto'] || 'http'
  const host = req.headers?.host
  if (!host) return ''
  return `${proto}://${host}`
}

function getBackendUrl(req) {
  return process.env.BACKEND_URL || process.env.SITE_URL || getRequestOrigin(req)
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

function serializeLoginEntryCookie(entry, secure) {
  const sameSite = String(process.env.AUTH_COOKIE_SAME_SITE || 'Lax').trim() || 'Lax'
  const domain = (process.env.AUTH_COOKIE_DOMAIN || '').trim()
  const effectiveSecure = sameSite.toLowerCase() === 'none' ? true : secure
  const parts = [
    `rp-login-entry=${encodeURIComponent(entry)}`,
    'Max-Age=600',
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

  if (!getSupabaseUrl()) {
    res.status(500).json({ error: 'Missing SUPABASE_URL' })
    return
  }

  const backendUrl = getBackendUrl(req)
  if (!backendUrl) {
    res.status(500).json({ error: 'Missing BACKEND_URL/SITE_URL' })
    return
  }

  const { verifier, challenge } = generateOAuthVerifier()
  setOAuthCookies(res, { verifier }, isSecureRequest(req))

  const entry = normalizeEntry(req.query?.entry)
  if (entry) {
    const cookie = serializeLoginEntryCookie(entry, isSecureRequest(req))
    appendSetCookie(res, cookie)
  }
  const redirectTo = `${backendUrl}/api/auth/callback`
  const url = buildOAuthUrl({
    redirectTo,
    codeChallenge: challenge
  })

  res.writeHead(302, { Location: url })
  res.end()
}
