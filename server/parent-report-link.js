// 家長報告「時效簽章連結」（2026-09-13）：家長不登入 RedPen，只憑連結看自己孩子的報告。
//   token = base64url({a: assignmentId, s: studentId, e: 到期秒}) + '.' + base64url(HMAC-SHA256)
//   驗證不查 DB（無狀態）；PDF 路徑由 (assignmentId, studentId) 決定，重新產生就覆蓋、舊連結看到的是新檔。
//   祕鑰：PARENT_REPORT_LINK_SECRET；未設則由 SUPABASE_SERVICE_ROLE_KEY 派生（換 key＝舊連結全失效，可接受）。
import crypto from 'node:crypto'
import { getSupabaseServiceRoleKey } from './_supabase.js'

const DEFAULT_TTL_DAYS = 14

function secret() {
  const s = process.env.PARENT_REPORT_LINK_SECRET
  if (s && s.length >= 16) return s
  return crypto.createHash('sha256').update('parent-report-link:' + (getSupabaseServiceRoleKey() || '')).digest('hex')
}
const b64u = (buf) => Buffer.from(buf).toString('base64url')
const sign = (payloadB64) => b64u(crypto.createHmac('sha256', secret()).update(payloadB64).digest())

export function storagePathFor(assignmentId, studentId) {
  return `${assignmentId}/${studentId}.pdf`
}

/** @returns {{ token:string, expiresAt:string }} */
export function makeParentReportToken(assignmentId, studentId, ttlDays = DEFAULT_TTL_DAYS) {
  const e = Math.floor(Date.now() / 1000) + Math.max(1, Number(ttlDays) || DEFAULT_TTL_DAYS) * 86400
  const p = b64u(JSON.stringify({ a: String(assignmentId), s: String(studentId), e }))
  return { token: `${p}.${sign(p)}`, expiresAt: new Date(e * 1000).toISOString() }
}

/** @returns {{ ok:true, assignmentId, studentId, exp:number } | { ok:false, reason:'malformed'|'bad_signature'|'expired' }} */
export function verifyParentReportToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' }
  const [p, sig] = parts
  const expect = sign(p)
  const a = Buffer.from(sig), b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' }
  let payload
  try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) } catch { return { ok: false, reason: 'malformed' } }
  if (!payload?.a || !payload?.s || !Number.isFinite(payload?.e)) return { ok: false, reason: 'malformed' }
  if (payload.e * 1000 < Date.now()) return { ok: false, reason: 'expired' }
  return { ok: true, assignmentId: String(payload.a), studentId: String(payload.s), exp: payload.e }
}

/** 對外網址（前端網域＋open 端點）。 */
export function parentReportOpenUrl(req, token) {
  const base = process.env.PARENT_REPORT_PUBLIC_BASE
    || process.env.FRONTEND_URL
    || (req?.headers?.origin && /^https?:\/\//.test(req.headers.origin) ? req.headers.origin : '')
    || 'https://redpenai-seven.vercel.app'
  return `${String(base).replace(/\/+$/, '')}/api/report/parent-open?t=${encodeURIComponent(token)}`
}
