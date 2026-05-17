/**
 * OCR Client — Phase A classify 增益用 OCR HTTP wrapper
 *
 * 對應遠端 PaddleOCR FastAPI server（透過 Cloudflare tunnel 暴露）。
 * 設計目標：
 * - 失敗 graceful：timeout / 5xx / 連線錯誤 → 不擲出，回 null + warning，讓上層 fallback 純視覺 classify
 * - 多頁支援：每頁分開送 OCR（避免 4000px max_side 限制 + 提升解析度）
 * - 不增加 critical path：合理 timeout 設定，超時即 abort
 *
 * 使用方式（典型）：
 *   const ocr = await runOcrOnInlineImage(inlineImageData, mimeType, { timeoutMs: 12000 })
 *   if (ocr) { ...build candidates... } else { ...fallback... }
 *
 * 環境變數（與 production 對齊）：
 *   OCR_SERVER_URL          (e.g. https://...trycloudflare.com)
 *   OCR_SERVER_API_KEY      (e.g. dev-secret-please-change)
 *   OCR_ASSIST_CLASSIFY_ENABLED  (true/false; 預設 false → 整個 OCR 增益關閉)
 */

import { getEnvValue } from '../_env.js'

const DEFAULT_TIMEOUT_MS = 45000  // bumped 15s → 45s：PaddleOCR 處理被降採樣到 4000px 的長圖常需 20-30s

/**
 * 是否啟用 OCR 增益。為單一進入點檢查、上層只查這個 boolean。
 */
export function isOcrAssistEnabled() {
  const raw = getEnvValue('OCR_ASSIST_CLASSIFY_ENABLED')
  const enabled = !!raw && String(raw).trim().toLowerCase() === 'true'
  console.log(`[ocr-client] isOcrAssistEnabled() = ${enabled} (raw="${raw || ''}")`)
  return enabled
}

function getOcrConfig() {
  const url = String(getEnvValue('OCR_SERVER_URL') || '').trim()
  const apiKey = String(getEnvValue('OCR_SERVER_API_KEY') || '').trim()
  if (!url || !apiKey) return null
  return { url: url.replace(/\/+$/, ''), apiKey }
}

