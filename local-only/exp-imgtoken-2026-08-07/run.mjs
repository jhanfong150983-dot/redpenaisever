// 降本第二波 harness(2026-08-07):圖片 token 佔 64% 帳單 → 測「省圖片」的四條路。
//
// 素材:國語卷(圖最多)、classify 跳過直接用 phase_a_state 的 bbox(user 指示)。
// GT = phase_a_state.arbiterDecisions.finalAnswer(判官驗收過的產物)。
// 鏡像 production(staged-grading 全域讀):AI1 盲讀 + AI2 知答校對、同一批 crop、ao_pdf 零 pad。
//
// 臂:
//   BASE      現行:[prompt, (標籤,圖)×N]、AI1∥AI2 平行            ← 對照組
//   IMGF      圖片優先:[圖×N, prompt+全部標籤]、AI1→AI2 序列化      ← 吃隱式快取
//   SHEET     合成圖:16 張裁圖排成 1 張標號大圖、MEDIUM、AI1∥AI2   ← 減少 image part
//   SHEETHI   合成圖 + HIGH 解析度(1120 tok/圖,仍遠少於 16×560)   ← 兼顧細節
//   SHEETIF   合成圖 + 圖片優先 + 序列化                            ← 疊加
//
// 每臂跑兩次(user 判準:兩次一致無 diff 才值得擴大)。
// 指標:GT 一致率 / blank / unreadable / 缺題 / cachedContentTokenCount / 圖片tok / NT$ / 秒
// 否決線:任一品質指標比 BASE 退步 → 該臂否決(user 硬約束:品質不可變動)
//
// 用法:node run.mjs [臂,逗號分隔;預設全跑]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const KEY = process.env.SYSTEM_GEMINI_API_KEY
if (!KEY) { console.error('⛔ 無 SYSTEM_GEMINI_API_KEY'); process.exit(1) }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { cropInlineImageByBbox, normalizeAnswerForComparison } = await import('../../server/ai/staged-grading.js')
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')

const SUB_ID = '1778869835222-29yoyu4zd'   // 國語定期評量、score 48、arbiterDecisions 60 筆
const AID = '1778869700051-ollsjczry'
const MODEL = 'gemini-3.6-flash'           // production read 檔位(MODEL_PRO)
const RATE = [1.50, 7.50]                  // 儀表板費率 USD/1M in,out
const USD_TWD = 33

// ── 素材 ──
const { data: sub } = await db.from('submissions').select('phase_a_state').eq('id', SUB_ID).maybeSingle()
const { data: asg } = await db.from('assignments').select('answer_key').eq('id', AID).maybeSingle()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
const akById = new Map(ak.questions.map(q => [String(q.id), q]))
const img = await db.storage.from('homework-images').download(`submissions/${SUB_ID}.webp`)
const imgB64 = Buffer.from(await img.data.arrayBuffer()).toString('base64')
const aligned = sub.phase_a_state?.classifyResult?.alignedQuestions ?? []
const gtByQid = new Map()
for (const d of (sub.phase_a_state?.arbiterDecisions ?? [])) gtByQid.set(String(d.questionId), d.finalAnswer)
if (gtByQid.size === 0) { console.error('⛔ GT 空,中止'); process.exit(1) }

// production gzIsVjCell:國字注音格拔 read(交判官)
const gzIsVjCell = (qid) => {
  const k = akById.get(qid)
  if (!k || String(k.questionCategory ?? '') !== 'fill_blank') return false
  const key = String(k.answer ?? k.referenceAnswer ?? '').trim()
  return /^[一-鿿]{1,2}$/u.test(key) || /^[ㄅ-ㄩˊˇˋ˙]{1,5}$/u.test(key)
}
const SKIP = new Set(['multi_fill', 'map_fill', 'diagram_color', 'grid_geometry', 'map_symbol'])
const readable = aligned.filter(q => q.visible && q.answerBbox && !SKIP.has(q.questionType) && !gzIsVjCell(String(q.questionId)))
const CFG = {
  single_choice: { batch: 20, family: 'choice' },
  true_false: { batch: 30, family: 'choice' },
  fill_blank: { batch: 30, family: 'text' },
  short_answer: { batch: 10, family: 'text' },
  ordering: { batch: 1, family: 'ordering' },
}
console.log(`可讀題 ${readable.length}、題型:`, JSON.stringify(readable.reduce((o, q) => { o[q.questionType] = (o[q.questionType] || 0) + 1; return o }, {})))

