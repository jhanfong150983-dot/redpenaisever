// 擴大測試(2026-08-07):合成圖 vs 現行,跨 6 份國語卷(分數帶 26~92 = 字跡品質帶)。
// 每卷每臂跑 2 次 → 判準:①兩次一致 ②對 GT 不低於 BASE ③無題號錯位/缺題
// 額外記錄:盲讀(AI1)與知答(AI2)分別的一致率 → 看合成圖是否造成答案洩漏
// classify 跳過、直接用 phase_a_state 的 bbox(user 指示)。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const KEY = process.env.SYSTEM_GEMINI_API_KEY
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { cropInlineImageByBbox, normalizeAnswerForComparison } = await import('../../server/ai/staged-grading.js')
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')

const MODEL = 'gemini-3.6-flash'
const RATE = [1.50, 7.50], USD_TWD = 33
// 6 份:A班低/中/高 + B班低/中/高(分數帶=字跡與作答完整度帶)
const FIXTURES = [
  { sub: '1778869832162-i57h81yzo', aid: '1778869700051-ollsjczry', tag: 'A-26' },
  { sub: '1778869835222-29yoyu4zd', aid: '1778869700051-ollsjczry', tag: 'A-48' },
  { sub: '1778869834039-ak5k75s9f', aid: '1778869700051-ollsjczry', tag: 'A-92' },
  { sub: '1778870070504-uyw1d4wcv', aid: '1778869875728-wlkato1nr', tag: 'B-41' },
  { sub: '1778870069933-v66houty9', aid: '1778869875728-wlkato1nr', tag: 'B-57' },
  { sub: '1778870069864-x9q3xoi9h', aid: '1778869875728-wlkato1nr', tag: 'B-88' },
]

const RULE = {
  choice: '這些是「選擇/是非題」：回報學生圈選或寫下的選項代號(字母或數字)。',
  text: '這些是「填空/簡答題」：回報學生手寫的文字內容。若學生寫的是句子或片語，請輸出「完整連續的一句」(照原樣、保留詞間空格)，不要拆成逗號分隔的單字碎片。⚠ 若學生有「圈選/勾選印刷選項」或先寫立場詞（同意、不同意、支持、反對、勾選的類別名），把該立場抄在輸出最前面、用「｜」接理由——學生圈選的印刷選項文字算學生的作答、要抄出來。',
}
const OUT = '沒寫→status="blank"、有寫看不懂→status="unreadable"。只輸出 JSON：{"answers":[{"questionId":"...","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}'
const headAI1 = (f) => `以下是多張「同一題型」的作答區裁切放大圖，每張圖前有題號標籤。只回報學生實際手寫的內容、看不到就 blank。\n${RULE[f] || '回報學生手寫的內容。'}\n${OUT}`
const headAI2 = (f) => `以下是多張「同一題型」的作答區裁切放大圖，每張圖前有題號標籤。你是校對員：每題標籤可能附正確答案，只當「看仔細一點」的提示；仍只回報學生實際手寫的內容、看不到就 blank，絕不可把正確答案填進去。\n${RULE[f] || '回報學生手寫的內容。'}\n${OUT}`
const CFG = { single_choice: { batch: 20, family: 'choice' }, true_false: { batch: 30, family: 'choice' }, fill_blank: { batch: 30, family: 'text' }, short_answer: { batch: 10, family: 'text' }, ordering: { batch: 1, family: 'ordering' } }
const SKIP = new Set(['multi_fill', 'map_fill', 'diagram_color', 'grid_geometry', 'map_symbol'])
const parseAnswers = (data) => { const t = (data?.candidates ?? []).flatMap(c => c?.content?.parts ?? []).map(p => p?.text ?? '').join(''); const m = t.match(/\{[\s\S]*\}/); if (!m) return null; try { const j = JSON.parse(m[0]); return Array.isArray(j.answers) ? j.answers : null } catch { return null } }

const CELL_W = 460, LABEL_H = 30, GAP = 8
async function buildSheet(cells) {
  const totalH = cells.reduce((a, c) => a + c.h + LABEL_H + GAP, 0) + GAP
  const W = CELL_W + GAP * 2, comps = [], svg = [`<rect width="${W}" height="${totalH}" fill="white"/>`]
  let y = GAP
  for (const c of cells) {
    svg.push(`<text x="${GAP + 4}" y="${y + 21}" font-size="20" font-family="sans-serif" font-weight="bold" fill="#c00">${c.qid}</text>`)
    const top = y + LABEL_H
    svg.push(`<rect x="${GAP - 2}" y="${top - 2}" width="${CELL_W + 4}" height="${c.h + 4}" fill="none" stroke="#c00" stroke-width="3"/>`)
    comps.push({ input: c.buf, left: GAP, top }); y = top + c.h + GAP
  }
  const base = await sharp(Buffer.from(`<svg width="${W}" height="${totalH}">${svg.join('')}</svg>`)).png().toBuffer()
  return await sharp(base).composite(comps).jpeg({ quality: 92 }).toBuffer()
}

