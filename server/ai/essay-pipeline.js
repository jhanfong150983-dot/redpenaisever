// 2026-09-19 作文批改管線（P3）：一次呼叫跑完，不走 classify/read/arbiter 那條路。
//   流程：合併圖 → 依 pageBreaks 切頁 → 四角錨點對齊 → 逐直行裁圖＋零 AI 數格子
//        → 逐行抄寫（每行一次）→ 零 AI 閘門 → 眉批＋建議級分（並行、題目送題本圖）
//        → 引用句 code 驗證並定位回直行。
//   低信心＝「該行有墨格數 ≠ 抄本字數」：實驗0 實測抓到全部漏字／多字／疊字行，交老師補。
//   ⛔ 別在這裡改 prompt——prompt 在 essay-grader.js，且改了要升 JUDGE_PROMPT_VERSIONS。
import { cutEssayColumns, isEssayLayout } from './essay-sheet.js'
import {
  ESSAY_ROUTES,
  ESSAY_TRANSCRIBE_GENERATION_CONFIG,
  ESSAY_FEEDBACK_GENERATION_CONFIG,
  ESSAY_LEVEL_GENERATION_CONFIG,
  buildEssayTranscribePrompt,
  buildEssayFeedbackPrompt,
  buildEssayLevelPrompt,
  parseEssayTranscribeColumn,
  parseJsonLoose,
  columnsToParagraphs,
  locateQuote,
  essayZeroAiGate,
} from './essay-grader.js'

const ESSAY_MAX_LEVEL = 6
/** 逐行抄寫的並行數（一篇約 25~45 行；Phase A 有 300s 預算） */
const TRANSCRIBE_CONCURRENCY = 6

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++
      out[k] = await fn(items[k], k)
    }
  }))
  return out
}

const flat = (s) => String(s ?? '').replace(/[\s　]/g, '').replaceAll('〔?〕', '')

/**
 * @param {object} p
 * @param {(args:object)=>Promise<any>} p.executeStage staged-grading 的 executeStage
 * @param {(data:any)=>string} p.extractCandidateText
 * @param {Buffer} p.imageBuffer 學生合併圖
 * @param {number[]|null} p.pageBreaks
 * @param {object} p.layout answer_key_templates.generated_sheet（含 essay 幾何）
 * @param {Array<{mimeType:string,data:string}>} p.bookletImages 題本圖（最多 2 頁）
 *   ⚠ 形狀是 {mimeType,data}（proxy 的 fetchQuestionBookletImages 產出），不是 {inlineData}
 * @returns {Promise<object>} essayResult
 */
