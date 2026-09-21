// 2026-09-19 作文批改管線（P3）：一次呼叫跑完，不走 classify/read/arbiter 那條路。
//   流程：合併圖 → 依 pageBreaks 切頁 → 四角錨點對齊 → 逐直行裁圖＋零 AI 數格子
//        → 逐行抄寫（每行一次）→ 零 AI 閘門 → 眉批＋建議級分（並行、題目送題本圖）
//        → 引用句 code 驗證並定位回直行。
//   低信心＝「該行有墨格數 ≠ 抄本字數」：實驗0 實測抓到全部漏字／多字／疊字行，交老師補。
//   ⛔ 別在這裡改 prompt——prompt 在 essay-grader.js，且改了要升 JUDGE_PROMPT_VERSIONS。
import { cutEssayColumns, cropEssayColumnGroup, applyColumnIndent, isEssayLayout } from './essay-sheet.js'
import { bucketTypos, detectSimplifiedChars } from './essay-typo-dict.js'
import {
  ESSAY_ROUTES,
  ESSAY_TRANSCRIBE_GENERATION_CONFIG,
  ESSAY_FEEDBACK_GENERATION_CONFIG,
  ESSAY_LEVEL_GENERATION_CONFIG,
  buildEssayTranscribePrompt,
  buildEssayFeedbackPrompt,
  buildEssayLevelPrompt,
  buildGsatLevelPrompt,
  normalizeGsatLevel,
  parseEssayTranscribeColumns,
  parseJsonLoose,
  columnsToParagraphs,
  locateQuote,
  locateTypoCell,
  essayZeroAiGate,
} from './essay-grader.js'

const ESSAY_MAX_LEVEL = 6
/** 抄寫的並行數（一篇約 25~45 行、合成後約 4~6 組；Phase A 有 300s 預算） */
const TRANSCRIBE_CONCURRENCY = 6
/**
 * 一次送幾直行合成一張圖抄寫。2026-09-20 實驗定案 8。
 * （4 份卷、50 個人工真值判讀點：N=5 準確 35/50・每欄 0.0341；**N=8 準確 38/50・每欄 0.0270**；
 *   N=12 掉到 32/50；N=23 一致率崩到 70.7% 且漏 12 行。N=8 比 N=5 更便宜也更準，
 *   還把座8 那份的簡體字從 9 個壓到 2 個。）
 * 設 ESSAY_TRANSCRIBE_GROUP=1 可退回逐行抄寫。
 */
const TRANSCRIBE_GROUP = Math.max(1, Number(process.env.ESSAY_TRANSCRIBE_GROUP ?? 8) || 8)
/**
 * 一份卷的抄本出現幾個簡體字就判定「這是 AI 壞掉」而不是「學生寫的」。
 * 實測 10 份卷的簡體字 100% 是 AI 吐的，而且一發作就是整段十幾個；學生零星寫一兩個才有可能。
 */