let acc
async function call(parts) {
  const r = await callGeminiGenerateContent({ apiKey: KEY, model: MODEL, contents: [{ role: 'user', parts }], payload: { generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' }, mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' } }, timeoutMs: 180000 })
  const u = r?.data?.usageMetadata ?? {}
  const imgTok = (u.promptTokensDetails ?? []).find(d => d.modality === 'IMAGE')?.tokenCount ?? 0
  const cached = u.cachedContentTokenCount ?? 0
  acc.calls++; acc.img += imgTok
  const billIn = Math.max(0, (u.promptTokenCount ?? 0) - cached) + cached * 0.1
  acc.cost += (billIn / 1e6 * RATE[0] + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) / 1e6 * RATE[1]) * USD_TWD
  return parseAnswers(r?.data)
}

async function runPaper(fx, arm) {
  const { data: sub } = await db.from('submissions').select('phase_a_state').eq('id', fx.sub).maybeSingle()
  const { data: asg } = await db.from('assignments').select('answer_key').eq('id', fx.aid).maybeSingle()
  const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
  const akById = new Map(ak.questions.map(q => [String(q.id), q]))
  const gz = (qid) => { const k = akById.get(qid); if (!k || String(k.questionCategory ?? '') !== 'fill_blank') return false; const key = String(k.answer ?? k.referenceAnswer ?? '').trim(); return /^[一-鿿]{1,2}$/u.test(key) || /^[ㄅ-ㄩˊˇˋ˙]{1,5}$/u.test(key) }
  const al = sub.phase_a_state?.classifyResult?.alignedQuestions ?? []
  const gt = new Map(); for (const d of (sub.phase_a_state?.arbiterDecisions ?? [])) gt.set(String(d.questionId), d.finalAnswer)
  const readable = al.filter(q => q.visible && q.answerBbox && !SKIP.has(q.questionType) && !gz(String(q.questionId)))
  const r = await db.storage.from('homework-images').download(`submissions/${fx.sub}.webp`)
  const imgB64 = Buffer.from(await r.data.arrayBuffer()).toString('base64')
  const hintOf = (qid) => { const k = akById.get(qid); const ps = Array.isArray(k?.parts) && k.parts.length >= 2 ? k.parts : null; return ps ? ps.map(p => `${p.subId}=${p?.answer ?? ''}`).join('；') : String(k?.answer || k?.referenceAnswer || '').trim() }

  const groups = new Map(); for (const q of readable) { const t = q.questionType; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(q) }
  const g1 = new Map(), g2 = new Map()
  for (const [type, qs] of groups) {
    const cfg = CFG[type] ?? { batch: 15, family: 'text' }
    for (let i = 0; i < qs.length; i += cfg.batch) {
      const batch = qs.slice(i, i + cfg.batch)
      const crops = []
      for (const q of batch) { const c = await cropInlineImageByBbox(imgB64, 'image/webp', q.answerBbox, true, 0); if (c) crops.push({ q, c }) }
      if (!crops.length) continue
      let p1, p2
      if (arm === 'SHEET') {
        const cells = []
        for (const { q, c } of crops) {
          const buf = Buffer.from(c.data, 'base64'); const m = await sharp(buf).metadata()
          const h = Math.max(24, Math.round(m.height / m.width * CELL_W))
          cells.push({ qid: String(q.questionId), buf: await sharp(buf).resize({ width: CELL_W, height: h, fit: 'fill' }).toBuffer(), h })
        }
        const sheetBuf = await buildSheet(cells)
        const part = { inlineData: { mimeType: 'image/jpeg', data: sheetBuf.toString('base64') } }
        const note = (withAns) => `\n⚠ 這是一張「合成圖」：由多格作答區上下排列組成，每格左上角有紅色題號、外圍有紅框。請逐格處理，題號依序為：${cells.map(c => withAns ? `${c.qid}${hintOf(c.qid) ? `（正確答案：${hintOf(c.qid)}）` : ''}` : c.qid).join('、')}。`
        p1 = [{ text: headAI1(cfg.family) + note(false) }, part]
        p2 = [{ text: headAI2(cfg.family) + note(true) }, part]
      } else {
        p1 = [{ text: headAI1(cfg.family) }]; p2 = [{ text: headAI2(cfg.family) }]
        for (const { q, c } of crops) {
          const id = String(q.questionId)
          p1.push({ text: `--- 題目 ${id}（類型：${q.questionType}）---` }, { inlineData: c })
          p2.push({ text: `--- 題目 ${id}（類型：${q.questionType}${hintOf(id) ? `，正確答案：${hintOf(id)}` : ''}）---` }, { inlineData: c })
        }
      }
      const [a1, a2] = await Promise.all([call(p1), call(p2)])
      for (const a of a1 ?? []) g1.set(String(a.questionId), a)
      for (const a of a2 ?? []) g2.set(String(a.questionId), a)
    }
  }
  const ev = (got) => {
    let match = 0, missing = 0, blank = 0
    for (const q of readable) {
      const qid = String(q.questionId), a = got.get(qid)
      if (!a) { missing++; continue }
      if (a.status === 'blank') blank++
      if (normalizeAnswerForComparison(String(gt.get(qid) ?? '')) === normalizeAnswerForComparison(String(a.status === 'blank' ? '' : a.studentAnswerRaw ?? ''))) match++
    }
    return { match, missing, blank, n: readable.length }
  }
  return { ai1: ev(g1), ai2: ev(g2), snap2: [...g2.entries()].sort().map(([k, v]) => `${k}=${v.status === 'blank' ? '' : String(v.studentAnswerRaw ?? '')}`).join('|') }
}

