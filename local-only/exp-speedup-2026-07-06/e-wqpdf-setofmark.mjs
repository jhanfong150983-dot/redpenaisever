// wq_pdf set-of-mark 沙盒（2026-07-14）：寬 pad＋紅框標本題＋只讀框內
// vs 現行 pad——靶=同 8 格（緊框沙盒的混合結果後、驗證紅框法兩全）
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
const CELLS = [
  [6, '1-1-3', 'choice', '2?'],
  [8, '6-7-4', 'choice', '|'],
  [25, '6-7-4', 'choice', '|'],
  [9, '6-7-5', 'choice', '?'],
  [20, '1-2-2', 'choice', '|=1'],
  [8, '4-5-5-2', 'compound', '馬偕|幫人拔牙|沒錢的人可以拔牙'],
  [5, '4-5-5-1', 'compound', '斯文豪列(黏字)'],
  [9, '4-5-5-1', 'compound', '斯文豪列'],
]
const { data: subs } = await sb.from('submissions').select('id, student_id, image_url, grading_result').eq('assignment_id', AID)
const { data: stus } = await sb.from('students').select('id, seat_number').in('id', subs.map((x) => x.student_id))
const subBySeat = new Map()
for (const sub of subs) { const seat = stus.find((s) => s.id === sub.student_id)?.seat_number; if (seat != null) subBySeat.set(seat, sub) }
const imgCache = new Map()
async function getBuf(sub) {
  if (!imgCache.has(sub.id)) { const { data: img } = await sb.storage.from('homework-images').download(sub.image_url); imgCache.set(sub.id, Buffer.from(await img.arrayBuffer())) }
  return imgCache.get(sub.id)
}
// set-of-mark：寬 pad（padX 0.012、padY 0.008≈整列上下各露一截）＋紅框畫在 bbox 原位
async function cropMarked(sub, b) {
  const buf = await getBuf(sub)
  const meta = await sharp(buf).metadata()
  const padX = 0.012, padY = 0.008
  const cx = Math.round(Math.max(0, b.x - padX) * meta.width), cy = Math.round(Math.max(0, b.y - padY) * meta.height)
  const cw = Math.min(meta.width - cx, Math.max(1, Math.round((Math.min(1, b.x + b.w + padX) - Math.max(0, b.x - padX)) * meta.width)))
  const ch = Math.min(meta.height - cy, Math.max(1, Math.round((Math.min(1, b.y + b.h + padY) - Math.max(0, b.y - padY)) * meta.height)))
  // 紅框位置＝bbox 在 crop 內的相對座標、稍微外擴 3px 不壓字
  const rx = Math.round(b.x * meta.width) - cx - 3, ry = Math.round(b.y * meta.height) - cy - 3
  const rw = Math.round(b.w * meta.width) + 6, rh = Math.round(b.h * meta.height) + 6
  const svg = Buffer.from(`<svg width="${cw}" height="${ch}"><rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="red" stroke-width="4"/></svg>`)
  return (await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).composite([{ input: svg }]).jpeg({ quality: 90 }).toBuffer()).toString('base64')
}
const P_CHOICE = `這是「選擇/是非題」作答區的裁切圖。圖中「紅色方框」標示本題的作答區——**只讀紅框內**學生圈選或寫下的選項代號（字母或數字）、紅框外的一律忽略。速記筆畫：一豎/一撇=1、Z形=2。紅框內沒寫→blank。只輸出 JSON：{"answers":[{"questionId":"Q","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}`
const P_COMPOUND = `這是「複合表格題」單列作答區的裁切圖。圖中「紅色方框」標示本題（本列）的作答區——**只讀紅框內**這一列的內容、紅框外（上下列）一律忽略。回報紅框內各欄學生手寫內容、用「｜」分隔。紅框內沒寫→blank。只輸出 JSON：{"answers":[{"questionId":"Q","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}`
async function read(prompt, crop) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await model.generateContent([prompt, { inlineData: { mimeType: 'image/jpeg', data: crop } }])
      const j = JSON.parse(res.response.text().replace(/```json|```/g, '').trim())
      const ans = Array.isArray(j?.answers) ? j.answers[0] : null
      if (ans) return String(ans.studentAnswerRaw ?? '') + (ans.status !== 'read' ? `(${ans.status})` : '')
    } catch { await new Promise((r) => setTimeout(r, 5000)) }
  }
  return '(ERR)'
}
for (const [seat, qid, type, truth] of CELLS) {
  const sub = subBySeat.get(seat)
  const gr = typeof sub.grading_result === 'string' ? JSON.parse(sub.grading_result) : sub.grading_result
  const b = (gr.details || []).find((d) => d.questionId === qid)?.answerBbox
  if (!b) { console.log(`座${seat}|${qid} no bbox`); continue }
  const crop = await cropMarked(sub, b)
  fs.writeFileSync(`som-${seat}-${qid}.jpg`, Buffer.from(crop, 'base64'))
  const prompt = type === 'choice' ? P_CHOICE : P_COMPOUND
  const [r1, r2, r3] = await Promise.all([read(prompt, crop), read(prompt, crop), read(prompt, crop)])
  console.log(`座${seat}|${qid} 真相=${truth} → 紅框法: ${r1.slice(0, 38)} / ${r2.slice(0, 38)} / ${r3.slice(0, 38)}`)
}
