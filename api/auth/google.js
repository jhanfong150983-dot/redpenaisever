import { handleCors } from '../../server/_cors.js'
import {
  buildOAuthUrl,
  generateOAuthVerifier,
  setOAuthCookies,
  isSecureRequest
} from '../../server/_auth.js'

function getSiteUrl(req) {
  const proto = req.headers?.['x-forwarded-proto'] || 'http'
  const host = req.headers?.host
  if (!host) return process.env.SITE_URL || ''
  return `${proto}://${host}`
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

  const siteUrl = process.env.SITE_URL || getSiteUrl(req)
  if (!siteUrl) {
    res.status(500).json({ error: 'Missing SITE_URL' })
    return
  }

  const { verifier, challenge } = generateOAuthVerifier()
  setOAuthCookies(res, { verifier }, isSecureRequest(req))

  const redirectTo = `${siteUrl}/api/auth/callback`
  const url = buildOAuthUrl({
    redirectTo,
    codeChallenge: challenge
  })

  res.writeHead(302, { Location: url })
  res.end()
}
