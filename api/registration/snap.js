// 答案卷框「貼齊格線」（2026-09-14）：建卷時把 AI 抓的 answerBbox 貼到老師掃描卷自己的印刷格線上，
//   老師檢核看到的就是批改會裁的格；批改時每位學生仍各自疊合＋吸附（掃描歪斜是每張不同的）。
//   純轉發到 registration-service /snap（Cloud Run、零 AI）；沒設 REGISTRATION_URL 回 503、client fail-open。
//   POST { pages: [base64], boxes: [{ id, page, bbox, kind }] } → { boxes: [{ id, page, bbox, snapped_edges }], pages, ms }
import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'

const MAX_PAGES = 12

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }
  const url = process.env.REGISTRATION_URL
  if (!url || process.env.REGISTRATION_ENABLED === '0') { res.status(503).json({ error: 'registration disabled' }); return }
  const { user } = await getAuthUser(req, res)
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }
  const pages = Array.isArray(req.body?.pages) ? req.body.pages : []
  const boxes = Array.isArray(req.body?.boxes) ? req.body.boxes : []
  if (pages.length === 0 || pages.length > MAX_PAGES || boxes.length === 0) { res.status(400).json({ error: 'pages/boxes required' }); return }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.REGISTRATION_TIMEOUT_MS) || 30000)
  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/snap`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ template_id: req.body?.templateId || null, pages, boxes })
    })
    const data = await resp.json().catch(() => null)
    if (!resp.ok || !data) { res.status(502).json({ error: `registration service ${resp.status}` }); return }
    res.status(200).json(data)
  } catch (err) {
    res.status(502).json({ error: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'snap failed') })
  } finally {
    clearTimeout(timer)
  }
}
