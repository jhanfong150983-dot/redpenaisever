// 家長開報告（2026-09-13）：GET /api/report/parent-open?t=<token> → 驗簽章與到期 → 從 Storage 取 PDF → 直接顯示（inline）。
//   不需登入（家長沒有 RedPen 帳號）；安全性靠連結不可猜（HMAC）＋到期（預設 14 天）。
//   開啟次數 best-effort 記到 parent_report_publications（缺表不擋）。
import { getSupabaseAdmin } from '../../server/_supabase.js'
import { verifyParentReportToken, storagePathFor } from '../../server/parent-report-link.js'
import { BUCKET } from './parent-publish.js'

const page = (title, body) => `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center}
.c{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px 28px;max-width:420px;text-align:center}h1{font-size:20px;margin:0 0 10px}p{color:#64748b;margin:0;line-height:1.6}</style></head>
<body><div class="c"><h1>${title}</h1><p>${body}</p></div></body></html>`

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).send('Method Not Allowed'); return }
  const v = verifyParentReportToken(String(req.query?.t ?? ''))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  if (!v.ok) {
    const msg = v.reason === 'expired' ? '這份報告的連結已過期，請向老師索取新的連結。' : '連結無效，請確認是否完整複製。'
    res.status(v.reason === 'expired' ? 410 : 400).setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(page(v.reason === 'expired' ? '連結已過期' : '連結無效', msg))
    return
  }
  try {
    const supabaseAdmin = getSupabaseAdmin()
    const path = storagePathFor(v.assignmentId, v.studentId)
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path)
    if (error || !data) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(page('找不到報告', '這份報告可能已被重新產生或移除，請向老師索取新的連結。'))
      return
    }
    const buf = Buffer.from(await data.arrayBuffer())
    try {
      const { data: row } = await supabaseAdmin.from('parent_report_publications').select('open_count').eq('assignment_id', v.assignmentId).eq('student_id', v.studentId).maybeSingle()
      await supabaseAdmin.from('parent_report_publications')
        .update({ open_count: (row?.open_count ?? 0) + 1, last_opened_at: new Date().toISOString() })
        .eq('assignment_id', v.assignmentId).eq('student_id', v.studentId)
    } catch { /* 缺表不擋 */ }
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', String(buf.length))
    res.setHeader('Content-Disposition', 'inline; filename="report.pdf"')
    res.status(200).send(buf)
  } catch (err) {
    console.error('[parent-open] failed:', err?.message)
    res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(page('暫時無法開啟', '請稍後再試一次。'))
  }
}
