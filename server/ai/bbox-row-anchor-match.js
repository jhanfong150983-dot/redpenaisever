/**
 * bbox-row-anchor-match.js
 *
 * OCR-based question row anchoring for single_choice / multi_choice / true_false questions.
 *
 * 設計目標：解 classify Gemini 對「N.(  )」結構視覺判斷不穩的問題、
 * 改用 PaddleOCR 找印刷的「N.」題號 row、derive 答題格 bbox。
 *
 * 適用範圍（必三條全部滿足）：
 *   1. 題目都是 single_choice / multi_choice / true_false（OR 混合卷的這幾種題型）
 *   2. anchorHint 是「位於第N小題題號前的括號內」格式（**無題組前綴**、連續編號）
 *   3. 圖像寬 ≥ 1000 px（低解析度 OCR 偵測率不足）
 *
 * 不適用：
 *   - 題組結構（「位於題組X第N小題」）
 *   - 低解析度掃描
 *   - 非 "N.(  )" 格式的答題格
 *
 * Algorithm：
 *   Pass 1：文字匹配 "N." pattern + column x 過濾
 *   Pass 2：用 Pass 1 抓到的 row y 內插預測缺的 N、找該位置 OCR detection (含空 text)
 *   (Pass 3 合成 row 暫不做、production 安全優先、缺的 fallback 到 classify 原 bbox)
 *
 * Local test：local-only/自然測試_1/ 下、29 份自然測試實證 725/725 cells framed、
 *            hybrid AI 對 +31 over production。
 */

const ROW_ANCHOR_TYPES = new Set(['single_choice', 'multi_choice', 'true_false'])
const COL_X_LEFT_MAX = 220        // 左欄 x < 220
const COL_X_RIGHT_MIN = 600       // 右欄 x ≥ 600
const COL_X_RIGHT_MAX = 820       // 右欄 x < 820
const MIN_IMAGE_WIDTH = 1000      // 圖像寬度門檻
const MIN_OCR_SCORE = 0.4         // OCR confidence 過濾
const Y_INTERPOLATION_TOLERANCE = 60  // Pass 2 內插 y ± 60 px 內搜尋

// ── eligibility 檢查 ──────────────────────────────────────────

/**
 * 判斷 assignment 是否適用 row anchor matcher
 * @param {Array} answerKeyQuestions
 * @param {Array<number>} imageSize [w, h]
 * @returns {Object} { eligible: boolean, reason: string }
 */
export function isEligibleForRowAnchor(answerKeyQuestions, imageSize) {
  if (!Array.isArray(answerKeyQuestions) || answerKeyQuestions.length === 0) {
    return { eligible: false, reason: 'no_questions' }
  }
  if (!Array.isArray(imageSize) || imageSize.length !== 2) {
    return { eligible: false, reason: 'no_image_size' }
  }
  if (imageSize[0] < MIN_IMAGE_WIDTH) {
    return { eligible: false, reason: 'low_resolution', detail: `width=${imageSize[0]} < ${MIN_IMAGE_WIDTH}` }
  }
  // 看適用題型有幾個
  const applicable = answerKeyQuestions.filter(q => ROW_ANCHOR_TYPES.has(q.questionCategory))
  if (applicable.length === 0) {
    return { eligible: false, reason: 'no_applicable_types' }
  }
  // 檢查 anchorHint：適用題型的 anchorHint **不能** 含「題組」
  // 連續編號才能用 N. 唯一定位
  for (const q of applicable) {
    const hint = String(q.anchorHint || '')
    if (hint.includes('題組')) {
      return { eligible: false, reason: 'group_structure', detail: `${q.id} has group anchor: ${hint}` }
    }
  }
  return { eligible: true, applicableCount: applicable.length, totalCount: answerKeyQuestions.length }
}

// ── 字寬權重 ──────────────────────────────────────────────────

function charW(c) { return c.charCodeAt(0) < 256 ? 0.5 : 1.0 }
function strW(s) { let w = 0; for (const c of s) w += charW(c); return w }

// ── extract printed N from question id ──────────────────────

/**
 * 從 questionId 抽出印刷在紙上的題號 N
 * e.g. "1-1-5" → 5, "2-1-12" → 12
 */
