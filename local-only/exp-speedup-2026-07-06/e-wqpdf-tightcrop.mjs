// wq_pdf 緊框沙盒（2026-07-14）：現行 read crop（inflate+dynamicPad）vs 列距夾制緊框
// 靶=r7 三疑點格：選擇題 off-by-one（座6 1-1-3 等）＋4-5-5 撈錯列（座8）
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
// [seat, qid, type, 人眼真相]
const CELLS = [
  [6, '1-1-3', 'choice', '2'],
  [8, '6-7-4', 'choice', '|=1?'],
  [25, '6-7-4', 'choice', '|=1?'],
  [9, '6-7-5', 'choice', '?'],
  [20, '1-2-2', 'choice', '|=1?'],
  [8, '4-5-5-2', 'compound', '馬偕|幫人拔牙|沒錢的人可以拔牙'],
  [5, '4-5-5-1', 'compound', '斯文豪列(黏字)'],
  [9, '4-5-5-1', 'compound', '斯文豪列?'],
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
// 現行 wq_pdf read crop：inflate(0.005~0.01) + dynamicPad(0.03/6=0.005)
// 緊框：不 inflate、padX 0.008、padY 夾到 min(0.005, 0.35×最近鄰列距) —— 鄰列距用同卷其他題 bbox 算
async function cropWith(sub, b, mode, allB) {
  const buf = await getBuf(sub)
  const meta = await sharp(buf).metadata()
  let padX, padY, bb = b
  if (mode === 'cur') {
    const inf = 0.0075 // inflate 近似（choice 0.005、compound 0.01 的折中示意——分開算更準但先近似）
    bb = { x: Math.max(0, b.x - inf), y: Math.max(0, b.y - inf), w: Math.min(1, b.x + b.w + inf) - Math.max(0, b.x - inf), h: Math.min(1, b.y + b.h + inf) - Math.max(0, b.y - inf) }
    padX = 0.005; padY = 0.005
  } else {
    // tight：列距夾制
    let pitch = Infinity
    const cy = b.y + b.h / 2
    for (const ob of allB) {
      if (ob === b) continue
      if (Math.min(b.x + b.w, ob.x + ob.w) - Math.max(b.x, ob.x) <= 0) continue
      const d = Math.abs(cy - (ob.y + ob.h / 2))
      if (d > 1e-6 && d < pitch) pitch = d
    }
    padX = 0.008
    padY = Math.min(0.005, +(0.35 * (pitch === Infinity ? 0.005 : Math.max(0, pitch - b.h))).toFixed(5))
  }
  const x = Math.round(Math.max(0, bb.x - padX) * meta.width), y = Math.round(Math.max(0, bb.y - padY) * meta.height)
  const w = Math.min(meta.width - x, Math.max(1, Math.round((Math.min(1, bb.x + bb.w + padX) - Math.max(0, bb.x - padX)) * meta.width)))
  const h = Math.min(meta.height - y, Math.max(1, Math.round((Math.min(1, bb.y + bb.h + padY) - Math.max(0, bb.y - padY)) * meta.height)))
  return (await sharp(buf).extract({ left: x, top: y, width: w, height: h }).jpeg({ quality: 90 }).toBuffer()).toString('base64')
}
const PROMPT_CHOICE = `這是「選擇/是非題」一題的作答區裁切圖。回報學生圈選或寫下的選項代號（字母或數字）。速記筆畫：一豎/一撇=1、Z形=2。沒寫→blank。只輸出 JSON：{"answers":[{"questionId":"Q","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}`
const PROMPT_COMPOUND = `這是「複合表格題」一題（單列）的作答區裁切圖。回報學生此列各欄實際手寫內容、用「｜」分隔各欄。只抄本列、不要抄其他列。沒寫→blank。只輸出 JSON：{"answers":[{"questionId":"Q","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}`
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
  const allB = (gr.details || []).map((d) => d.answerBbox).filter(Boolean)
  const prompt = type === 'choice' ? PROMPT_CHOICE : PROMPT_COMPOUND
  const [curCrop, tightCrop] = await Promise.all([cropWith(sub, b, 'cur', allB), cropWith(sub, b, 'tight', allB)])
  const [c1, c2, t1, t2] = await Promise.all([read(prompt, curCrop), read(prompt, curCrop), read(prompt, tightCrop), read(prompt, tightCrop)])
  console.log(`\n座${seat}|${qid} 真相=${truth}`)
  console.log(`  現行pad: ${c1.slice(0, 40)} / ${c2.slice(0, 40)}`)
  console.log(`  緊框   : ${t1.slice(0, 40)} / ${t2.slice(0, 40)}`)
}
