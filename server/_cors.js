function normalizeOrigin(origin) {
  return String(origin || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\/+$/, '')
}

function isLoopbackOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
}

function parseUrlSafe(value) {
  try {
    return new URL(String(value || ''))
  } catch {
    return null
  }
}

function isPrivateIpv4(hostname) {
  const value = String(hostname || '').trim()
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false
  const [a, b] = value.split('.').map((item) => Number.parseInt(item, 10))
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  )
}

function isLanLocalHost(hostname) {
  const value = String(hostname || '').trim().toLowerCase()
  if (!value) return false
  if (value === 'localhost' || value === '127.0.0.1' || value === '::1') return true
  return isPrivateIpv4(value)
}

function isSameLanOrigin(req, origin) {
  const originUrl = parseUrlSafe(origin)
  if (!originUrl) return false
  const reqOrigin = getRequestOrigin(req)
  const reqUrl = parseUrlSafe(reqOrigin)
  if (!reqUrl) return false

  const sameHostname = originUrl.hostname.toLowerCase() === reqUrl.hostname.toLowerCase()
  if (!sameHostname) return false

  return isLanLocalHost(reqUrl.hostname)
}

function getRequestOrigin(req) {
  const proto = String(req.headers?.['x-forwarded-proto'] || 'http').trim()
  const host = String(req.headers?.host || '').trim()
  if (!host) return ''
  return `${proto}://${host}`
}

function isLocalRequestHost(req) {
  const host = String(req.headers?.host || '').trim().toLowerCase()
  return (
    host.startsWith('localhost:') ||
    host.startsWith('127.0.0.1:') ||
    host.startsWith('[::1]:')
  )
}

function parseOrigins() {
  const fromEnv = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((item) => normalizeOrigin(item))
    .filter(Boolean)

  const siteUrl = normalizeOrigin(process.env.SITE_URL || '')
  if (siteUrl && !fromEnv.includes(siteUrl)) {
    fromEnv.push(siteUrl)
  }
  const frontendUrl = normalizeOrigin(process.env.FRONTEND_URL || '')
  if (frontendUrl && !fromEnv.includes(frontendUrl)) {
    fromEnv.push(frontendUrl)
  }
  const backendUrl = normalizeOrigin(process.env.BACKEND_URL || '')
  if (backendUrl && !fromEnv.includes(backendUrl)) {
    fromEnv.push(backendUrl)
  }

  return fromEnv
}

function setPreflightHeaders(req, res, origin) {
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  }

  const requestedHeaders = req.headers?.['access-control-request-headers']
  const allowHeaders =
    requestedHeaders || 'Content-Type, Authorization, X-Requested-With'

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', allowHeaders)
  res.setHeader('Access-Control-Max-Age', '600')
}

export function handleCors(req, res) {
  const requestOrigin = normalizeOrigin(req.headers?.origin || '')
  const allowedOrigins = parseOrigins()
  const localDevAllowed = isLoopbackOrigin(requestOrigin) && isLocalRequestHost(req)
  const lanSameHostAllowed = isSameLanOrigin(req, requestOrigin)
  const isAllowed =
    requestOrigin && (allowedOrigins.includes(requestOrigin) || localDevAllowed || lanSameHostAllowed)

  setPreflightHeaders(req, res, isAllowed ? requestOrigin : '')

  if (req.method === 'OPTIONS') {
    res.statusCode = isAllowed || !requestOrigin ? 204 : 403
    res.end()
    return true
  }

  return false
}
