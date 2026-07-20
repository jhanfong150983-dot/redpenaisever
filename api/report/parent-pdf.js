// 家長報告 PDF 產生（2026-07-18、user 拍板棄用 html2canvas 改伺服器端渲染）：
//   headless Chrome 渲染 client 傳來的報告 HTML → 回傳真 PDF 位元組（渲染 100% 準、直接下載檔案）。
//   中文字型：serverless chromium 無 CJK 字型 → HTML 內含 Google Fonts Noto Sans TC、開網路抓（waitUntil networkidle）。
//   安全：需登入；請求攔截只放行 data: 與 Google Fonts（阻擋任意外連＝防 SSRF）。
import chromium from '@sparticuz/chromium'
import puppeteer from 'puppeteer-core'
import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'

const MAX_HTML_BYTES = 4 * 1024 * 1024 // 單份報告 HTML（含校徽 data URI）上限

let browserPromise = null
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: { width: 794, height: 1123, deviceScaleFactor: 1 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    }).catch((err) => { browserPromise = null; throw err })
  }
  return browserPromise
}

function isAllowedResource(url) {
  return url.startsWith('data:')
    || url.startsWith('https://fonts.googleapis.com/')
    || url.startsWith('https://fonts.gstatic.com/')
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }

  try {
    const { user } = await getAuthUser(req, res)
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }

    const html = req.body?.html
    if (typeof html !== 'string' || !html.trim()) { res.status(400).json({ error: 'Missing html' }); return }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) { res.status(413).json({ error: 'HTML too large' }); return }

    const browser = await getBrowser()
    const page = await browser.newPage()
    try {
      await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 })
      // 只放行 data: 與字型 CDN，其餘一律 abort（防 SSRF、且報告本來就只需要這些）
      await page.setRequestInterception(true)
      page.on('request', (r) => { isAllowedResource(r.url()) ? r.continue() : r.abort() })

      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 })
      try { await page.evaluateHandle('document.fonts.ready') } catch { /* 字型就緒非必要條件 */ }

      // 2026-07-20：不再用高度換算 clamp 頁數。逐題錯題卡片有 break-inside:avoid，卡片跳頁會留白，
      //   高度計算無法反映真實列印頁數 → 會少算、把「五、老師的話」等結尾內容切掉（user 兩次回報）。
      //   改為讓 Chrome 自然分頁（絕不切內容）。CSS 用 break-before（非 break-after），不會產生結尾幽靈空白頁。
      const pdf = await page.pdf({
        printBackground: true,
        preferCSSPageSize: true, // 用 HTML 內的 @page（A4、margin:0）
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      })
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Length', pdf.length)
      res.setHeader('Cache-Control', 'no-store')
      res.status(200).send(Buffer.from(pdf))
    } finally {
      await page.close().catch(() => {})
    }
  } catch (err) {
    console.error('[parent-pdf] failed:', err?.message)
    res.status(500).json({ error: err instanceof Error ? err.message : 'PDF generation failed' })
  }
}

// 讓 Vercel 用 Node runtime（chromium 需要）；body 上限拉大放得下含校徽的 HTML。
export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } },
}
