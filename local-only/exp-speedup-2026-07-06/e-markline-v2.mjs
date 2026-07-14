// markLine v2 沙盒（2026-07-15）：r8 印刷模板污染回歸——舊措辭 vs 手寫限定措辭
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '../../../redpenai/node_modules/@google/generative-ai/dist/index.mjs'

const envTxt = fs.readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
for (const l of envTxt.split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const genAI = new GoogleGenerativeAI(process.env.SYSTEM_GEMINI_API_KEY)
const sharp = (await import('sharp')).default
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { temperature: 0 } })
const AID = '1778510937216-3s4c2x9th'
// r8 被印刷模板污染的格子（r7 曾正確讀出手寫）
const CELLS = [
  [3, '3-4-4', '同意｜雖然現在不是清帝國…'],
  [6, '3-4-4', '同意｜現在工作都看學力…'],
  [15, '2-3-6', '支持｜那些難民有可能…'],
  [24, '2-3-6', '支持｜人和人之間本來就要…'],
  [28, '3-4-4', '不同意｜不一定每個人都适…'],
]
const { data: subs } = await sb.from('submissions').select('id, student_id, image_url, grading_result').eq('assignment_id', AID)
const { data: stus } = await sb.from('students').select('id, seat_number').in('id', subs.map((x) => x.student_id))
const subBySeat = new Map()
for (const sub of subs) { const seat = stus.find((s) => s.id === sub.student_id)?.seat_number; if (seat != null) subBySeat.set(seat, sub) }
const imgCache = new Map()
async function cropMarked(sub, b) {
  if (!imgCache.has(sub.id)) { const { data: img } = await sb.storage.from('homework-images').download(sub.image_url); imgCache.set(sub.id, Buffer.from(await img.arrayBuffer())) }
  const buf = imgCache.get(sub.id)
  const meta = await sharp(buf).metadata()
  const padX = 0.012, padY = 0.008
  const cx = Math.round(Math.max(0, b.x - padX) * meta.width), cy = Math.round(Math.max(0, b.y - padY) * meta.height)
  const cw = Math.min(meta.width - cx, Math.max(1, Math.round((Math.min(1, b.x + b.w + padX) - Math.max(0, b.x - padX)) * meta.width)))
  const ch = Math.min(meta.height - cy, Math.max(1, Math.round((Math.min(1, b.y + b.h + padY) - Math.max(0, b.y - padY)) * meta.height)))
  const rx = Math.round(b.x * meta.width) - cx - 3, ry = Math.round(b.y * meta.height) - cy - 3
  const rw = Math.round(b.w * meta.width) + 6, rh = Math.round(b.h * meta.height) + 6
  const svg = Buffer.from(`<svg width="${cw}" height="${ch}"><rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="red" stroke-width="4"/></svg>`)
  return (await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).composite([{ input: svg }]).jpeg({ quality: 90 }).toBuffer()).toString('base64')
}
const OLD = '每張圖中的「紅色方框」標示該題的作答區——只讀紅框內的內容、紅框外（其他列/其他題）一律忽略。'
const NEW = '每張圖中的「紅色方框」標示該題的作答區——只讀紅框內、紅框外（其他列/其他題）一律忽略。紅框內仍然只回報「學生手寫」的內容：印刷的題目文字、引導模板（如「我（同意/不同意），因為」）、選項文字都不要抄，只抄學生自己寫上去的字。'
const head = (mark) => `以下是「複合題」作答區的裁切放大圖。你是抄寫員：不知道正確答案，只忠實回報學生實際手寫的內容、不要猜。\n${mark}回報學生圈選的立場與手寫理由、用「｜」分隔。\n沒寫→status="blank"。只輸出 JSON：{"answers":[{"questionId":"Q","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}`
async function read(mark, crop) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await model.generateContent([head(mark), { inlineData: { mimeType: 'image/jpeg', data: crop } }])
      const j = JSON.parse(res.response.text().replace(/```json|```/g, '').trim())
      const ans = Array.isArray(j?.answers) ? j.answers[0] : null
      if (ans) return String(ans.studentAnswerRaw ?? '')
    } catch { await new Promise((r) => setTimeout(r, 5000)) }
  }
  return '(ERR)'
}
for (const [seat, qid, truth] of CELLS) {
  const sub = subBySeat.get(seat)
  const gr = typeof sub.grading_result === 'string' ? JSON.parse(sub.grading_result) : sub.grading_result
  const b = (gr.details || []).find((d) => d.questionId === qid)?.answerBbox
  if (!b) continue
  const crop = await cropMarked(sub, b)
  const [o1, o2, n1, n2] = await Promise.all([read(OLD, crop), read(OLD, crop), read(NEW, crop), read(NEW, crop)])
  console.log(`\n座${seat}|${qid} 真相≈${truth}`)
  console.log(`  舊措辭: ${o1.slice(0, 42)} / ${o2.slice(0, 42)}`)
  console.log(`  新措辭: ${n1.slice(0, 42)} / ${n2.slice(0, 42)}`)
}
