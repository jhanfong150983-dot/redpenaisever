import { handleCors } from '../../server/_cors.js'
import {
  buildOAuthUrl,
  generateOAuthVerifier,
  setOAuthCookies,
  isSecureRequest
} from '../../server/_auth.js'

function getRequestOrigin(req) {
  const proto = req.headers?.['x-forwarded-proto'] || 'http'
  const host = req.headers?.host
  if (!host) return ''
  return `${proto}://${host}`
}

function getBackendUrl(req) {
  return process.env.BACKEND_URL || process.env.SITE_URL || getRequestOrigin(req)
}

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  if (!process.env.SUPABASE_URL) {
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

  const redirectTo = `${backendUrl}/api/auth/callback`
  const url = buildOAuthUrl({
    redirectTo,
    codeChallenge: challenge
  })

  res.writeHead(302, { Location: url })
  res.end()
}