function extractPrintedN(qid) {
  const parts = String(qid).split('-')
  const last = parseInt(parts[parts.length - 1])
  return Number.isFinite(last) ? last : null
}

// ── Pass 1：文字匹配 ──────────────────────────────────────────

function pass1FindRowsByText(detections) {
  const byN = new Map()
  for (const d of detections) {
    const t = String(d.rec_text || '').trim()
    const m = t.match(/^(\d{1,2})\s*[.．]/)
    if (!m) continue
    const n = parseInt(m[1])
    if (n < 1 || n > 99) continue
    if ((d.rec_score || 0) < MIN_OCR_SCORE) continue
    const x = d.bbox[0]
    // 必須在 column 範圍內、排除表格內的「1.水生植物」等
    if (!((x < COL_X_LEFT_MAX) || (x >= COL_X_RIGHT_MIN && x < COL_X_RIGHT_MAX))) continue
    const hasParen = /[（(]/.test(t)
    const cur = byN.get(n)
    const curHasParen = cur ? /[（(]/.test(cur.rec_text) : false
    // 優先有「(」的、其次 confidence 高的
    const better = !cur
      || (hasParen && !curHasParen)
      || (hasParen === curHasParen && d.rec_score > (cur.rec_score || 0))
    if (better) byN.set(n, d)
  }
  return byN
}

// ── Pass 1B：裸數字 + 鄰近 paren detection 配對 ───────────────
//
// 解決：production 用 jpeg q90 時、PaddleOCR 把「7.()又真希望...」拆成
// 多個 detection：「7」+「（）」+「又真希望...」。Pass 1 regex 只認
// 「N.」開頭、會漏。
// Pass 1B 找到「N」純數字 detection + 右側鄰近的 paren detection、配對合成 row。
//
// 跟 Pass 1A 互補：Pass 1A 抓到的 N 不會再被 Pass 1B 覆寫。

function pass1bFindDigitParenPairs(detections, applicableNs, byN) {
  const DIGIT_RE = /^\s*(\d{1,2})\s*$/
  const PAREN_RE = /[（(]/
  const DIGIT_MIN_SCORE = 0.8
  const PAREN_MAX_X_DIST = 80
  const Y_CENTER_MAX_DIST = 15

  for (const d of detections) {
    const t = String(d.rec_text || '').trim()
    const m = t.match(DIGIT_RE)
    if (!m) continue
    const n = parseInt(m[1])
    if (n < 1 || n > 99) continue
    if (!applicableNs.includes(n)) continue
    if (byN.has(n)) continue  // Pass 1A 已經抓到
    if ((d.rec_score || 0) < DIGIT_MIN_SCORE) continue
    const x = d.bbox[0]
    if (!((x < COL_X_LEFT_MAX) || (x >= COL_X_RIGHT_MIN && x < COL_X_RIGHT_MAX))) continue

    // 找右側鄰近的 paren detection
    const digRight = d.bbox[2]
    const digYCenter = (d.bbox[1] + d.bbox[3]) / 2
    let bestParen = null
    let bestDist = Infinity
    for (const p of detections) {
      if (p === d) continue
      const pt = String(p.rec_text || '').trim()
      if (!PAREN_RE.test(pt)) continue
      const xDist = p.bbox[0] - digRight
      if (xDist < -5 || xDist > PAREN_MAX_X_DIST) continue
      const pyCenter = (p.bbox[1] + p.bbox[3]) / 2
      if (Math.abs(pyCenter - digYCenter) > Y_CENTER_MAX_DIST) continue
      if (xDist < bestDist) { bestDist = xDist; bestParen = p }
    }
    if (!bestParen) continue

    // 合成 row detection、_pass1b 標記、deriveCellBbox 走 paren-direct path
    byN.set(n, {
      bbox: [d.bbox[0], Math.min(d.bbox[1], bestParen.bbox[1]), bestParen.bbox[2], Math.max(d.bbox[3], bestParen.bbox[3])],
      rec_text: `${m[1]}. ${bestParen.rec_text.trim()}`,
      rec_score: Math.min(d.rec_score, bestParen.rec_score),
      _pass1b: true,
      _parenBbox: bestParen.bbox  // [x1, y1, x2, y2] 絕對 px
    })
  }
}

// ── Pass 2：y 內插補漏 ────────────────────────────────────────

/**
 * 對 applicableQids 內缺的 N、用 Pass 1 結果預測 y、找該位置的 OCR detection
 */
function pass2InterpolateMissing(byN, allDetections, applicableNs, cellByN_px = new Map()) {
  // 分左右欄處理
  const sections = groupByColumn(applicableNs, byN)
  for (const sec of sections) {
    const foundList = sec.ns.filter(n => byN.has(n)).map(n => ({ n, y: byN.get(n).bbox[1] }))
    if (foundList.length < 2) continue
    const missing = sec.ns.filter(n => !byN.has(n))
    for (const n of missing) {
      const before = [...foundList].reverse().find(x => x.n < n)
      const after = foundList.find(x => x.n > n)
      // 🚨 只允許「夾在 before & after 之間」的內插、禁止單邊外插
      // 原因：欄底/欄頂題目沒 after/before、線性外插假設「row gap 恆定」
      // 但前題可能有長題幹（e.g. seat 8 自然測試 Q7、Q6 後 5 行題幹）→ 外插必錯
      // failed gracefully：沒 neighbors 夾就 fallback 給 classify 原 bbox
      if (!before || !after) continue
      const predY = before.y + (after.y - before.y) * (n - before.n) / (after.n - before.n)
      // 找 column x 範圍內、y ± tolerance 的 detection（含空 text）
      const candidates = allDetections.filter(d =>
        Math.abs(d.bbox[1] - predY) < Y_INTERPOLATION_TOLERANCE
        && d.bbox[0] >= sec.colXMin
        && d.bbox[0] < sec.colXMax
      )
      if (candidates.length === 0) continue
      const best = candidates.reduce((a, b) =>
        Math.abs(a.bbox[1] - predY) < Math.abs(b.bbox[1] - predY) ? a : b
      )
      // 🚨 寬度防呆：若 candidate 過寬（> 0.15 頁寬 ≈ 200px on 1342）、
      // 用同欄 Pass 1 cells 的 median x1/x2 替換、只保留 candidate 的 y
      const candW = best.bbox[2] - best.bbox[0]
      const wThreshold = (sec.colXMax - sec.colXMin) * 0.9  // 比 column 還寬就太誇張、應為 cell 不是 row
      let bboxToUse = best.bbox
      const widthSafetyTriggered = candW > 150  // 150 px、約 11% 頁寬
      if (widthSafetyTriggered) {
        // 🆕 用 Pass 1 已計算的 **cell bbox** median（不是 OCR row 整段寬）
        const sameColCells = sec.ns
          .filter(m => cellByN_px.has(m) && !byN.get(m)?._fallback)
          .map(m => cellByN_px.get(m))
        if (sameColCells.length >= 2) {
          const sorted = (arr) => [...arr].sort((a, b) => a - b)
          const med = (arr) => sorted(arr)[Math.floor(arr.length / 2)]
          const medX1 = med(sameColCells.map(c => c.x1))
          const medX2 = med(sameColCells.map(c => c.x2))
          bboxToUse = [medX1, best.bbox[1], medX2, best.bbox[3]]
        }
      }
      byN.set(n, { ...best, bbox: bboxToUse, _fallback: true, _n: n, _widthSafety: widthSafetyTriggered })
    }
  }
}

/**
 * 依 N 推 column（左/右）
 * 假設：左欄 x < 300、右欄 x ≥ 500
 * 從 Pass 1 結果推斷 N 屬於哪欄
 */
function groupByColumn(applicableNs, byN) {
  // 把已知 N 分左右欄
  const leftNs = []
  const rightNs = []
  for (const n of applicableNs) {
    if (byN.has(n)) {
      const x = byN.get(n).bbox[0]
      if (x < 400) leftNs.push(n)
      else rightNs.push(n)
    }
  }
  // 缺的 N 用相鄰 N 的 column 推（簡化：看前後鄰居是哪欄）
  const unassigned = applicableNs.filter(n => !byN.has(n))
  for (const n of unassigned) {
    // 找最近的已知鄰居
    const leftNeighbor = [...leftNs, ...rightNs].filter(x => x < n).sort((a, b) => b - a)[0]
    const rightNeighbor = [...leftNs, ...rightNs].filter(x => x > n).sort((a, b) => a - b)[0]
    const neighbor = leftNeighbor !== undefined ? leftNeighbor : rightNeighbor
    if (neighbor === undefined) continue
    if (leftNs.includes(neighbor)) leftNs.push(n)
    else rightNs.push(n)
  }
  return [
    { ns: [...leftNs].sort((a, b) => a - b), colXMin: 50, colXMax: 220 },
    { ns: [...rightNs].sort((a, b) => a - b), colXMin: 600, colXMax: 820 }
  ]
}

// ── derive cell bbox ─────────────────────────────────────────

/**
 * 從 row OCR detection derive 答案 cell bbox
 * 三種 path：完整 "(X)" pattern / 沒括號用 N. 後 offset / fallback (text=空、用 bbox)
 */
function deriveCellBbox(row, n, fullW, fullH) {
  const [x1, y1, x2, y2] = row.bbox
  const t = String(row.rec_text || '').trim()
  const nDigits = String(n).length
  const ddShift = nDigits === 2 ? 18 : 0
  const padL = 14, padR = 22, padY = 6

  if (row._fallback) {
    // text 空、bbox 本身可能就是 cell paren、放寬 padding
    return {
      x: Math.max(0, x1 - 5) / fullW,
      y: Math.max(0, y1 - padY) / fullH,
      w: (Math.min(fullW, x2 + 15) - Math.max(0, x1 - 5)) / fullW,
      h: (Math.min(fullH, y2 + padY) - Math.max(0, y1 - padY)) / fullH
    }
  }

  // Pass 1B：直接用 paren detection bbox 當 cell（已知精確位置、不用 ratio 算）
  if (row._pass1b && row._parenBbox) {
    const [px1, py1, px2, py2] = row._parenBbox
    return {
      x: Math.max(0, px1 - 6) / fullW,
      y: Math.max(0, py1 - padY) / fullH,
      w: (Math.min(fullW, px2 + 8) - Math.max(0, px1 - 6)) / fullW,
      h: (Math.min(fullH, py2 + padY) - Math.max(0, py1 - padY)) / fullH
    }
  }

  const fullParenMatch = t.match(/^(\d{1,2})\s*[.．]\s*[（(]\s*(.*?)\s*[)）]/)
  if (fullParenMatch) {
    const insideStart = t.indexOf(fullParenMatch[0].includes('（') ? '（' : '(')
    const insideEnd = (fullParenMatch[0].includes('）') ? t.indexOf('）', insideStart) : t.indexOf(')', insideStart)) + 1
    const totalW = strW(t)
    const ratioStart = strW(t.slice(0, insideStart)) / totalW
    const ratioEnd = strW(t.slice(0, insideEnd)) / totalW
    const rowW = x2 - x1
    const cellX1 = Math.max(0, x1 + ratioStart * rowW - padL + ddShift)
    const cellX2 = Math.min(fullW, x1 + ratioEnd * rowW + padR + ddShift)
    return {
      x: cellX1 / fullW,
      y: Math.max(0, y1 - padY) / fullH,
      w: (cellX2 - cellX1) / fullW,
      h: (Math.min(fullH, y2 + padY) - Math.max(0, y1 - padY)) / fullH
    }
  }

  // 沒括號、估計 "N." 後固定 offset
  const prefixPx = nDigits === 1 ? 25 : 45
  const cellW = 65
  const cellX1 = Math.max(0, x1 + prefixPx - 5)
  const cellX2 = Math.min(fullW, x1 + prefixPx + cellW + 15)
  return {
    x: cellX1 / fullW,
    y: Math.max(0, y1 - padY) / fullH,
    w: (cellX2 - cellX1) / fullW,
    h: (Math.min(fullH, y2 + padY) - Math.max(0, y1 - padY)) / fullH
  }
}

// ── 主入口 ───────────────────────────────────────────────────

/**
 * 從 OCR detections + answerKey questions 找適用題型的 row、輸出 bbox candidates
 *
 * @param {Array} answerKeyQuestions
 * @param {Array} detections OCR detections（per-page 或 full-image 座標都行、看 imageSize 對齊）
 * @param {Array<number>} imageSize [w, h]
 * @returns {{ candidatesByQid: Object<qid, {x,y,w,h}>, stats: Object }}
 */
export function buildRowAnchorCandidates(answerKeyQuestions, detections, imageSize) {
  const [imgW, imgH] = imageSize
  // 1. 找出 applicable questions
  const applicable = answerKeyQuestions.filter(q => ROW_ANCHOR_TYPES.has(q.questionCategory))
  if (applicable.length === 0) {
    return { candidatesByQid: {}, stats: { applicable: 0, matched: 0, reason: 'no_applicable' } }
  }
  // 2. N → qid mapping
  const nToQid = new Map()
  for (const q of applicable) {
    const n = extractPrintedN(q.id)
    if (n != null) nToQid.set(n, q.id)
  }
  const applicableNs = [...nToQid.keys()]
  // 3. Pass 1A：text 開頭 "N." 匹配
  const byN = pass1FindRowsByText(detections)
  const pass1aCount = byN.size
  // 3b. Pass 1B：補抓「裸 N + 鄰近 paren」配對（jpeg q90 下 OCR 拆兩個 detection 的情況）
  pass1bFindDigitParenPairs(detections, applicableNs, byN)
  const pass1bCount = byN.size - pass1aCount
  // 🆕 預先算 Pass 1 每題的 cell bbox（normalized 0~1）、Pass 2 widthSafety 用 cell median 而非 row median
  const cellByN_px = new Map()  // n → { x1,y1,x2,y2 } 絕對 px
  for (const [n, row] of byN) {
    const cell = deriveCellBbox(row, n, imgW, imgH)
    if (cell) {
      cellByN_px.set(n, {
        x1: cell.x * imgW,
        y1: cell.y * imgH,
        x2: (cell.x + cell.w) * imgW,
        y2: (cell.y + cell.h) * imgH
      })
    }
  }
  // 4. Pass 2 (只對 applicable N 補)、傳 cellByN_px 給 widthSafety
  pass2InterpolateMissing(byN, detections, applicableNs, cellByN_px)
  // 5. derive cell bboxes
  const candidatesByQid = {}
  let matchedCount = 0
  let fallbackCount = 0
  let widthSafetyCount = 0
  let pass1bUsed = 0
  for (const n of applicableNs) {
    const row = byN.get(n)
    if (!row) continue
    const cell = deriveCellBbox(row, n, imgW, imgH)
    if (!cell) continue
    const qid = nToQid.get(n)
    candidatesByQid[qid] = cell
    matchedCount++
    if (row._fallback) fallbackCount++
    if (row._widthSafety) widthSafetyCount++
    if (row._pass1b) pass1bUsed++
  }
  return {
    candidatesByQid,
    stats: {
      applicable: applicable.length,
      matched: matchedCount,
      matchRate: applicable.length ? +(matchedCount / applicable.length).toFixed(3) : 0,
      pass1aMatched: pass1aCount,
      pass1bMatched: pass1bCount,
      pass1bUsed,
      pass2Fallback: fallbackCount,
      widthSafetyTriggered: widthSafetyCount,
      assignmentMethod: 'row_anchor_n_pattern'
    }
  }
}

/**
 * 把 row anchor candidates 套用到 classifyAligned、回傳 overrides
 * 跟現有 applyOcrBboxOverride 不同：row anchor 是 **full replacement**、
 * 不做 narrow / x-shift 判斷、信任 OCR 鎖的 bbox。
 */
export function applyRowAnchorOverride(alignedQuestions, candidatesByQid) {
  const overrides = []
  const out = alignedQuestions.map(q => {
    const cand = candidatesByQid[q.questionId]
    if (!cand || !q.visible) return q
    overrides.push({
      qid: q.questionId,
      before: q.answerBbox,
      after: cand,
      method: 'row_anchor_full_replace'
    })
    return { ...q, answerBbox: cand }
  })
  return { alignedQuestions: out, overrides }
}
// force redeploy 2026-05-15
