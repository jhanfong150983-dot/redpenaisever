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

const DEFAULT_TIMEOUT_MS = 15000

/**
 * 是否啟用 OCR 增益。為單一進入點檢查、上層只查這個 boolean。
 */
export function isOcrAssistEnabled() {
  const raw = getEnvValue('OCR_ASSIST_CLASSIFY_ENABLED')
  if (!raw) return false
  return String(raw).trim().toLowerCase() === 'true'
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
export async function runOcrOnImage(imageBytes, mimeType, opts = {}) {
  const config = getOcrConfig()
  if (!config) {
    console.warn('[ocr-client] missing OCR_SERVER_URL or OCR_SERVER_API_KEY → skip OCR')
    return null
  }

  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS
  const filename = opts.filename || 'submission' + extFor(mimeType)

  // 用 multipart/form-data 上傳
  // Node 18+ FormData 是內建的，不需要 form-data 套件
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
      console.warn(`[ocr-client] OCR ${resp.status} after ${elapsedMs}ms → fallback`)
      return null
    }
    const data = await resp.json()
    if (!Array.isArray(data?.image_size) || !Array.isArray(data?.detections)) {
      console.warn('[ocr-client] OCR response shape invalid → fallback')
      return null
    }
    return { ...data, elapsedMs }
  } catch (e) {
    const elapsedMs = Date.now() - t0
    const reason = e?.name === 'AbortError' ? 'timeout/abort' : (e?.message || 'unknown')
    console.warn(`[ocr-client] OCR call failed after ${elapsedMs}ms: ${reason} → fallback`)
    return null
  } finally {
    clearTimeout(timer)
  }
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

/**
 * answer_only 模式單獨開關（跟 OCR_ASSIST_CLASSIFY_ENABLED 獨立）。
 * 注釋題穩定後不希望 answer_only 開發影響它、所以分開 flag 控制。
 *
 * Default ON（要關掉才設 OCR_ASSIST_ANSWER_ONLY_ENABLED=false）。
 */
export function isOcrAssistAnswerOnlyEnabled() {
  const raw = getEnvValue('OCR_ASSIST_ANSWER_ONLY_ENABLED')
  if (!raw) return true  // default on
  return String(raw).trim().toLowerCase() !== 'false'
}

/**
 * with_questions 模式 single_choice 結構解析增益開關。
 * Default ON（要關掉才設 OCR_ASSIST_SINGLE_CHOICE_ENABLED=false）。
 *
 * 為什麼要分支：single_choice anchorHint 是純結構描述（「題組X第N小題前括號」）、
 * LCS+Dice 配不到、需要 regex 結構解析。
 */
export function isOcrAssistSingleChoiceEnabled() {
  const raw = getEnvValue('OCR_ASSIST_SINGLE_CHOICE_ENABLED')
  if (!raw) return true  // default on
  return String(raw).trim().toLowerCase() !== 'false'
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
export async function prepareOcrHintsForClassify({ imageBytes, mimeType, answerKeyQuestions, answerSheetMode = 'with_questions', opts = {} }) {
  const isAnswerOnly = answerSheetMode === 'answer_only'
  // 依模式決定要查的 flag
  const enabled = isAnswerOnly ? isOcrAssistAnswerOnlyEnabled() : isOcrAssistEnabled()
  if (!enabled) {
    return { extraSection: '', ocrResult: null, candidatesByQid: {}, stats: { skipped: 'feature_flag_off', mode: answerSheetMode } }
  }
  if (!imageBytes || !answerKeyQuestions || answerKeyQuestions.length === 0) {
    return { extraSection: '', ocrResult: null, candidatesByQid: {}, stats: { skipped: 'empty_input', mode: answerSheetMode } }
  }

  const ocrResult = await runOcrOnImage(imageBytes, mimeType, opts)
  if (!ocrResult) {
    return { extraSection: '', ocrResult: null, candidatesByQid: {}, stats: { skipped: 'ocr_failed', mode: answerSheetMode } }
  }

  // ── candidates generator router ──
  let candidatesByQid, stats
  if (isAnswerOnly) {
    ;({ candidatesByQid, stats } = buildCellAnchorCandidates(answerKeyQuestions, ocrResult.detections, ocrResult.image_size))
  } else {
    // with_questions 模式：跑既有 LCS+Dice、再 merge single_choice 結構解析（如啟用）
    const lcsResult = buildAnchorCandidates(answerKeyQuestions, ocrResult.detections)
    candidatesByQid = lcsResult.candidatesByQid
    stats = { ...lcsResult.stats }
    if (isOcrAssistSingleChoiceEnabled()) {
      const scResult = buildSingleChoiceAnchorCandidates(answerKeyQuestions, ocrResult.detections, ocrResult.image_size)
      // 結構解析優先：覆寫 single_choice 題的 candidates
      let mergedCount = 0
      for (const [qid, cands] of Object.entries(scResult.candidatesByQid)) {
        candidatesByQid[qid] = cands
        mergedCount++
      }
      stats.singleChoiceStructural = {
        ...scResult.stats,
        mergedCount  // 多少 single_choice 題的 LCS 結果被結構解析覆蓋
      }
    }
  }
  const extraSection = buildOcrHintsSection(candidatesByQid, ocrResult.image_size)

  return {
    extraSection,
    ocrResult,
    candidatesByQid,
    stats: {
      ...stats,
      mode: answerSheetMode,
      ocrDetections: ocrResult.detections.length,
      ocrElapsedMs: ocrResult.elapsedMs,
      hintInjected: extraSection.length > 0
    }
  }
}