/**
 * 對單張圖呼叫 OCR /ocr endpoint。
 * @param {Buffer|Uint8Array} imageBytes - 圖片原始 bytes
 * @param {string} mimeType - 'image/webp' / 'image/jpeg' / 'image/png'
 * @param {Object} opts - { timeoutMs, filename, abortSignal }
 * @returns {Promise<{ image_size:[number,number], detections:Array, elapsedMs:number } | null>}
 *   失敗 / timeout / config 缺：回 null（讓上層 fallback）
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function runOcrOnImage(imageBytes, mimeType, opts = {}) {
  const config = getOcrConfig()
  if (!config) {
    console.warn('[ocr-client] missing OCR_SERVER_URL or OCR_SERVER_API_KEY → skip OCR')
    return null
  }

  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS
  const filename = opts.filename || 'submission' + extFor(mimeType)
  const sizeKB = imageBytes ? (imageBytes.length / 1024).toFixed(1) : '0'
  const maxRetries = 2  // 2026-05-17 加 retry：cloudflare tunnel 偶爾 502/503/504、retry 通常救回
  console.log(`[ocr-client] runOcrOnImage → ${filename} ${sizeKB}KB timeout=${timeoutMs}ms url=${config.url}`)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const blob = new Blob([imageBytes], { type: mimeType })
    const form = new FormData()
    form.append('file', blob, filename)

    const controller = new AbortController()
    const externalSignal = opts.abortSignal
    if (externalSignal) {
      if (externalSignal.aborted) return null
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const t0 = Date.now()
    try {
      const resp = await fetch(`${config.url}/ocr`, {
        method: 'POST',
        headers: { 'X-API-Key': config.apiKey },
        body: form,
        signal: controller.signal
      })
      const elapsedMs = Date.now() - t0
      if (!resp.ok) {
        // 5xx 才 retry（4xx 不 retry、可能是 API key / payload 問題）
        const isRetriable = resp.status >= 500 && resp.status < 600
        if (isRetriable && attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 4000)
          console.warn(`[ocr-client] OCR ${resp.status} after ${elapsedMs}ms → retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms`)
          clearTimeout(timer)
          await sleep(backoffMs)
          continue
        }
        console.warn(`[ocr-client] OCR ${resp.status} after ${elapsedMs}ms → fallback (attempt=${attempt + 1}/${maxRetries + 1})`)
        return null
      }
      const data = await resp.json()
      if (!Array.isArray(data?.image_size) || !Array.isArray(data?.detections)) {
        console.warn('[ocr-client] OCR response shape invalid → fallback')
        return null
      }
      const retryNote = attempt > 0 ? ` (after ${attempt} retry)` : ''
      console.log(`[ocr-client] OCR ${resp.status} OK after ${elapsedMs}ms → ${data.detections.length} detections, image_size=${JSON.stringify(data.image_size)}${retryNote}`)
      return { ...data, elapsedMs }
    } catch (e) {
      const elapsedMs = Date.now() - t0
      const isAbort = e?.name === 'AbortError'
      const reason = isAbort ? 'timeout/abort' : (e?.message || 'unknown')
      // timeout/network error 也 retry（除非是 external abort）
      if (!isAbort && attempt < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 4000)
        console.warn(`[ocr-client] OCR call failed after ${elapsedMs}ms: ${reason} → retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms`)
        clearTimeout(timer)
        await sleep(backoffMs)
        continue
      }
      // External abort (pipeline budget exhausted) — 不 retry
      if (isAbort && externalSignal?.aborted) {
        console.warn(`[ocr-client] OCR aborted by external signal after ${elapsedMs}ms → fallback`)
        return null
      }
      // 內部 timeout、retry 一次看 cloudflare 是否 recover
      if (attempt < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 4000)
        console.warn(`[ocr-client] OCR timeout after ${elapsedMs}ms → retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms`)
        clearTimeout(timer)
        await sleep(backoffMs)
        continue
      }
      console.warn(`[ocr-client] OCR call failed after ${elapsedMs}ms: ${reason} → fallback (attempt=${attempt + 1}/${maxRetries + 1})`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

/**
 * 多頁同時 OCR（每頁獨立呼叫、parallel）。
 * 用於 production classify 已 split 出 per-page image data 後。
 *
 * @param {Array<{ data: Buffer, mimeType: string }>} pages
 * @param {Object} opts - { timeoutMs }
 * @returns {Promise<Array<OcrResult|null>>}
 */
export async function runOcrPerPage(pages, opts = {}) {
  if (!Array.isArray(pages) || pages.length === 0) return []
  return await Promise.all(
    pages.map((p, idx) => runOcrOnImage(p.data, p.mimeType, { ...opts, filename: `page${idx + 1}${extFor(p.mimeType)}` }))
  )
}

/**
 * 對 inline image (Gemini API 的 inlineData 格式) 跑 OCR。
 * inline.data 是 base64 string、需要 decode。
 *
 * @param {{ inlineData: { data: string, mimeType: string } }} inlineImage
 * @param {Object} opts
 * @returns {Promise<OcrResult|null>}
 */
export async function runOcrOnInlineImage(inlineImage, opts = {}) {
  const data = inlineImage?.inlineData?.data
  const mimeType = inlineImage?.inlineData?.mimeType
  if (!data || !mimeType) return null
  const bytes = Buffer.from(data, 'base64')
  return await runOcrOnImage(bytes, mimeType, opts)
}

function extFor(mimeType) {
  if (!mimeType) return ''
  const m = String(mimeType).toLowerCase()
  if (m.includes('webp')) return '.webp'
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
  if (m.includes('png')) return '.png'
  return ''
}

// ── High-level adapter for staged-grading.js classify integration ──
import { buildAnchorCandidates, buildOcrHintsSection } from './bbox-anchor-match.js'
import { buildCellAnchorCandidates } from './bbox-cell-anchor-match.js'
import { buildSingleChoiceAnchorCandidates } from './bbox-single-choice-match.js'
import { buildBracketGapCandidates } from './bbox-bracket-gap-match.js'
import { buildSubCellAnchorCandidates } from './bbox-sub-cell-match.js'
import { buildBlankParenCandidates } from './bbox-blank-paren-match.js'
import { buildRowAnchorCandidates, isEligibleForRowAnchor } from './bbox-row-anchor-match.js'