// ── 主 ──
const out = []
for (const fx of FIXTURES) {
  for (const arm of ['BASE', 'SHEET']) {
    const runs = []
    for (const run of [1, 2]) {
      acc = { calls: 0, img: 0, cost: 0 }
      const t0 = Date.now()
      const r = await runPaper(fx, arm)
      runs.push({ ...r, ...acc, sec: Math.round((Date.now() - t0) / 1000) })
    }
    const same = runs[0].snap2 === runs[1].snap2
    const rec = { tag: fx.tag, arm, same, n: runs[0].ai2.n, ai2: runs.map(r => r.ai2.match), ai1: runs.map(r => r.ai1.match), missing: Math.max(...runs.map(r => r.ai2.missing)), img: runs[0].img, cost: (runs[0].cost + runs[1].cost) / 2, sec: runs[0].sec }
    out.push(rec)
    console.log(`[${fx.tag} ${arm}] 兩次${same ? '一致✅' : '有diff❌'}  AI2對GT ${rec.ai2.join('/')}/${rec.n}  AI1(盲) ${rec.ai1.join('/')}  缺題${rec.missing}  圖tok ${rec.img}  NT$${rec.cost.toFixed(2)}`)
  }
}
fs.writeFileSync(path.join(__dirname, 'result-multi.json'), JSON.stringify(out, null, 1))

console.log('\n================ 擴大測試彙總 ================')
console.log('卷'.padEnd(7), '臂'.padEnd(7), '兩次一致'.padEnd(9), 'AI2對GT'.padEnd(12), 'AI1盲讀'.padEnd(10), '缺題', ' NT$'.padStart(7), ' 判定')
let sumB = 0, sumS = 0, verdicts = []
for (const fx of FIXTURES) {
  const b = out.find(r => r.tag === fx.tag && r.arm === 'BASE'), s = out.find(r => r.tag === fx.tag && r.arm === 'SHEET')
  if (!b || !s) continue
  sumB += b.cost; sumS += s.cost
  const bw = Math.min(...b.ai2), sw = Math.min(...s.ai2)
  const v = !s.same ? '❌兩次有diff' : s.missing > b.missing ? '❌缺題增加' : sw < bw ? `❌品質退步(${sw}<${bw})` : sw > bw ? `✅更好(+${sw - bw})` : '✅持平'
  verdicts.push(v)
  for (const [arm, r] of [['BASE', b], ['SHEET', s]]) {
    console.log(fx.tag.padEnd(7), arm.padEnd(7), (r.same ? '✅' : '❌').padEnd(9), (r.ai2.join('/') + '/' + r.n).padEnd(12), r.ai1.join('/').padEnd(10), String(r.missing).padStart(3), r.cost.toFixed(2).padStart(7), arm === 'SHEET' ? ' ' + v : '')
  }
}
console.log(`\n總成本 BASE NT$${sumB.toFixed(1)} → SHEET NT$${sumS.toFixed(1)}  (${((sumS / sumB - 1) * 100).toFixed(0)}%)`)
console.log('判定:', verdicts.filter(v => v.startsWith('✅')).length + '/' + verdicts.length + ' 通過')
