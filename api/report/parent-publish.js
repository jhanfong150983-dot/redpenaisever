// 家長報告「發布」（2026-09-13）：client 傳這位學生的報告 HTML → 伺服器渲染 PDF → 存 Supabase Storage
//   （私有 bucket parent-reports、路徑 {assignmentId}/{studentId}.pdf、重發覆蓋）→ 回時效簽章連結。
//   家長憑連結（/api/report/parent-open?t=）看 PDF，不用登入。之後「發送給家長」＝把這個連結放進 1Campus 推播。
//   權限：考卷擁有者，或該考卷所屬學校的行政（school_admins）／系統 admin。
//   POST { assignmentId, studentId, html, ttlDays? } → { url, expiresAt, path, seat?, name? }
//   ⚠ DDL 手動（best-effort 記錄，缺表不擋）：local-only/ddl-2026-09-13-parent-report-publications.sql
import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'
import { renderHtmlToPdf, MAX_HTML_BYTES } from '../../server/parent-report-pdf.js'
import { makeParentReportToken, parentReportOpenUrl, storagePathFor } from '../../server/parent-report-link.js'
import { schoolIdForAssignment } from '../../server/school-plan.js'

export const BUCKET = 'parent-reports'

async function canAccessAssignment(supabaseAdmin, user, assignmentId) {
  const { data: asg } = await supabaseAdmin.from('assignments').select('id, owner_id').eq('id', assignmentId).maybeSingle()
  if (!asg) return false
  if (asg.owner_id === user.id) return true
  const { data: prof } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (prof?.role === 'admin') return true
  const schoolId = await schoolIdForAssignment(supabaseAdmin, assignmentId)
  if (!schoolId) return false
  const { data: sa } = await supabaseAdmin.from('school_admins').select('school_id').eq('profile_id', user.id).eq('school_id', schoolId).maybeSingle()
  return !!sa
}

async function uploadPdf(supabaseAdmin, path, pdf) {
  const bucket = supabaseAdmin.storage.from(BUCKET)
  let { error } = await bucket.upload(path, pdf, { contentType: 'application/pdf', upsert: true })
  if (error && /bucket.*not found|not found/i.test(String(error.message || ''))) {
    // 第一次用：建私有 bucket 再重試
    const { error: cErr } = await supabaseAdmin.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 20 * 1024 * 1024 })
    if (cErr && !/already exists/i.test(String(cErr.message || ''))) throw cErr
    ;({ error } = await bucket.upload(path, pdf, { contentType: 'application/pdf', upsert: true }))
  }
  if (error) throw error
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }
  try {
    const { user } = await getAuthUser(req, res)
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }
    const assignmentId = String(req.body?.assignmentId ?? '').trim()
    const studentId = String(req.body?.studentId ?? '').trim()
    const html = req.body?.html
    const ttlDays = Number(req.body?.ttlDays) || 14
    if (!assignmentId || !studentId) { res.status(400).json({ error: 'Missing assignmentId/studentId' }); return }
    if (typeof html !== 'string' || !html.trim()) { res.status(400).json({ error: 'Missing html' }); return }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) { res.status(413).json({ error: 'HTML too large' }); return }
    const supabaseAdmin = getSupabaseAdmin()
    if (!(await canAccessAssignment(supabaseAdmin, user, assignmentId))) { res.status(403).json({ error: 'Forbidden' }); return }

    const pdf = await renderHtmlToPdf(html)
    const path = storagePathFor(assignmentId, studentId)
    await uploadPdf(supabaseAdmin, path, pdf)
    const { token, expiresAt } = makeParentReportToken(assignmentId, studentId, ttlDays)
    const url = parentReportOpenUrl(req, token)

    // 發布紀錄（best-effort；表未建只 warn）
    try {
      await supabaseAdmin.from('parent_report_publications').upsert({
        assignment_id: assignmentId, student_id: studentId, owner_id: user.id, storage_path: path,
        bytes: pdf.length, expires_at: expiresAt, published_at: new Date().toISOString(), open_count: 0, last_opened_at: null
      }, { onConflict: 'assignment_id,student_id' })
    } catch (e) { console.warn('[parent-publish] publication row failed (non-fatal):', e?.message) }

    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ url, expiresAt, path, bytes: pdf.length })
  } catch (err) {
    console.error('[parent-publish] failed:', err?.message)
    res.status(500).json({ error: err instanceof Error ? err.message : 'publish failed' })
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } },
}
