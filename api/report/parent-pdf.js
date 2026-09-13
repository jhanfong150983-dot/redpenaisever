// 家長報告 PDF 產生（2026-07-18、user 拍板棄用 html2canvas 改伺服器端渲染）：
//   headless Chrome 渲染 client 傳來的報告 HTML → 回傳真 PDF 位元組（渲染 100% 準、直接下載檔案）。
//   中文字型：serverless chromium 無 CJK 字型 → HTML 內含 Google Fonts Noto Sans TC、開網路抓（waitUntil networkidle）。
//   安全：需登入；請求攔截只放行 data: 與 Google Fonts（阻擋任意外連＝防 SSRF）。
import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { renderHtmlToPdf, MAX_HTML_BYTES } from '../../server/parent-report-pdf.js'

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }

  try {
    const { user } = await getAuthUser(req, res)
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }

    const html = req.body?.html
    if (typeof html !== 'string' || !html.trim()) { res.status(400).json({ error: 'Missing html' }); return }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) { res.status(413).json({ error: 'HTML too large' }); return }

    // 2026-09-13 渲染器抽到 server/parent-report-pdf.js（與 parent-publish 共用）
    const pdf = await renderHtmlToPdf(html)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', pdf.length)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(pdf)
  } catch (err) {
    console.error('[parent-pdf] failed:', err?.message)
    res.status(500).json({ error: err instanceof Error ? err.message : 'PDF generation failed' })
  }
}

// 讓 Vercel 用 Node runtime（chromium 需要）；body 上限拉大放得下含校徽的 HTML。
export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } },
}