const SIMPLIFIED_GATE = Math.max(1, Number(process.env.ESSAY_SIMPLIFIED_GATE ?? 5) || 5)

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
export async function runEssayTranscribe({
  executeStage,
  extractCandidateText,
  apiKey,
  model,
  payload = {},
  routeHint = {},
  imageBuffer,
  pageBreaks,
  layout,
  log = () => {},
}) {
  if (!isEssayLayout(layout)) throw new Error('這份考卷不是作文稿紙版面')
  const t0 = Date.now()

  // ── 1) 裁行＋數格子（零 AI）──
  const { columns: cut } = await cutEssayColumns(imageBuffer, layout, pageBreaks)
  const written = cut.filter((c) => !c.blank && c.pngBase64)
  log(`[Essay] 裁行完成：${cut.length} 行、有字 ${written.length} 行（零 AI，${Date.now() - t0}ms）`)

  // ── 2) 合成 N 行一張圖抄寫 ──
  // 同一頁、連號的行才能併（跨頁或不連號一定要斷開，否則圖上根本不相鄰）
  const groups = []
  for (const c of written) {
    const last = groups[groups.length - 1]
    if (last && last[0].page === c.page && c.col === last[last.length - 1].col + 1 && last.length < TRANSCRIBE_GROUP) last.push(c)
    else groups.push([c])
  }
  const prompt = buildEssayTranscribePrompt()
  let transcribeErrors = 0
  let regrouped = 0

  /** 送一組圖去抄；回傳長度＝group.length 的陣列（元素可為 null＝這行沒抄到） */
  const askGroup = async (group) => {
    const data = group.length === 1 && group[0].pngBase64
      ? group[0].pngBase64                                   // 單行直接用裁好的
      : await cropEssayColumnGroup(imageBuffer, group)
    if (!data) return group.map(() => null)
    const resp = await executeStage({
      apiKey,
      model,
      payload: { ...payload, ...ESSAY_TRANSCRIBE_GENERATION_CONFIG },
      timeoutMs: 90_000,
      routeHint,
      routeKey: ESSAY_ROUTES.transcribe,
      stageContents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data } }] }],
    })
    if (!resp?.ok) {
      log(`[Essay] 第${group[0].page}頁第${group[0].col}~${group[group.length - 1].col}行 抄寫未成功（status=${resp?.status ?? '?'}）`)
      return null
    }
    return parseEssayTranscribeColumns(extractCandidateText(resp.data) || '')
  }

  // ⛔ 回傳筆數 ≠ 送出行數時**絕對不能照位置硬對**：少一行會讓後面每一行全部位移，
  //   整篇錯位卻沒有任何錯誤訊息（N=23 實驗漏 12 行就是這樣崩的）。一律退回逐行重抄。
  const texts = new Array(written.length).fill(null)
  await pool(groups, TRANSCRIBE_CONCURRENCY, async (group) => {
    let arr = null
    try {
      arr = await askGroup(group)
    } catch (err) {
      log(`[Essay] 第${group[0].page}頁第${group[0].col}行起 抄寫例外：${err?.message || err}`)
    }
    if (!Array.isArray(arr) || arr.length !== group.length) {
      if (group.length > 1) {
        regrouped++
        log(`[Essay] 第${group[0].page}頁第${group[0].col}~${group[group.length - 1].col}行 回傳 ${Array.isArray(arr) ? arr.length : '解析失敗'} 筆 ≠ 送出 ${group.length} 筆 → 退回逐行重抄`)
        const singles = await pool(group, TRANSCRIBE_CONCURRENCY, async (c) => {
          try {
            const one = await askGroup([c])
            return Array.isArray(one) && one.length === 1 ? one[0] : null
          } catch { return null }
        })
        group.forEach((c, i) => { texts[written.indexOf(c)] = singles[i] ?? null })
        transcribeErrors += singles.filter((x) => x == null).length
        return
      }
      transcribeErrors++
      texts[written.indexOf(group[0])] = null
      return
    }
    group.forEach((c, i) => { texts[written.indexOf(c)] = applyColumnIndent(arr[i], c.inkRows) })
  })
  log(`[Essay] 抄寫：${written.length} 行 / ${groups.length} 次呼叫（每次 ${TRANSCRIBE_GROUP} 行）`)
  if (regrouped) log(`[Essay] 其中 ${regrouped} 組筆數不符、已退回逐行重抄`)
  if (transcribeErrors) log(`[Essay] 抄寫共 ${transcribeErrors}/${written.length} 行失敗（標低信心、不中斷批改）`)

  // ── 2b) 品質閘門：抄本吐出大量簡體字 ──────────────────────────────────
  // 實測：合成 8 行時，某一份卷會整段切換成簡體（一份 15~30 個字），逐行抄則只有 2 個。
  // user 09-20 拍板：「≥5 個就重跑，至少 retry 一次，還是不行就直接失敗，
  //   不要讓這種東西落到老師眼睛裡」（學生真的寫這麼多簡體，老師改錯時自己會發現）。
  // ⛔ retry 不能原樣重送：temperature=0，同樣的圖會得到一模一樣的結果。
  //   要換輸入——把出問題的行**拆開逐行重抄**（逐行本來就幾乎不吐簡體）。
  const countSimp = () => texts.reduce((n, t) => n + detectSimplifiedChars(t).length, 0)
  let simpTotal = countSimp()
  if (simpTotal >= SIMPLIFIED_GATE) {
    const bad = written.filter((c, i) => detectSimplifiedChars(texts[i]).length > 0)
    log(`[Essay] 抄本出現 ${simpTotal} 個簡體字（${bad.length} 行）→ 這些行拆開逐行重抄`)
    await pool(bad, TRANSCRIBE_CONCURRENCY, async (c) => {
      try {
        const one = await askGroup([c])
        if (Array.isArray(one) && one.length === 1 && one[0] != null) {
          texts[written.indexOf(c)] = applyColumnIndent(one[0], c.inkRows)
        }
      } catch { /* 重抄失敗就維持原文，下面的總數檢查會擋 */ }
    })
    simpTotal = countSimp()
    log(`[Essay] 重抄後剩 ${simpTotal} 個簡體字`)
    if (simpTotal >= SIMPLIFIED_GATE) {
      throw new Error(`抄寫品質不合格：抄本出現 ${simpTotal} 個簡體字，重抄後仍未改善`)
    }
  }
  // 沒到閘門值的零星簡體字 → 留著給低信心清單（可能是學生真的寫簡體）
  const simplified = []
  written.forEach((c, i) => {
    for (const s of detectSimplifiedChars(texts[i])) {
      simplified.push({ page: c.page, col: c.col, row: s.index + 1, char: s.char })
    }
  })
  if (simplified.length) log(`[Essay] 零星簡體字 ${simplified.length} 個 → 標低信心交老師判斷`)

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
  if (gate) log(`[Essay] 零 AI 閘門：${gate.reason} → 級分 ${gate.level}，不送眉批`)
  return {
    version: 'essay-1',
    columns,
    // 一行幾格：前端要靠它把「第幾格」換算成 bbox 裡的 y 偏移（低信心清單裁那個字）
    //   ⛔ 這裡沒有 g（那是 cutEssayColumns 內部的變數）——2026-09-20 寫成 g.rows 讓 10 份全炸
    rows: layout?.essay?.rows,
    paragraphs: paras,
    chars: totalChars,
    lowConfidenceColumns: lowCount,
    // 零星簡體字（未達閘門值）：可能是 AI 抄錯、也可能是學生真的寫簡體 → 交老師判
    simplified,
    feedback: null,
    level: gate ? { suggested: gate.level, final: gate.level, reason: gate.reason, dimensions: [] } : null,
    gate: gate ? gate.reason : null,
    ms: Date.now() - t0,
  }
}

