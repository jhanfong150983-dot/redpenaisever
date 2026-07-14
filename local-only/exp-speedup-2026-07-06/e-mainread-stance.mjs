// 主讀取立場條款＋compound 縮 padY 沙盒（2026-07-15）
// A) 立場遺失格（座2 3-4-4、座29 5-6-6）：現行紅框讀 vs +立場條款
// B) 4-5-5 串場格（座8/21/22/25）：padY 0.008 vs 0.002（紅框+新措辭都保留）
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
const { data: subs } = await sb.from('submissions').select('id, student_id, image_url, grading_result').eq('assignment_id', AID)
const { data: stus } = await sb.from('students').select('id, seat_number').in('id', subs.map((x) => x.student_id))
const subBySeat = new Map()
for (const sub of subs) { const seat = stus.find((s) => s.id === sub.student_id)?.seat_number; if (seat != null) subBySeat.set(seat, sub) }
const imgCache = new Map()
async function cropMarked(sub, b, padY = 0.008) {
  if (!imgCache.has(sub.id)) { const { data: img } = await sb.storage.from('homework-images').download(sub.image_url); imgCache.set(sub.id, Buffer.from(await img.arrayBuffer())) }
  const buf = imgCache.get(sub.id)
  const meta = await sharp(buf).metadata()
  const padX = 0.012
  const cx = Math.round(Math.max(0, b.x - padX) * meta.width), cy = Math.round(Math.max(0, b.y - padY) * meta.height)
  const cw = Math.min(meta.width - cx, Math.max(1, Math.round((Math.min(1, b.x + b.w + padX) - Math.max(0, b.x - padX)) * meta.width)))
  const ch = Math.min(meta.height - cy, Math.max(1, Math.round((Math.min(1, b.y + b.h + padY) - Math.max(0, b.y - padY)) * meta.height)))
  const rx = Math.round(b.x * meta.width) - cx - 3, ry = Math.round(b.y * meta.height) - cy - 3
  const rw = Math.round(b.w * meta.width) + 6, rh = Math.round(b.h * meta.height) + 6
  const svg = Buffer.from(`<svg width="${cw}" height="${ch}"><rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="red" stroke-width="4"/></svg>`)
  return (await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).composite([{ input: svg }]).jpeg({ quality: 90 }).toBuffer()).toString('base64')
}
const MARK = '每張圖中的「紅色方框」標示該題的作答區——只讀紅框內、紅框外（其他列/其他題）一律忽略。紅框內仍然只回報「學生手寫」的內容：印刷的題目文字、引導模板、選項文字都不要抄，只抄學生自己寫上去的字。'
const STANCE = '⚠ 若學生有「圈選/勾選印刷選項」或先寫立場詞（同意、不同意、支持、反對、或勾選的類別名），把該立場/選項抄在輸出最前面、再接理由——學生圈選的印刷選項文字算學生的作答、要抄出來；只有完全沒被圈選的印刷文字才不抄。'
const head = (stance) => `以下是「複合/簡答題」作答區的裁切放大圖。你是抄寫員：不知道正確答案，只忠實回報學生實際手寫的內容、不要猜。\n${MARK}${stance ? '\n' + STANCE : ''}\n回報內容用「｜」分隔立場與理由。沒寫→status="blank"。只輸出 JSON：{"answers":[{"questionId":"Q","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}`
async function read(prompt, crop) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await model.generateContent([prompt, { inlineData: { mimeType: 'image/jpeg', data: crop } }])
      const j = JSON.parse(res.response.text().replace(/```json|```/g, '').trim())
      const ans = Array.isArray(j?.answers) ? j.answers[0] : null
      if (ans) return String(ans.studentAnswerRaw ?? '')
    } catch { await new Promise((r) => setTimeout(r, 5000)) }
  }
  return '(ERR)'
}
console.log('══ A) 立場遺失格：現行 vs +立場條款 ══')
for (const [seat, qid, truth] of [[2, '3-4-4', '不同意|不是所有東西都由成績決定…'], [29, '5-6-6', '生活品質|因為有了洋行…']]) {
  const sub = subBySeat.get(seat)
  const gr = typeof sub.grading_result === 'string' ? JSON.parse(sub.grading_result) : sub.grading_result
  const b = (gr.details || []).find((d) => d.questionId === qid)?.answerBbox
  const crop = await cropMarked(sub, b)
  const [c1, c2, s1, s2] = await Promise.all([read(head(false), crop), read(head(false), crop), read(head(true), crop), read(head(true), crop)])
  console.log(`\n座${seat}|${qid} 真相≈${truth}`)
  console.log(`  現行  : ${c1.slice(0, 42)} / ${c2.slice(0, 42)}`)
  console.log(`  +立場 : ${s1.slice(0, 42)} / ${s2.slice(0, 42)}`)
}
console.log('\n══ B) 4-5-5 串場格：padY 0.008 vs 0.002（都含立場條款）══')
for (const [seat, qid, truth] of [[8, '4-5-5-2', '馬偕列'], [21, '4-5-5-2', '馬偕列'], [22, '4-5-5-2', '馬偕列'], [25, '4-5-5-2', '馬偕列(學生寫馬偕?斯文豪?)']]) {
  const sub = subBySeat.get(seat)
  const gr = typeof sub.grading_result === 'string' ? JSON.parse(sub.grading_result) : sub.grading_result
  const b = (gr.details || []).find((d) => d.questionId === qid)?.answerBbox
  const [wideCrop, tightCrop] = await Promise.all([cropMarked(sub, b, 0.008), cropMarked(sub, b, 0.002)])
  const [w1, w2, t1, t2] = await Promise.all([read(head(true), wideCrop), read(head(true), wideCrop), read(head(true), tightCrop), read(head(true), tightCrop)])
  console.log(`\n座${seat}|${qid} 真相≈${truth}`)
  console.log(`  寬pad : ${w1.slice(0, 42)} / ${w2.slice(0, 42)}`)
  console.log(`  窄pad : ${t1.slice(0, 42)} / ${t2.slice(0, 42)}`)
}
