function normalizeOrigin(origin) {
  return String(origin || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\/+$/, '')
}

function isLoopbackOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
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
  const isAllowed =
    requestOrigin && (allowedOrigins.includes(requestOrigin) || localDevAllowed)

  setPreflightHeaders(req, res, isAllowed ? requestOrigin : '')

  if (req.method === 'OPTIONS') {
    res.statusCode = isAllowed || !requestOrigin ? 204 : 403
    res.end()
    return true
  }

  return false
}
