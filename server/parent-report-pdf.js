// 家長報告 HTML → PDF（headless Chrome）共用渲染器（2026-09-13 從 api/report/parent-pdf.js 抽出，
//   供 parent-pdf（老師即時下載）與 parent-publish（存 Storage、給家長連結）共用）。
//   中文字型：serverless chromium 無 CJK 字型 → HTML 內含 Google Fonts Noto Sans TC、開網路抓。
//   安全：請求攔截只放行 data: 與 Google Fonts（阻擋任意外連＝防 SSRF）。
import chromium from '@sparticuz/chromium'
import puppeteer from 'puppeteer-core'

export const MAX_HTML_BYTES = 4 * 1024 * 1024 // 單份報告 HTML（含校徽 data URI）上限

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

/** @returns {Promise<Buffer>} PDF bytes */
export async function renderHtmlToPdf(html) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 })
    await page.setRequestInterception(true)
    page.on('request', (r) => { isAllowedResource(r.url()) ? r.continue() : r.abort() })
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 })
    try { await page.evaluateHandle('document.fonts.ready') } catch { /* 字型就緒非必要條件 */ }
    // 2026-07-20：讓 Chrome 自然分頁（絕不切內容）；CSS 用 break-before，不會產生結尾幽靈空白頁。
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    })
    return Buffer.from(pdf)
  } finally {
    await page.close().catch(() => {})
  }
}