// ── prompt(鏡像 production tsReadHead / buildReviewReadPrompt 摘錄)──
const RULE = {
  choice: '這些是「選擇/是非題」：回報學生圈選或寫下的選項代號(字母或數字)。',
  text: '這些是「填空/簡答題」：回報學生手寫的文字內容。若學生寫的是句子或片語，請輸出「完整連續的一句」(照原樣、保留詞間空格)，不要拆成逗號分隔的單字碎片。⚠ 若學生有「圈選/勾選印刷選項」或先寫立場詞（同意、不同意、支持、反對、勾選的類別名），把該立場抄在輸出最前面、用「｜」接理由——學生圈選的印刷選項文字算學生的作答、要抄出來。',
}
const OUT = '沒寫→status="blank"、有寫看不懂→status="unreadable"。只輸出 JSON：{"answers":[{"questionId":"...","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}'
// AI1=盲讀(不給答案)  AI2=知答校對(給答案當「看仔細」提示)
const headAI1 = (family) => `以下是多張「同一題型」的作答區裁切放大圖，每張圖前有題號標籤。只回報學生實際手寫的內容、看不到就 blank。\n${RULE[family] || '回報學生手寫的內容。'}\n${OUT}`
const headAI2 = (family) => `以下是多張「同一題型」的作答區裁切放大圖，每張圖前有題號標籤。你是校對員：每題標籤可能附正確答案，只當「看仔細一點」的提示；仍只回報學生實際手寫的內容、看不到就 blank，絕不可把正確答案填進去。\n${RULE[family] || '回報學生手寫的內容。'}\n${OUT}`
const hintOf = (qid) => { const k = akById.get(qid); const ps = Array.isArray(k?.parts) && k.parts.length >= 2 ? k.parts : null; return ps ? ps.map(p => `${p.subId}=${p?.answer ?? ''}`).join('；') : String(k?.answer || k?.referenceAnswer || '').trim() }

const parseAnswers = (data) => {
  const t = (data?.candidates ?? []).flatMap(c => c?.content?.parts ?? []).map(p => p?.text ?? '').join('')
  const m = t.match(/\{[\s\S]*\}/); if (!m) return null
  try { const j = JSON.parse(m[0]); return Array.isArray(j.answers) ? j.answers : null } catch { return null }
}

// ── 裁圖(ao_pdf:零 pad 直裁 classify bbox、production 分支)──
const cropCache = new Map()
const cropOf = async (q) => {
  const k = String(q.questionId)
  if (!cropCache.has(k)) cropCache.set(k, await cropInlineImageByBbox(imgB64, 'image/webp', q.answerBbox, true, 0))
  return cropCache.get(k)
}

// ── 合成圖:把 N 張裁圖排成 1 張,每格畫紅框 + 題號(set-of-mark 精神)──
const CELL_W = 460, LABEL_H = 30, GAP = 8
const sheetCache = new Map()
async function buildSheet(qs, tag) {
  if (sheetCache.has(tag)) return sheetCache.get(tag)
  const cells = []
  for (const q of qs) {
    const c = await cropOf(q); if (!c) continue
    const buf = Buffer.from(c.data, 'base64')
    const m = await sharp(buf).metadata()
    const h = Math.max(24, Math.round((m.height / m.width) * CELL_W))
    const resized = await sharp(buf).resize({ width: CELL_W, height: h, fit: 'fill' }).toBuffer()
    cells.push({ qid: String(q.questionId), buf: resized, h })
  }
  if (!cells.length) return null
  const totalH = cells.reduce((a, c) => a + c.h + LABEL_H + GAP, 0) + GAP
  const W = CELL_W + GAP * 2
  const comps = []
  const svgParts = [`<rect width="${W}" height="${totalH}" fill="white"/>`]
  let y = GAP
  for (const c of cells) {
    svgParts.push(`<text x="${GAP + 4}" y="${y + 21}" font-size="20" font-family="sans-serif" font-weight="bold" fill="#c00">${c.qid}</text>`)
    const top = y + LABEL_H
    svgParts.push(`<rect x="${GAP - 2}" y="${top - 2}" width="${CELL_W + 4}" height="${c.h + 4}" fill="none" stroke="#c00" stroke-width="3"/>`)
    comps.push({ input: c.buf, left: GAP, top })
    y = top + c.h + GAP
  }
  const base = await sharp(Buffer.from(`<svg width="${W}" height="${totalH}">${svgParts.join('')}</svg>`)).png().toBuffer()
  const out = await sharp(base).composite(comps).jpeg({ quality: 92 }).toBuffer()
  fs.mkdirSync(path.join(__dirname, 'sheets'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, 'sheets', `${tag}.jpg`), out)
  const r = { inlineData: { mimeType: 'image/jpeg', data: out.toString('base64') }, ids: cells.map(c => c.qid) }
  sheetCache.set(tag, r); return r
}

