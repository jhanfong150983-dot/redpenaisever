// 1-4-3 定罪探針:合成圖讀出的 D 是「真的看對」還是「抄了答案提示」?
// 盲讀(不給答案)×5 vs 知答(給答案 D)×5;另加單張裁圖對照。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const KEY = process.env.SYSTEM_GEMINI_API_KEY
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { cropInlineImageByBbox } = await import('../../server/ai/staged-grading.js')
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')
const SUB = '1778869835222-29yoyu4zd'
const { data: sub } = await db.from('submissions').select('phase_a_state').eq('id', SUB).maybeSingle()
const al = sub.phase_a_state?.classifyResult?.alignedQuestions ?? []
const q = al.find(x => String(x.questionId) === '1-4-3')
const r = await db.storage.from('homework-images').download(`submissions/${SUB}.webp`)
const imgB64 = Buffer.from(await r.data.arrayBuffer()).toString('base64')
const crop = await cropInlineImageByBbox(imgB64, 'image/webp', q.answerBbox, true, 0)
// 合成圖版:單格也做成「紅框+題號」的合成樣式(與 harness 一致的視覺處理)
const buf = Buffer.from(crop.data, 'base64'); const m = await sharp(buf).metadata()
const W = 460, H = Math.max(24, Math.round(m.height / m.width * W))
const rs = await sharp(buf).resize({ width: W, height: H, fit: 'fill' }).toBuffer()
const svg = `<svg width="${W + 16}" height="${H + 38}"><rect width="${W + 16}" height="${H + 38}" fill="white"/><text x="12" y="21" font-size="20" font-family="sans-serif" font-weight="bold" fill="#c00">1-4-3</text><rect x="6" y="28" width="${W + 4}" height="${H + 4}" fill="none" stroke="#c00" stroke-width="3"/></svg>`
const sheet = await sharp(Buffer.from(svg)).png().toBuffer().then(b => sharp(b).composite([{ input: rs, left: 8, top: 30 }]).jpeg({ quality: 92 }).toBuffer())
fs.writeFileSync(path.join(__dirname, 'q143_sheetstyle.jpg'), sheet)
const OUT = '沒寫→status="blank"。只輸出 JSON：{"answers":[{"questionId":"1-4-3","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}'
const BLIND = `以下是「選擇題」的作答區裁切放大圖。回報學生圈選或寫下的選項代號(字母或數字)。只回報學生實際手寫的內容、看不到就 blank。\n${OUT}`
const INFORMED = `以下是「選擇題」的作答區裁切放大圖。你是校對員：標籤附正確答案，只當「看仔細一點」的提示；仍只回報學生實際手寫的內容，絕不可把正確答案填進去。\n題號 1-4-3（正確答案：D）\n${OUT}`
const cfg = { generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' }, mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' } }
const ask = async (txt, imgPart) => {
  const res = await callGeminiGenerateContent({ apiKey: KEY, model: 'gemini-3.6-flash', contents: [{ role: 'user', parts: [{ text: txt }, imgPart] }], payload: cfg, timeoutMs: 60000 })
  const t = (res?.data?.candidates ?? []).flatMap(c => c?.content?.parts ?? []).map(p => p?.text ?? '').join('')
  const mm = t.match(/\{[\s\S]*\}/); if (!mm) return '?'
  try { const j = JSON.parse(mm[0]); const a = (j.answers || [])[0]; return a ? (a.status === 'read' ? String(a.studentAnswerRaw) : `[${a.status}]`) : '?' } catch { return '?' }
}
const sheetPart = { inlineData: { mimeType: 'image/jpeg', data: sheet.toString('base64') } }
const plainPart = { inlineData: crop }
for (const [label, part] of [['合成圖樣式', sheetPart], ['單張裁圖(現行)', plainPart]]) {
  const blind = [], inf = []
  for (let i = 0; i < 5; i++) blind.push(await ask(BLIND, part))
  for (let i = 0; i < 5; i++) inf.push(await ask(INFORMED, part))
  console.log(`${label.padEnd(14)} 盲讀×5: ${blind.join(' ')}   知答×5(提示D): ${inf.join(' ')}`)
}
console.log('\n標準答案=D、7月仲裁讀成 B 判錯 → 若盲讀也讀 D,代表 7 月冤枉了學生')