/**
 * answer_only 模式單獨開關（跟 OCR_ASSIST_CLASSIFY_ENABLED 獨立）。
 *
 * Default OFF（2026-05-14 改）。
 * Why: 5+5+25 份本地測試證實 answer_only 卷（純題號+方框 table）classify
 * 自己就夠強、加 OCR HINTS / override 反而把 classify 已對齊的 bbox 推歪。
 * 拍照歪曲 case 由 user 重拍處理、不在這支 pipeline 救。
 * 緊急 backup：設 OCR_ASSIST_ANSWER_ONLY_ENABLED=true 可重新打開。
 */
export function isOcrAssistAnswerOnlyEnabled() {
  const raw = getEnvValue('OCR_ASSIST_ANSWER_ONLY_ENABLED')
  if (!raw) return false  // default off
  return String(raw).trim().toLowerCase() === 'true'
}

/**
 * with_questions 模式 single_choice 結構解析增益開關。
 *
 * Default OFF（2026-05-15 改）。
 * Why: 自然/學力檢測類 single_choice 卷子上 user 實證 OCR matcher 抓錯 bbox、
 * 導致 read AI 系統性誤讀某些題（13+ 人選同樣的「錯」答案、實則是 bbox 框到錯位置）。
 * 改回純 classify 視覺判斷、不靠 OCR 結構 anchor。
 * 緊急 backup：設 OCR_ASSIST_SINGLE_CHOICE_ENABLED=true 可開回去。
 */
export function isOcrAssistSingleChoiceEnabled() {
  const raw = getEnvValue('OCR_ASSIST_SINGLE_CHOICE_ENABLED')
  if (!raw) return false  // default off
  return String(raw).trim().toLowerCase() === 'true'
}

/**
 * with_questions 模式 fill_blank-with-bracket gap 偵測增益開關。
 * Default OFF（2026-05-17 改：fill_blank 改走純 AI classify、OCR matchers 不提供 hint）
 *
 * 歷史：原本想用 OCR 找答題格 bbox 當 classify hint、但 fill_blank 多 paren / 拆段 / 算式 □ 等
 * 結構複雜、OCR matchers 無法穩定產出 ON_BLANK bbox、反而干擾 AI classify。
 * 經 3 model × 5 run 一致性測試（Pro 3.0 best 73%）、決定 fill_blank 移除 OCR hint。
 */
export function isOcrAssistBracketGapEnabled() {
  const raw = getEnvValue('OCR_ASSIST_BRACKET_GAP_ENABLED')
  if (!raw) return false  // default off (2026-05-17)
  return String(raw).trim().toLowerCase() === 'true'
}

/**
 * with_questions 模式 multi_fill 子格 (N)label 後方底線增益開關。
 * Default OFF（2026-05-17 改：fill_blank 改走純 AI classify、OCR matchers 不提供 hint）
 */
export function isOcrAssistSubCellEnabled() {
  const raw = getEnvValue('OCR_ASSIST_SUB_CELL_ENABLED')
  if (!raw) return false  // default off (2026-05-17)
  return String(raw).trim().toLowerCase() === 'true'
}

/**
 * with_questions 模式 fill_blank「prefix（ ）suffix」（括號內留空）增益開關。
 * Default OFF（2026-05-17 改：fill_blank 改走純 AI classify、OCR matchers 不提供 hint）
 */
export function isOcrAssistBlankParenEnabled() {
  const raw = getEnvValue('OCR_ASSIST_BLANK_PAREN_ENABLED')
  if (!raw) return false  // default off (2026-05-17)
  return String(raw).trim().toLowerCase() === 'true'
}

/**
 * Row anchor matcher（single_choice / multi_choice / true_false）開關。
 * Default OFF（要打開才設 OCR_ROW_ANCHOR_ENABLED=true）。
 *
 * 用 OCR 找印刷「N.」題號 row、直接覆寫 classify Gemini 對該題的 bbox。
 * 適用：連續編號（無題組）+ 高解析度（>= 1000px）+ 單選/多選/是非題。
 *
 * 自然測試 29 份本地實證 725/725 cells framed、+15.4% AI 對 vs production。
 * 落地策略：先開、用 production stage_logs 觀察一週、再決定 default。
 * 詳見：local-only/自然測試_1/、Phase 1 落地紀錄。
 */
export function isOcrRowAnchorEnabled() {
  const raw = getEnvValue('OCR_ROW_ANCHOR_ENABLED')
  if (!raw) return false  // default off
  return String(raw).trim().toLowerCase() === 'true'
}

