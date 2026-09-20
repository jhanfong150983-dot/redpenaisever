// ⭐ 作文管線煙霧測試：**不花錢**跑完 Phase A ＋ Phase B 的完整程式路徑。
//
// 為什麼要這支：`node --check` 只驗語法，抓不到「用了不存在的變數」。
// 2026-09-20 我因此連續兩次把 ReferenceError 推上 production：
//   ①runEssayFeedback 用了 Phase A 的 lowCount（9 份全炸）
//   ②runEssayTranscribe 用了 cutEssayColumns 內部的 g（10 份全炸）
// 兩次都是「AI 都跑完了，最後組回傳值才爆」——最貴的那種失敗。
// 這支把 executeStage 換成假的，其餘照真跑（含裁行、數格子、定位、分桶、組回傳值）。
//
// 用法：npm run smoke:essay          # 或 node scripts/essay-smoke.mjs
//      node scripts/essay-smoke.mjs <assignmentId>
//
// ⚠ 需要 .env.local 的 SUPABASE 連線（要抓一張真實學生卷影像才測得到真的裁行）→ 無法在 CI 無憑證執行。
// ⚠ **改抄寫的輸入／輸出格式時，記得同步改下面的假 AI**。2026-09-20 抄寫從「一行一呼叫」
//   改成「8 行合成、逐格｜分隔」時，假資料沒跟上，紅燈兩次都是假資料過期、不是真的 bug。
import fs from 'node:fs'
import sharp from 'sharp'
import { createClient } from '@supabase/supabase-js'
import { runEssayTranscribe, runEssayFeedback, buildEssayGradingResult } from '../server/ai/essay-pipeline.js'
import { cutEssayColumns } from '../server/ai/essay-sheet.js'