/**
 * Phase B：眉批＋建議級分。只吃 Phase A 產出的抄本（純文字）＋題本圖，不需要學生卷影像。
 *   拆成兩支的理由（2026-09-20 user 要求「批改動線切成四流程」）：
 *   ①前三格（裁行／逐行讀取／數格子校對）3 秒內跑完，第四格才是那 20 秒的等待 → loading 才誠實
 *   ②抄本先落地（phase_a_state），眉批失敗不會連抄寫成果一起白費
 * @param {object} draft runEssayTranscribe 的產出
 */
export async function runEssayFeedback({
  executeStage,
  extractCandidateText,
  apiKey,
  model,
  payload = {},
  routeHint = {},
  draft,
  bookletImages = [],
  gradeLabel,
  // 學測國寫的每卷專屬評分原則（essayGsatRubricOf(layout)）。沒有＝會考，下面兩支 prompt 與過去逐字元相同。
  gsatRubric = null,
  log = () => {},
}) {
  const t0 = Date.now()
  const columns = draft?.columns ?? []
  const paras = draft?.paragraphs ?? []
  const totalChars = draft?.chars ?? 0
  // 零 AI 閘門在 Phase A 就判定了（空白卷／字數過少）→ 這裡直接原樣回傳，不叫 AI
  if (draft?.gate) {
    log(`[Essay] 零 AI 閘門（${draft.gate}）→ Phase B 不叫 AI`)
    return { ...draft, ms: (draft.ms ?? 0) + (Date.now() - t0) }
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
      stageContents: [{ role: 'user', parts: [{ text: buildEssayFeedbackPrompt(paras, gradeLabel, gsatRubric ?? undefined) }, ...bookletParts] }],
    }),
    executeStage({
      apiKey,
      model,
      payload: { ...payload, ...ESSAY_LEVEL_GENERATION_CONFIG },
      timeoutMs: 90_000,
      routeKey: ESSAY_ROUTES.level,
      routeHint,
      stageContents: [{ role: 'user', parts: [{ text: gsatRubric ? buildGsatLevelPrompt(gsatRubric, paras, totalChars) : buildEssayLevelPrompt(paras, totalChars) }, ...bookletParts] }],
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
  const lvRaw = lvResp?.ok ? parseJsonLoose(extractCandidateText(lvResp.data) || '') : null
  // 學測：判官回的是等第 → 換成管線通用的 level 形狀（overall 0~6）；離題由 code 定 0。會考原樣。
  const lv = gsatRubric ? normalizeGsatLevel(lvRaw) : lvRaw

  // ── 5) 引用句 code 驗證＋定位回直行（驗不過＝判官幻覺，標記但不丟棄，交老師看）──
  const withLoc = (arr, key) => (Array.isArray(arr) ? arr : []).map((x) => {
    const loc = locateQuote(columns, x?.[key])
    return { ...x, loc: loc.ok ? { page: loc.page, col: loc.col, toCol: loc.toCol } : null, quoteVerified: loc.ok }
  })
  // 錯別字分桶（user 09-20 拍板）：字典確認＝高信心直接採用；字典不確認＝低信心交老師確認。
  //   ⛔「字典抓到但 AI 沒抓到」一律無視——實驗數據 30 筆命中官方真值 0 筆，純雜訊。
  // 錯別字要能在低信心清單裡「看到稿紙上的那個字」→ 定位到**格**（不只行），前端才裁得出來
  const typosLocated = (Array.isArray(fb?.typos) ? fb.typos : []).map((t) => {
    const cell = locateTypoCell(columns, t?.context, t?.wrong)
    return {
      ...t,
      loc: cell.ok ? { page: cell.page, col: cell.col, row: cell.row, toCol: cell.toCol, toRow: cell.toRow } : null,
      quoteVerified: cell.ok,
    }
  })
  const bucketed = bucketTypos(typosLocated)
  if (fb) log(`[Essay] 錯別字 ${bucketed.typos.length} 個：高信心 ${bucketed.highCount}、低信心 ${bucketed.lowCount}`)
  const feedback = fb ? {
    typos: bucketed.typos,
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
    rows: draft?.rows,
    paragraphs: paras,
    chars: totalChars,
    // ⛔ 拆 Phase A／B 時漏改的：lowCount 定義在 runEssayTranscribe，這支拿不到 → ReferenceError
    //   （09-20 實測：眉批與級分都跑完了，最後組回傳值才爆，9 份全挂）。一律從 draft 取。
    lowConfidenceColumns: draft?.lowConfidenceColumns ?? columns.filter((c) => c.lowConfidence).length,
    // 零星簡體字也是 Phase A 算的 → 一律從 draft 取，別在這裡重算
    simplified: draft?.simplified ?? [],
    feedback,
    level: {
      suggested,
      // final＝老師確認後的級分；批改當下先等於建議級分
      final: suggested,
      reason: String(lv?.reason ?? ''),
      dimensions: Array.isArray(lv?.dimensions) ? lv.dimensions : [],
      // 學測才有：前端據此把 0~6 顯示成等第（A+…C），並知道 dimensions 是「題旨要素」不是會考四向度
      ...(gsatRubric ? { scale: 'gsat', grade: lv?.grade ?? null, onTopic: lv?.onTopic ?? null } : {}),
    },
    gate: null,
    ms: (draft?.ms ?? 0) + (Date.now() - t0),
  }
}

/** 一次跑完（Phase A＋Phase B）。保留給不分段的呼叫端；orchestrator 已改走分段版。 */
export async function runEssayGrading(p) {
  const draft = await runEssayTranscribe(p)
  return runEssayFeedback({ ...p, draft })
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
  // ⛔ 2026-09-20 user 拍板：**抄寫錯誤全部忽略、不要老師確認**。理由（實測後成立）：
  //   ①改了抄本不會重跑眉批／級分，是「做了等於沒做」的動作
  //   ②學生檢討單印的是原卷筆跡，抄錯不影響
  //   ③10 份卷每份都有低信心行 → 「需要複核」100% 亮起、等於雜訊
  //   需要複核改由「低信心錯別字」驅動；抄本落差只在**比例過高**時當整份卷的品質警示。
  const lowTypos = (essayResult?.feedback?.typos ?? []).filter((t) => t?.confidence !== 'high')
  const written = (essayResult?.columns ?? []).filter((c) => c?.text).length
  const lowCols = essayResult?.lowConfidenceColumns ?? 0
  const badRatio = written > 0 ? lowCols / written : 0
  const reasons = []
  if (lowTypos.length) reasons.push(`有 ${lowTypos.length} 個疑似錯別字字典無法確認，請老師判斷`)
  // ⚠ needsReview／reviewReasons 是 2026-06-01 就退役的舊旗標（「需要複核」橫幅已移除），
  //   這裡保留只為相容。**真正活著的入口是頂欄「低信心檢視」modal**，它聚合 systemConfidence<70 的格。
  //   作文一份卷只有一格 → 接不上「每個錯別字一筆」，所以另外把數量帶在 detail 上給前端聚合。
  // 抄本落差過半＝掃描歪掉／拍糊／寫出格線，整份的眉批與級分都不能信 → 這種才值得吵老師
  if (badRatio > 0.4) reasons.push(`這份有 ${lowCols}/${written} 行抄寫落差偏大，建議看一下原卷再採信級分`)
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
    // 低信心檢視 modal 要用的：這份卷有幾個待確認的錯別字（0 就不會進清單）
    essayLowTypoCount: lowTypos.length,
    essayResult,
  }
  return {
    totalScore: qr.score,
    details: [detail],
    mistakes: [],
    weaknesses: [],
    suggestions: [],
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
  }
}