export async function runEssayGrading({
  executeStage,
  extractCandidateText,
  apiKey,
  model,
  payload = {},
  routeHint = {},
  imageBuffer,
  pageBreaks,
  layout,
  bookletImages = [],
  gradeLabel,
  log = () => {},
}) {
  if (!isEssayLayout(layout)) throw new Error('這份考卷不是作文稿紙版面')
  const t0 = Date.now()

  // ── 1) 裁行＋數格子（零 AI）──
  const { columns: cut } = await cutEssayColumns(imageBuffer, layout, pageBreaks)
  const written = cut.filter((c) => !c.blank && c.pngBase64)
  log(`[Essay] 裁行完成：${cut.length} 行、有字 ${written.length} 行（零 AI，${Date.now() - t0}ms）`)

  // ── 2) 逐行抄寫 ──
  const prompt = buildEssayTranscribePrompt()
  // ⛔ 單行抄寫失敗不可以炸掉整份卷：設計上「抄不出來」＝低信心、交老師補（下面 lowConfidence 會標）。
  //   原本沒接 catch，pool 裡任何一行 throw 就整個 Phase A 失敗、老師只看到「擷取失敗」。
  let transcribeErrors = 0
  const texts = await pool(written, TRANSCRIBE_CONCURRENCY, async (c) => {
    try {
      const resp = await executeStage({
        apiKey,
        model,
        payload: { ...payload, ...ESSAY_TRANSCRIBE_GENERATION_CONFIG },
        timeoutMs: 60_000,
        routeHint,
        routeKey: ESSAY_ROUTES.transcribe,
        stageContents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: c.pngBase64 } }] }],
      })
      if (!resp?.ok) {
        transcribeErrors++
        log(`[Essay] 第${c.page}頁第${c.col}行 抄寫未成功（status=${resp?.status ?? '?'}）→ 標低信心`)
        return null
      }
      return parseEssayTranscribeColumn(extractCandidateText(resp.data) || '')
    } catch (err) {
      transcribeErrors++
      log(`[Essay] 第${c.page}頁第${c.col}行 抄寫例外：${err?.message || err} → 標低信心`)
      return null
    }
  })
  if (transcribeErrors) log(`[Essay] 抄寫共 ${transcribeErrors}/${written.length} 行失敗（標低信心、不中斷批改）`)

  const columns = cut.map((c) => {
    const k = written.indexOf(c)
    const text = k >= 0 ? (texts[k] ?? '') : ''
    const chars = flat(text).length
    return {
      page: c.page,
      col: c.col,
      text,
      inkCells: c.inkCells,
      // 這一行在學生合併圖上的位置（normalized）→ 檢討單畫紅字用
      bbox: c.bbox,
      // 低信心：抄本字數與有墨格數不符（含抄寫失敗的行）→ 複核畫面請老師補
      lowConfidence: !c.blank && (k < 0 || texts[k] == null || chars !== c.inkCells),
    }
  })
  const lowCount = columns.filter((c) => c.lowConfidence).length
  log(`[Essay] 抄寫完成：${written.length} 行、低信心 ${lowCount} 行`)

  const paras = columnsToParagraphs(columns.map((c) => c.text))
  const totalChars = columns.reduce((n, c) => n + flat(c.text).length, 0)

  // ── 3) 零 AI 閘門（空白卷／字數過少）──
  const gate = essayZeroAiGate(columns)
  if (gate) {
    log(`[Essay] 零 AI 閘門：${gate.reason} → 級分 ${gate.level}，不送眉批`)
    return {
      version: 'essay-1',
      columns,
      paragraphs: paras,
      chars: totalChars,
      lowConfidenceColumns: lowCount,
      feedback: null,
      level: { suggested: gate.level, final: gate.level, reason: gate.reason, dimensions: [] },
      gate: gate.reason,
      ms: Date.now() - t0,
    }
  }

  // ── 4) 眉批與建議級分（並行；題目一律送題本圖）──
  // ⛔ questionBookletImages 的元素是 `{ mimeType, data }`，**不是** `{ inlineData }`
  //   （慣例見 staged-grading.js 的 questionBookletImageParts）。原本寫 im.inlineData → undefined
  //   → 送出一個空的圖片欄位，Gemini 直接回 **400**，眉批與級分兩支同時陣亡（實測 09-20）。
  //   兩種形狀都收，沒有 data 的直接丟掉，避免再把空 part 送上去。
  const bookletParts = bookletImages.slice(0, 2)
    .map((im) => ({ inlineData: im?.inlineData ?? { mimeType: im?.mimeType || 'image/webp', data: im?.data } }))
    .filter((p) => p.inlineData?.data)
  if (bookletImages.length && !bookletParts.length) log('[Essay] ⚠ 題本圖有拿到但組不出 inlineData，這次不附題目圖')
  // 眉批／級分任一失敗也不該讓整份卷炸掉 → allSettled，缺的那段留 null 交老師處理
  const [fbSettled, lvSettled] = await Promise.allSettled([
    executeStage({
      apiKey,
      model,
      payload: { ...payload, ...ESSAY_FEEDBACK_GENERATION_CONFIG },
      timeoutMs: 180_000,
      routeHint,
      routeKey: ESSAY_ROUTES.feedback,
      stageContents: [{ role: 'user', parts: [{ text: buildEssayFeedbackPrompt(paras, gradeLabel) }, ...bookletParts] }],
    }),
    executeStage({
      apiKey,
      model,
      payload: { ...payload, ...ESSAY_LEVEL_GENERATION_CONFIG },
      timeoutMs: 90_000,
      routeKey: ESSAY_ROUTES.level,
      routeHint,
      stageContents: [{ role: 'user', parts: [{ text: buildEssayLevelPrompt(paras, totalChars) }, ...bookletParts] }],
    }),
  ])
  if (fbSettled.status === 'rejected') log(`[Essay] 眉批失敗：${fbSettled.reason?.message || fbSettled.reason}`)
  if (lvSettled.status === 'rejected') log(`[Essay] 級分失敗：${lvSettled.reason?.message || lvSettled.reason}`)
  const fbResp = fbSettled.status === 'fulfilled' ? fbSettled.value : null
  const lvResp = lvSettled.status === 'fulfilled' ? lvSettled.value : null
  // 只印 status 看不出所以然（09-20 的 400 查了半天才知道是圖片欄位空的）→ 把 API 回的訊息也印出來
  const errOf = (r) => {
    const d = r?.data
    const msg = d?.error?.message ?? (typeof d === 'string' ? d : JSON.stringify(d ?? {}))
    return String(msg).slice(0, 300)
  }
  if (fbResp && !fbResp.ok) log(`[Essay] 眉批未成功 status=${fbResp.status ?? '?'}｜${errOf(fbResp)}`)
  if (lvResp && !lvResp.ok) log(`[Essay] 級分未成功 status=${lvResp.status ?? '?'}｜${errOf(lvResp)}`)
  const fb = fbResp?.ok ? parseJsonLoose(extractCandidateText(fbResp.data) || '') : null
  const lv = lvResp?.ok ? parseJsonLoose(extractCandidateText(lvResp.data) || '') : null

  // ── 5) 引用句 code 驗證＋定位回直行（驗不過＝判官幻覺，標記但不丟棄，交老師看）──
  const withLoc = (arr, key) => (Array.isArray(arr) ? arr : []).map((x) => {
    const loc = locateQuote(columns, x?.[key])
    return { ...x, loc: loc.ok ? { page: loc.page, col: loc.col, toCol: loc.toCol } : null, quoteVerified: loc.ok }
  })
  const feedback = fb ? {
    typos: withLoc(fb.typos, 'context'),
    sentenceFeedback: withLoc(fb.sentenceFeedback, 'quote'),
    paragraphFeedback: Array.isArray(fb.paragraphFeedback) ? fb.paragraphFeedback : [],
    strengths: withLoc(fb.strengths, 'quote'),
    dimensionDiagnosis: Array.isArray(fb.dimensionDiagnosis) ? fb.dimensionDiagnosis : [],
    summary: String(fb.summary ?? ''),
  } : null

  const suggested = Number.isInteger(lv?.overall) && lv.overall >= 0 && lv.overall <= ESSAY_MAX_LEVEL
    ? lv.overall
    : null
  const badQuotes = (feedback?.sentenceFeedback ?? []).filter((x) => !x.quoteVerified).length
  log(`[Essay] 眉批 ${feedback?.sentenceFeedback?.length ?? 0} 則（引用驗不過 ${badQuotes}）、建議級分 ${suggested ?? '—'}、共 ${Date.now() - t0}ms`)

  return {
    version: 'essay-1',
    columns,
    paragraphs: paras,
    chars: totalChars,
    lowConfidenceColumns: lowCount,
    feedback,
    level: {
      suggested,
      // final＝老師確認後的級分；批改當下先等於建議級分
      final: suggested,
      reason: String(lv?.reason ?? ''),
      dimensions: Array.isArray(lv?.dimensions) ? lv.dimensions : [],
    },
    gate: null,
    ms: Date.now() - t0,
  }
}