for (const l of fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const ASG = process.argv[2] ?? '1789866262820-gxghx80sz'

// ── 假的 AI：抄寫回固定文字、眉批／級分回固定 JSON。零成本、但走完整個 parse → 定位 → 分桶 → 回傳 ──
let calls = 0
let colPx = 0          // 一直行在原圖上的像素寬（每份卷開跑前設定）
const fakeStage = async ({ routeKey, stageContents }) => {
  calls++
  // ⚠ 2026-09-20 抄寫改成「一次送 8 直行、逐格用｜分隔」：回傳是 {"columns":[第1行, 第2行, …]}，
  //   **筆數必須等於送出的行數**，否則管線會判定錯位並退回逐行重抄（那是刻意的守門）。
  //   所以假 AI 要**從圖寬推算這次送了幾行**（圖寬 ÷ 單行寬），固定回 N 筆會讓殘組與短卷永遠對不上。
  if (routeKey.endsWith('essay_transcribe')) {
    const b64 = stageContents?.[0]?.parts?.find((p) => p.inlineData)?.inlineData?.data ?? ''
    const w = (await sharp(Buffer.from(b64, 'base64')).metadata()).width
    const n = Math.max(1, Math.round(w / colPx))
    const one = [...'這是一行假的抄本內容用來測試流程拾'].join('｜')
    return { ok: true, status: 200, data: { __text: JSON.stringify({ columns: Array.from({ length: n }, () => one) }) } }
  }
  if (routeKey.endsWith('essay_feedback')) {
    return { ok: true, status: 200, data: { __text: JSON.stringify({
      typos: [{ wrong: '拾', correct: '給', context: '測試流程拾' }],
      sentenceFeedback: [{ quote: '這是一行假的', dimension: '遣詞造句', rubricTerm: '冗詞贅句', problem: 'p', suggestion: 's' }],
      paragraphFeedback: [{ paragraph: 1, comment: 'c' }],
      strengths: [{ quote: '測試流程', why: 'w' }],
      dimensionDiagnosis: [{ name: '立意取材', terms: [{ term: 't', severity: '偶有' }], comment: 'c' }],
      summary: '總評',
    }) } }
  }
  return { ok: true, status: 200, data: { __text: JSON.stringify({ overall: 4, reason: 'r', dimensions: [{ name: '立意取材', level: 4, comment: 'c' }] }) } }
}
const fakeExtract = (d) => d?.__text ?? ''

const { data: a } = await db.from('assignments').select('answer_key_template_id').eq('id', ASG).maybeSingle()
const { data: tpl } = await db.from('answer_key_templates').select('generated_sheet').eq('id', a.answer_key_template_id).maybeSingle()
const layout = tpl.generated_sheet
const { data: subs } = await db.from('submissions').select('id,image_url,page_breaks').eq('assignment_id', ASG).limit(2)

let fail = 0
for (const s of subs) {
  const { data: blob } = await db.storage.from('homework-images').download(s.image_url)
  const buf = Buffer.from(await blob.arrayBuffer())
  const common = { executeStage: fakeStage, extractCandidateText: fakeExtract, apiKey: 'x', model: 'x', payload: {}, routeHint: {}, log: () => {} }
  // 單行寬：假 AI 用它把「圖寬」換算回「這次送了幾行」
  const { columns: pre } = await cutEssayColumns(buf, layout, s.page_breaks)
  colPx = (pre.find((c) => !c.blank)?.bbox.w ?? 0.04) * (await sharp(buf).metadata()).width
  try {
    const draft = await runEssayTranscribe({ ...common, imageBuffer: buf, pageBreaks: s.page_breaks, layout })
    // Phase A 的回傳必須齊全——少一個欄位下游就會壞
    for (const k of ['version', 'columns', 'rows', 'paragraphs', 'chars', 'lowConfidenceColumns', 'simplified'])
      if (draft[k] === undefined) throw new Error(`Phase A 回傳缺 ${k}`)
    const full = await runEssayFeedback({ ...common, draft, bookletImages: [{ mimeType: 'image/webp', data: 'AA==' }] })
    for (const k of ['version', 'columns', 'rows', 'paragraphs', 'chars', 'lowConfidenceColumns', 'simplified', 'feedback', 'level'])
      if (full[k] === undefined) throw new Error(`Phase B 回傳缺 ${k}`)
    const r = buildEssayGradingResult('1', full)
    if (typeof r.totalScore !== 'number') throw new Error('buildEssayGradingResult 沒有 totalScore')
    const t = full.feedback.typos[0]
    console.log(`✅ ${s.id}  行 ${draft.columns.length}／每行 ${draft.rows} 格・錯別字分桶 ${t.confidence}・級分 ${r.totalScore}`)
  } catch (e) {
    fail++
    console.log(`⛔ ${s.id}  ${e.message}`)
    console.log(e.stack.split('\n').slice(1, 3).join('\n'))
  }
}
// ── 簡體字品質閘門：抄本吐一堆簡體字時必須「重抄一次 → 仍不合格就整份失敗」──
//   （user 09-20：不要讓這種東西落到老師眼睛裡。這條路一旦寫壞，壞掉的抄本就會靜靜上線。）
{
  const s = subs[0]
  const { data: blob } = await db.storage.from('homework-images').download(s.image_url)
  const buf = Buffer.from(await blob.arrayBuffer())
  const { columns: pre } = await cutEssayColumns(buf, layout, s.page_breaks)
  colPx = (pre.find((c) => !c.blank)?.bbox.w ?? 0.04) * (await sharp(buf).metadata()).width
  let retried = 0
  const simpStage = async (args) => {
    if (args.routeKey.endsWith('essay_transcribe')) {
      const b64 = args.stageContents?.[0]?.parts?.find((p) => p.inlineData)?.inlineData?.data ?? ''
      const w = (await sharp(Buffer.from(b64, 'base64')).metadata()).width
      const n = Math.max(1, Math.round(w / colPx))
      if (n === 1) retried++          // 逐行重抄才會走到這裡
      const one = [...'这是简体的抄本内容测试'].join('｜')
      return { ok: true, status: 200, data: { __text: JSON.stringify({ columns: Array.from({ length: n }, () => one) }) } }
    }
    return fakeStage(args)
  }
  try {
    await runEssayTranscribe({
      executeStage: simpStage, extractCandidateText: fakeExtract, apiKey: 'x', model: 'x',
      payload: {}, routeHint: {}, log: () => {}, imageBuffer: buf, pageBreaks: s.page_breaks, layout,
    })
    fail++
    console.log('⛔ 簡體字閘門：抄本全是簡體卻沒有失敗（閘門沒作用）')
  } catch (e) {
    if (/簡體字/.test(e.message) && retried > 0) console.log(`✅ 簡體字閘門：先逐行重抄 ${retried} 行、仍不合格 → 整份失敗（${e.message}）`)
    else { fail++; console.log(`⛔ 簡體字閘門行為不對：重抄 ${retried} 行、錯誤訊息「${e.message}」`) }
  }
}

// ── 學測國寫（format:'gsat'）：一張答題卷＝正面第一大題＋背面第二大題，第一階段**只批背面** ──
//   要驗的是「正面不會被混進來當成同一篇」——那是高中自備卷一直被鎖住的原因，錯了是無聲批錯。
//   素材在 local-only/（gitignore）：115 學測第二大題真實原卷＋114 空白卷。沒有就跳過、不算失敗。
let extra = 1
{
  const path = await import('node:path')
  const dir = path.join(import.meta.dirname, '..', 'local-only', 'essay', 'pages')
  const front = path.join(dir, 'gsat_p1.png'), back = path.join(dir, 'gsat115_q2_4.png')
  if (!fs.existsSync(front) || !fs.existsSync(back)) {
    console.log('⏭  學測案例跳過（local-only 沒有樣卷圖）')
  } else {
    extra++
    const Wd = 3240
    const p1 = await sharp(front).resize({ width: Wd }).png().toBuffer()
    const p2 = await sharp(back).resize({ width: Wd }).png().toBuffer()
    const h1 = (await sharp(p1).metadata()).height, h2 = (await sharp(p2).metadata()).height
    const merged = await sharp({ create: { width: Wd, height: h1 + h2, channels: 3, background: '#fff' } })
      .composite([{ input: p1, top: 0, left: 0 }, { input: p2, top: h1, left: 0 }]).webp({ quality: 85 }).toBuffer()
    const gsat = { source: 'byo', format: 'gsat', pages: 2, cols: 38, rows: 22, cellMm: 10, gutterMm: 0, items: [{ id: '1', pages: [2] }] }
    const breaks = [h1 / (h1 + h2)]
    try {
      const { columns: pre } = await cutEssayColumns(merged, { essay: gsat }, breaks)
      colPx = pre[0].bbox.w * Wd
      let trCalls = 0
      const stage = async (a) => { if (a.routeKey.endsWith('essay_transcribe')) trCalls++; return fakeStage(a) }
      const draft = await runEssayTranscribe({
        executeStage: stage, extractCandidateText: fakeExtract, apiKey: 'x', model: 'x',
        payload: {}, routeHint: {}, log: () => {}, imageBuffer: merged, pageBreaks: breaks, layout: { essay: gsat },
      })
      const pages = [...new Set(draft.columns.map((c) => c.page))]
      const written = draft.columns.filter((c) => c.text).length
      if (pages.length !== 1 || pages[0] !== 2) throw new Error(`應該只有第 2 頁的行，實際出現第 ${pages.join(',')} 頁`)
      if (draft.columns.length !== 38) throw new Error(`應該有 38 行，實際 ${draft.columns.length}`)
      if (written < 36) throw new Error(`有字行只有 ${written}（這份原卷應該 37~38 行）`)
      if (trCalls > 6) throw new Error(`抄寫呼叫 ${trCalls} 次，38 行每 8 行一組應該 5 次上下`)
      console.log(`✅ 學測（只批背面）：只出現第 2 頁、${draft.columns.length} 行、有字 ${written} 行、抄寫 ${trCalls} 次呼叫`)
      // 多個寫作題還沒支援 → 必須大聲失敗，不可默默合成一篇
      let threw = false
      try { await cutEssayColumns(merged, { essay: { ...gsat, items: [{ id: '1', pages: [1] }, { id: '2', pages: [2] }] } }, breaks) } catch { threw = true }
      if (!threw) throw new Error('多個寫作題沒有被擋下')
      console.log('✅ 學測（多題）：正確擋下、沒有默默合成一篇')
    } catch (e) {
      fail++
      console.log(`⛔ 學測案例：${e.message}`)
    }
  }
}

console.log(`\n假 AI 呼叫 ${calls} 次（零成本）　失敗 ${fail}/${subs.length + extra}`)
process.exit(fail ? 1 : 0)