/**
 * 為 classify prompt 準備 OCR HINTS section（高階 adapter）。
 * 失敗 graceful：任何環節失敗（feature flag off、OCR 掛、無 candidate）都回空字串
 * → classify prompt 等同沒這段、走純視覺判斷。
 *
 * 依 answerSheetMode 路由不同的 candidates generator：
 *   - 'answer_only'  → buildCellAnchorCandidates（regex + OCR section header + 印刷編號 row）
 *   - 其他            → buildAnchorCandidates（LCS + Dice 文字配對）
 *
 * Output schema 一致、downstream HINT 渲染 / post-processing 共用。
 *
 * @param {Object} params
 * @param {Buffer} params.imageBytes - 該頁圖片原始 bytes
 * @param {string} params.mimeType
 * @param {Array} params.answerKeyQuestions - 該頁的 answerKey questions
 * @param {string} [params.answerSheetMode] - 'answer_only' | 'with_questions'
 * @param {Object} params.opts - { timeoutMs }
 * @returns {Promise<{ extraSection: string, ocrResult: object|null, candidatesByQid: object, stats: object|null }>}
 */
export async function prepareOcrHintsForClassify({ imageBytes, mimeType, answerKeyQuestions, answerSheetMode = 'with_questions', opts = {}, inputCropTopRatio = 0 }) {
  const isAnswerOnly = answerSheetMode === 'answer_only'
  // 依模式決定要查的 flag
  const enabled = isAnswerOnly ? isOcrAssistAnswerOnlyEnabled() : isOcrAssistEnabled()
  console.log(`[ocr-client.prepareHints] entry mode=${answerSheetMode} enabled=${enabled} questions=${answerKeyQuestions?.length || 0} bytes=${imageBytes?.length || 0} cropTop=${inputCropTopRatio}`)
  if (!enabled) {
    console.log(`[ocr-client.prepareHints] skipped: feature_flag_off`)
    return { extraSection: '', ocrResult: null, candidatesByQid: {}, stats: { skipped: 'feature_flag_off', mode: answerSheetMode } }
  }
  if (!imageBytes || !answerKeyQuestions || answerKeyQuestions.length === 0) {
    console.log(`[ocr-client.prepareHints] skipped: empty_input`)
    return { extraSection: '', ocrResult: null, candidatesByQid: {}, stats: { skipped: 'empty_input', mode: answerSheetMode } }
  }

  let ocrResult = await runOcrOnImage(imageBytes, mimeType, opts)
  if (!ocrResult) {
    console.log(`[ocr-client.prepareHints] skipped: ocr_failed (runOcrOnImage returned null)`)
    return { extraSection: '', ocrResult: null, candidatesByQid: {}, stats: { skipped: 'ocr_failed', mode: answerSheetMode } }
  }

  // 🆕 若是 overlap-split 的圖（input 前 N% 是借來的前頁底）、把 OCR 結果從 overlap 座標
  // 轉成 no-overlap 座標：detection y 扣掉 overlap、image_size height 縮。
  // ⚠️ NOT 丟掉 overlap region 的 detection — overlap 的目的就是要 catch 那邊的 group
  // header（如「題組七」落在前頁底跨進來）、丟掉 = 浪費 overlap 的意義。讓 detection y
  // 可以是負值、matcher 的 detectGroups 仍能識別、findQuestionNumberRows 找出的 question
  // rows 是 page 本體（y > 0 in adjusted）、HINT/override 拿到的 candidate 都是正常 y。
  if (inputCropTopRatio > 0 && Array.isArray(ocrResult.image_size)) {
    const [imgW, imgH] = ocrResult.image_size
    const overlapPxInOcr = Math.round(imgH * inputCropTopRatio)
    const adjustedDetections = (ocrResult.detections || []).map((d) => {
      const [x1, y1, x2, y2] = d.bbox
      return { ...d, bbox: [x1, y1 - overlapPxInOcr, x2, y2 - overlapPxInOcr] }
    })
    const overlapHeaderCount = adjustedDetections.filter((d) => d.bbox[3] <= 0).length
    ocrResult = {
      ...ocrResult,
      image_size: [imgW, imgH - overlapPxInOcr],
      detections: adjustedDetections,
      overlapAdjusted: { inputCropTopRatio: +inputCropTopRatio.toFixed(3), overlapPxInOcr, overlapHeaderCount }
    }
    console.log(`[ocr-client.prepareHints] overlap-adjusted: -${overlapPxInOcr}px y, ${overlapHeaderCount} detections in overlap region (kept for group detection)`)
  }

  // ── candidates generator router ──
  let candidatesByQid, stats
  if (isAnswerOnly) {
    ;({ candidatesByQid, stats } = buildCellAnchorCandidates(answerKeyQuestions, ocrResult.detections, ocrResult.image_size))
  } else {
    // with_questions 模式：LCS+Dice 為基礎、再 merge single_choice + bracket gap 增益
    const lcsResult = buildAnchorCandidates(answerKeyQuestions, ocrResult.detections)
    candidatesByQid = lcsResult.candidatesByQid
    stats = { ...lcsResult.stats }

    // single_choice 結構解析：覆寫 single_choice qids
    if (isOcrAssistSingleChoiceEnabled()) {
      const scResult = buildSingleChoiceAnchorCandidates(answerKeyQuestions, ocrResult.detections, ocrResult.image_size)
      let mergedCount = 0
      for (const [qid, cands] of Object.entries(scResult.candidatesByQid)) {
        candidatesByQid[qid] = cands
        mergedCount++
      }
      stats.singleChoiceStructural = { ...scResult.stats, mergedCount }
    }

    // bracket gap 偵測：覆寫 fill_blank-with-bracket qids（精準 gap 取代 LCS row）
    if (isOcrAssistBracketGapEnabled()) {
      const bgResult = buildBracketGapCandidates(answerKeyQuestions, ocrResult.detections, ocrResult.image_size)
      let mergedCount = 0
      for (const [qid, cands] of Object.entries(bgResult.candidatesByQid)) {
        candidatesByQid[qid] = cands
        mergedCount++
      }
      stats.bracketGap = { ...bgResult.stats, mergedCount }
    }

    // sub-cell 偵測：覆寫 multi_fill「(N)label 後方底線」格式的 qids
    if (isOcrAssistSubCellEnabled()) {
      const subResult = buildSubCellAnchorCandidates(answerKeyQuestions, ocrResult.detections, ocrResult.image_size)
      let mergedCount = 0
      for (const [qid, cands] of Object.entries(subResult.candidatesByQid)) {
        candidatesByQid[qid] = cands
        mergedCount++
      }
      stats.subCell = { ...subResult.stats, mergedCount }
    }

    // blank-paren 偵測：覆寫 fill_blank「prefix（ ）suffix」格式的 qids
    if (isOcrAssistBlankParenEnabled()) {
      const bpResult = buildBlankParenCandidates(answerKeyQuestions, ocrResult.detections, ocrResult.image_size)
      let mergedCount = 0
      for (const [qid, cands] of Object.entries(bpResult.candidatesByQid)) {
        candidatesByQid[qid] = cands
        mergedCount++
      }
      stats.blankParen = { ...bpResult.stats, mergedCount }
    }
  }
  const extraSection = buildOcrHintsSection(candidatesByQid, ocrResult.image_size)

  // 🆕 Row anchor matcher — 跟 candidatesByQid (HINTS) 獨立的 full-replace bbox
  // 只對 single_choice/multi_choice/true_false 連續編號 + 高解析度卷子啟用
  let rowAnchorBboxes = null
  let rowAnchorEligibility = null
  if (isOcrRowAnchorEnabled() && !isAnswerOnly) {
    rowAnchorEligibility = isEligibleForRowAnchor(answerKeyQuestions, ocrResult.image_size)
    if (rowAnchorEligibility.eligible) {
      const rowResult = buildRowAnchorCandidates(answerKeyQuestions, ocrResult.detections, ocrResult.image_size)
      rowAnchorBboxes = rowResult.candidatesByQid
      stats.rowAnchor = { ...rowResult.stats, eligibility: 'eligible' }
    } else {
      stats.rowAnchor = { skipped: rowAnchorEligibility.reason, detail: rowAnchorEligibility.detail }
    }
  }

  return {
    extraSection,
    ocrResult,
    candidatesByQid,
    rowAnchorBboxes,  // 🆕 single_choice 全替換 bbox（單獨於 candidatesByQid）
    stats: {
      ...stats,
      mode: answerSheetMode,
      ocrDetections: ocrResult.detections.length,
      ocrElapsedMs: ocrResult.elapsedMs,
      hintInjected: extraSection.length > 0
    }
  }
}
