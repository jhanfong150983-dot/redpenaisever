// Vertex AI Service Account 認證（2026-07-16 廠商 SA 金鑰接入）
//
// 啟用條件：AI_PROVIDER=vertex 且 GCP_SA_JSON 有值（整包 SA JSON 字串塞單一 env var）。
// 兩者缺一都走原本 generativelanguage + API key 路徑（kill switch：拿掉 AI_PROVIDER 即回退）。
//
// token 流程：SA JSON → RS256 JWT → token_uri 換 access token（有效 1hr）。
// 不用 google-auth-library：JWT assertion 用 node:crypto 30 行可完成，省一顆 serverless 依賴。
import crypto from 'node:crypto'
import { getEnvValue } from '../_env.js'

// token 過期前 5 分鐘就刷新，避免長 pipeline 中途過期
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

let cachedSa = null
let cachedSaRaw = null
let cachedToken = null // { token, expiresAtMs }
let inflightTokenPromise = null

export function isVertexEnabled() {
  return (
    (getEnvValue('AI_PROVIDER') || '').toLowerCase() === 'vertex' &&
    Boolean(getEnvValue('GCP_SA_JSON'))
  )
}

function getServiceAccount() {
  const raw = getEnvValue('GCP_SA_JSON')
  if (!raw) throw new Error('GCP_SA_JSON missing')
  if (cachedSa && cachedSaRaw === raw) return cachedSa
  let sa
  try {
    sa = JSON.parse(raw)
  } catch {
    throw new Error('GCP_SA_JSON is not valid JSON')
  }
  if (!sa?.client_email || !sa?.private_key || !sa?.token_uri) {
    throw new Error('GCP_SA_JSON missing client_email/private_key/token_uri')
  }
  cachedSa = sa
  cachedSaRaw = raw
  cachedToken = null // 換了金鑰就作廢舊 token
  return sa
}

export function getVertexConfig() {
  const sa = getServiceAccount()
  return {
    project: getEnvValue('VERTEX_PROJECT') || sa.project_id,
    // gemini-3.5-flash / 3.x preview 只在 global endpoint 有、us-central1 是 404（2026-07-16 實測）
    location: getEnvValue('VERTEX_LOCATION') || 'global'
  }
}

export function buildVertexModelUrl(model) {
  const { project, location } = getVertexConfig()
  const host =
    location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`
  const modelName = String(model).replace(/^models\//, '')
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${modelName}:generateContent`
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

async function fetchAccessToken(sa) {
  const nowSec = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: sa.token_uri,
      iat: nowSec,
      exp: nowSec + 3600
    })
  )
  const unsigned = `${header}.${claims}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key)
  const jwt = `${unsigned}.${b64url(signature)}`

  const response = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.access_token) {
    throw new Error(
      `[vertex-auth] token exchange failed status=${response.status} ${JSON.stringify(data?.error || data).slice(0, 200)}`
    )
  }
  const expiresInMs = (Number(data.expires_in) || 3600) * 1000
  return { token: data.access_token, expiresAtMs: Date.now() + expiresInMs }
}

export async function getVertexAccessToken({ forceRefresh = false } = {}) {
  const sa = getServiceAccount()
  if (
    !forceRefresh &&
    cachedToken &&
    Date.now() < cachedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS
  ) {
    return cachedToken.token
  }
  // 高併發下只打一次 token endpoint，其餘等同一個 promise
  if (!inflightTokenPromise) {
    inflightTokenPromise = fetchAccessToken(sa)
      .then((result) => {
        cachedToken = result
        return result.token
      })
      .finally(() => {
        inflightTokenPromise = null
      })
  }
  return inflightTokenPromise
}