// ── 呼叫 ──
const genCfg = (mediaRes) => ({ generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' }, ...(mediaRes ? { mediaResolution: mediaRes } : {}) } })
const acc = { calls: 0, in: 0, img: 0, out: 0, th: 0, cached: 0, cost: 0 }
async function call(parts, mediaRes) {
  const t0 = Date.now()
  const r = await callGeminiGenerateContent({ apiKey: KEY, model: MODEL, contents: [{ role: 'user', parts }], payload: genCfg(mediaRes), timeoutMs: 180000 })
  const u = r?.data?.usageMetadata ?? {}
  const imgTok = (u.promptTokensDetails ?? []).find(d => d.modality === 'IMAGE')?.tokenCount ?? 0
  const cached = u.cachedContentTokenCount ?? 0
  acc.calls++; acc.in += u.promptTokenCount ?? 0; acc.img += imgTok
  acc.out += u.candidatesTokenCount ?? 0; acc.th += u.thoughtsTokenCount ?? 0; acc.cached += cached
  // 命中部分收 10%
  const billIn = Math.max(0, (u.promptTokenCount ?? 0) - cached) + cached * 0.1
  acc.cost += (billIn / 1e6 * RATE[0] + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) / 1e6 * RATE[1]) * USD_TWD
  return { answers: parseAnswers(r?.data), ms: Date.now() - t0, cached, imgTok }
}

// ── 一臂 ──
async function runArm(arm) {
  Object.keys(acc).forEach(k => acc[k] = 0)
  const t0 = Date.now()
  const groups = new Map()
  for (const q of readable) { const t = q.questionType; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(q) }
  const got1 = new Map(), got2 = new Map()
  const sheet = arm.startsWith('SHEET')
  const mediaRes = arm === 'SHEETHI' ? 'MEDIA_RESOLUTION_HIGH' : 'MEDIA_RESOLUTION_MEDIUM'
  const imgFirst = arm === 'IMGF' || arm === 'SHEETIF'
  const serial = imgFirst

  for (const [type, qs] of groups) {
    const cfg = CFG[type] ?? { batch: 15, family: 'text' }
    for (let i = 0; i < qs.length; i += cfg.batch) {
      const batch = qs.slice(i, i + cfg.batch)
      const tag = `${type}_${i}`
      // 組 parts:AI1(無答案) / AI2(帶答案)
      const build = async (isAI2) => {
        const head = (isAI2 ? headAI2 : headAI1)(cfg.family)
        if (sheet) {
          const s = await buildSheet(batch, tag); if (!s) return null
          const labels = s.ids.map(id => isAI2 ? `${id}${hintOf(id) ? `（正確答案：${hintOf(id)}）` : ''}` : id).join('、')
          const txt = `${head}\n⚠ 這是一張「合成圖」：由多格作答區上下排列組成，每格左上角有紅色題號、外圍有紅框。請逐格處理，題號依序為：${labels}。`
          return imgFirst ? [{ inlineData: s.inlineData }, { text: txt }] : [{ text: txt }, { inlineData: s.inlineData }]
        }
        const imgs = [], labs = []
        for (const q of batch) {
          const c = await cropOf(q); if (!c) continue
          const id = String(q.questionId)
          imgs.push({ inlineData: c })
          labs.push(isAI2 ? `${id}${hintOf(id) ? `（正確答案：${hintOf(id)}）` : ''}` : id)
        }
        if (!imgs.length) return null
        if (imgFirst) {
          // 圖片連續放最前面(共用前綴)、文字全部放後面
          return [...imgs, { text: `${head}\n上方圖片依序對應題號：${labs.join('、')}。` }]
        }
        // 現行:交錯
        const parts = [{ text: head }]
        batch.forEach((q, k) => { if (imgs[k]) { parts.push({ text: `--- 題目 ${labs[k]}（類型：${q.questionType}）---` }); parts.push(imgs[k]) } })
        return parts
      }
      const p1 = await build(false), p2 = await build(true)
      if (!p1 || !p2) continue
      if (serial) {
        const r1 = await call(p1, mediaRes)          // 先跑 AI1 → 寫入快取
        for (const a of r1.answers ?? []) got1.set(String(a.questionId), a)
        const r2 = await call(p2, mediaRes)          // AI2 應命中
        for (const a of r2.answers ?? []) got2.set(String(a.questionId), a)
      } else {
        const [r1, r2] = await Promise.all([call(p1, mediaRes), call(p2, mediaRes)])
        for (const a of r1.answers ?? []) got1.set(String(a.questionId), a)
        for (const a of r2.answers ?? []) got2.set(String(a.questionId), a)
      }
    }
  }
  // 評分:以 AI2(知答校對)為主讀值,比對 GT(production 最終值由仲裁決定,此處取一致率當代理指標)
  const evalOne = (got) => {
    let match = 0, blank = 0, unread = 0, missing = 0
    const diffs = []
    for (const q of readable) {
      const qid = String(q.questionId)
      const a = got.get(qid)
      if (!a) { missing++; continue }
      if (a.status === 'blank') blank++
      if (a.status === 'unreadable') unread++
      const gv = normalizeAnswerForComparison(String(gtByQid.get(qid) ?? ''))
      const av = normalizeAnswerForComparison(String(a.status === 'blank' ? '' : a.studentAnswerRaw ?? ''))
      if (gv === av) match++; else diffs.push({ qid, gt: String(gtByQid.get(qid) ?? '').slice(0, 30), got: String(a.studentAnswerRaw ?? `[${a.status}]`).slice(0, 30) })
    }
    return { match, blank, unread, missing, diffs }
  }
  return { arm, sec: Math.round((Date.now() - t0) / 1000), ...acc, ai1: evalOne(got1), ai2: evalOne(got2), got2: [...got2.entries()].map(([k, v]) => [k, v.status === 'blank' ? '' : String(v.studentAnswerRaw ?? '')]) }
}

// ── 主 ──
const ALL = ['BASE', 'IMGF', 'SHEET', 'SHEETHI', 'SHEETIF']
const arms = (process.argv[2] ? process.argv[2].split(',') : ALL).map(s => s.trim().toUpperCase()).filter(a => ALL.includes(a))
const results = []
for (const arm of arms) {
  for (const run of [1, 2]) {
    const r = await runArm(arm)
    r.run = run
    results.push(r)
    console.log(`\n[${arm} #${run}] ${r.calls} calls ${r.sec}s  圖tok=${r.img} 快取命中tok=${r.cached}  NT$${r.cost.toFixed(2)}`)
    console.log(`   AI2 對GT ${r.ai2.match}/${readable.length}  blank ${r.ai2.blank}  unreadable ${r.ai2.unread}  缺題 ${r.ai2.missing}`)
    if (r.ai2.diffs.length) console.log('   前5不一致:', r.ai2.diffs.slice(0, 5).map(d => `${d.qid}「${d.gt}」→「${d.got}」`).join('  '))
  }
}
fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ readable: readable.length, results }, null, 1))