/** essayResult → 批改結果的單題 detail（滿分＝6 級分、級分即分數） */
export function essayResultToQuestionResult(questionId, essayResult) {
  const lvl = essayResult?.level?.final ?? essayResult?.level?.suggested
  const score = Number.isInteger(lvl) ? lvl : 0
  return {
    questionId,
    isCorrect: score >= 4,
    score,
    maxScore: ESSAY_MAX_LEVEL,
    errorType: 'concept',
    scoringReason: essayResult?.gate || essayResult?.level?.reason || '作文：AI 建議級分，請老師確認',
    scoreConfidence: essayResult?.gate ? 95 : 70,
    studentFinalAnswer: '作文卷面',
    needExplain: false,
    essayResult,
  }
}


/**
 * essayResult → Phase B 的最終批改結果（GradingResult 契約）。
 * 作文的分數在 Phase A 就定了（級分即分數），Phase B 不需要再叫任何 AI——
 * 這支只是把結果組成 client 存得下的形狀。
 */
export function buildEssayGradingResult(questionId, essayResult) {
  const qr = essayResultToQuestionResult(questionId, essayResult)
  const low = essayResult?.lowConfidenceColumns ?? 0
  const detail = {
    questionId,
    studentAnswer: '作文卷面',
    studentFinalAnswer: '作文卷面',
    score: qr.score,
    maxScore: qr.maxScore,
    isCorrect: qr.isCorrect,
    needExplain: false,
    errorType: qr.errorType,
    reason: qr.scoringReason,
    confidence: qr.scoreConfidence,
    essayResult,
  }
  return {
    totalScore: qr.score,
    details: [detail],
    mistakes: [],
    weaknesses: [],
    suggestions: [],
    // 有低信心的行就請老師看一下抄本（抄錯會影響眉批與級分）
    needsReview: low > 0,
    reviewReasons: low > 0 ? [`有 ${low} 行的抄本字數與稿紙上的字數不符，請確認抄本`] : [],
  }
}