// ── 彙總 + 否決判定 ──
const base = results.filter(r => r.arm === 'BASE')
const baseMatch = base.length ? Math.min(...base.map(r => r.ai2.match)) : 0
const baseCost = base.length ? base.reduce((a, r) => a + r.cost, 0) / base.length : 0
console.log('\n================ 彙總 ================')
console.log('臂'.padEnd(9), '兩次一致?'.padEnd(10), '對GT(兩次)'.padEnd(13), '缺題', ' 圖tok'.padStart(8), '命中tok'.padStart(8), 'NT$'.padStart(7), 'vs BASE'.padStart(9), '判定')
for (const arm of arms) {
  const rs = results.filter(r => r.arm === arm)
  if (rs.length < 2) continue
  const same = JSON.stringify(rs[0].got2) === JSON.stringify(rs[1].got2)
  const ms = rs.map(r => r.ai2.match)
  const cost = (rs[0].cost + rs[1].cost) / 2
  const worst = Math.min(...ms)
  const missing = Math.max(...rs.map(r => r.ai2.missing))
  const verdict = arm === 'BASE' ? '—基準—'
    : (!same ? '❌ 兩次有 diff' : worst < baseMatch ? `❌ 品質退步(${worst}<${baseMatch})` : missing > Math.max(...base.map(r => r.ai2.missing)) ? '❌ 缺題增加' : '✅ 可擴大測試')
  console.log(arm.padEnd(9), (same ? '✅ 一致' : '❌ 有diff').padEnd(10), (ms.join(' / ') + `  /${readable.length}`).padEnd(13), String(missing).padStart(3),
    String(Math.round((rs[0].img + rs[1].img) / 2)).padStart(8), String(Math.round((rs[0].cached + rs[1].cached) / 2)).padStart(8),
    cost.toFixed(2).padStart(7), (baseCost ? ((cost / baseCost - 1) * 100).toFixed(0) + '%' : '-').padStart(9), verdict)
}
console.log('\n→ result.json;合成圖存 sheets/*.jpg(可目檢)')
