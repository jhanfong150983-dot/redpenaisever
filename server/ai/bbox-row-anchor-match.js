/**
 * bbox-row-anchor-match.js — v5 統一規則（2026-05-16）
 *
 * OCR-based question row anchoring for single_choice / multi_choice / true_false questions.
 *
 * 設計目標：解 classify Gemini 對「N.(  )」結構視覺判斷不穩的問題、
 * 改用 PaddleOCR 找印刷的「N.」題號 row、derive 答題格 bbox。
 *
 * 適用範圍：
 *   1. 題目都是 single_choice / multi_choice / true_false（OR 混合卷的這幾種題型）
 *   2. 圖像寬 ≥ 1000 px（低解析度 OCR 偵測率不足）
 *
 * v5 支援格式（不需 paper-specific 分流）：
 *   - 純 single_choice 自然測試風（單欄、連續編號、N.(  )）
 *   - 混 single_choice + 填空 社會風（題組+雙欄+(  )N. 格式）
 *   - 混 single_choice + 計算 數學風（雙欄+(  )N.+選項算式干擾）
 *
 * Algorithm（per-group flow）：
 *   Pass 1A：Pattern A/B/E 文字匹配 + column x 過濾
 *           A: ^N.<任意>      B: ^(...)N.<非數字>      E: ^X)N.<非數字>（OCR 漏抓 "("）
 *   Pass 1B：「N」純數字 + 鄰近 paren detection 配對
 *   Pass 1D：「)N.」+ 左側 paren detection 配對（split-paren 救援）
 *   Pass 1C：page-edge 寬 row 補抓（option/stem 過濾：含 ? 留、(A-D) 無 ? 拒）
 *   Pass 2 ：線性內插（option marker ①②③④❶❷❸❹ 拒）
 *   column-consistency：outlier N < 主欄 min N → 刪
 *   paper format inference：format=B 卷子的 A row → B_PARTIAL（cell 放 N. 左邊）
 *
 * Test：local-only/row_anchor_v2/ 下、3 paper × 3 sub = 9 卷子實證 176/177 SC matched、
 *      AI 驗證 166/176 BRACKET_WITH_ANSWER (94.3%)、10 false positives 視覺驗證 bbox 實際正確、
 *      0 真實 wrong-row。
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
  // v1 放寬：不再因「題組」hint skip
  // Pass 1A 用「N.」pattern + column 過濾、就算題組混排也能抓到答題格
  // 風險靠 Pass 1C distinctness check + N 跨欄一致性檢查降低
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
  // v2 支援兩種格式：
  //   A. 「N.(...)」自然測試格式（題號後接 paren、學生答案在 paren 內）
  //   B. 「(...)N.」社會卷格式（paren 前綴是答題格、N. 後跟題目文字）
  // 兩種都用「N」當 row anchor、但 cell 位置截然不同：
  //   A：cell 在 N. 之後的 (...) 內
  //   B：cell 在 N. 之前的 (...) 內
  // _format 標記交給 deriveCellBbox 處理
  // v5：Pattern B 加 (?!\d) 防誤抓「(4)1.6x」之類選項算式（period 後跟非數字）
  //   Pattern A 不加：自然測試 N.(  )答案 格式、OCR 可能讀成「11.2」（學生寫 2 在 paren）
  //   "(4)1.6x" 的 wrong-row 風險 Pattern A 不存在（因為以「(」開頭、不會走 A）
  //   Pattern E：OCR 漏抓「(」、變「4)1.有關...」格式、抽 N=1（解 social sub2 1-2-1）
  const PATTERN_A = /^(\d{1,2})\s*[.．]/                                          // N. 開頭
  const PATTERN_B = /^[（(]([^）)]{0,4})[）)]\s*(\d{1,2})\s*[.．](?!\d)/          // (...)N.<非數字>
  const PATTERN_E = /^([A-Za-z0-9])\s*[）)]\s*(\d{1,2})\s*[.．](?!\d)/            // X)N.<非數字>（OCR 漏抓 "("）

  for (const d of detections) {
    const t = String(d.rec_text || '').trim()
    if ((d.rec_score || 0) < MIN_OCR_SCORE) continue
    const x = d.bbox[0]
    if (!((x < COL_X_LEFT_MAX) || (x >= COL_X_RIGHT_MIN && x < COL_X_RIGHT_MAX))) continue

    let n = null
    let format = null
    const mA = t.match(PATTERN_A)
    const mB = t.match(PATTERN_B)
    const mE = t.match(PATTERN_E)
    if (mB) {
      n = parseInt(mB[2]); format = 'B'
    } else if (mE) {
      // OCR 漏抓「(」、把 row 視為 B 格式（cell 在 N. 左邊）
      n = parseInt(mE[2]); format = 'B'
    } else if (mA) {
      n = parseInt(mA[1]); format = 'A'
    }
    if (n === null || n < 1 || n > 99) continue

    const hasParen = /[（(]/.test(t)
    const cur = byN.get(n)
    const curHasParen = cur ? /[（(]/.test(cur.rec_text) : false
    const better = !cur
      || (hasParen && !curHasParen)
      || (hasParen === curHasParen && d.rec_score > (cur.rec_score || 0))
    if (better) byN.set(n, { ...d, _format: format })
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

// ── Pass 1D：split-paren 救援 ─────────────────────────────────
//
// 解決：OCR 把「( )N. 題目文字」拆成 2 個 detection：
//   - 「( )」: 完整 paren
//   - 「)N. 題目文字」: 開頭有殘留的 ")"
// Pattern A/B/Pass 1B 都不認、需獨立救援。
// 例：math sub2 page 2 Q5
//   x=59 y=1245 "( )"
//   x=125 y=1248 ")5.小關用20個周長..."
//
// 策略：找開頭 `)N.<非數字>` 的 detection、配左側 60-90px 內的「(...」detection、
// 合成 row、_format='B'、_parenBbox 用左側 paren detection 的 bbox

function pass1dSplitParenRescue(detections, applicableNs, byN) {
  const LEADING_CLOSE_PAREN_N = /^[）)]\s*(\d{1,2})\s*[.．](?!\d)/
  const OPEN_PAREN_RE = /^[（(]/
  const X_DIST_MAX = 90  // 左側 paren 到 ")N." 的 x 距離（左 paren 右邊 -> ")N." 左邊）
  const Y_CENTER_MAX_DIST = 20

  for (const d of detections) {
    const t = String(d.rec_text || '').trim()
    const m = t.match(LEADING_CLOSE_PAREN_N)
    if (!m) continue
    const n = parseInt(m[1])
    if (n < 1 || n > 99) continue
    if (!applicableNs.includes(n)) continue
    if (byN.has(n)) continue
    if ((d.rec_score || 0) < MIN_OCR_SCORE) continue
    const x = d.bbox[0]
    if (!((x < COL_X_LEFT_MAX) || (x >= COL_X_RIGHT_MIN && x < COL_X_RIGHT_MAX))) continue

    // 找左側 paren detection（x 在 d.bbox[0] 之前、close 即可）
    const dYCenter = (d.bbox[1] + d.bbox[3]) / 2
    let bestParen = null
    let bestDist = Infinity
    for (const p of detections) {
      if (p === d) continue
      const pt = String(p.rec_text || '').trim()
      if (!OPEN_PAREN_RE.test(pt)) continue
      // p 在 d 左邊
      const xDist = d.bbox[0] - p.bbox[2]  // d.left - p.right
      if (xDist < -10 || xDist > X_DIST_MAX) continue
      const pYCenter = (p.bbox[1] + p.bbox[3]) / 2
      if (Math.abs(pYCenter - dYCenter) > Y_CENTER_MAX_DIST) continue
      if (xDist < bestDist) { bestDist = xDist; bestParen = p }
    }
    if (bestParen) {
      // 合成 row：x1 從 paren、x2 到 ")N..." 的右側、_format='B'、用左 paren 當 _parenBbox
      byN.set(n, {
        bbox: [bestParen.bbox[0], Math.min(bestParen.bbox[1], d.bbox[1]), d.bbox[2], Math.max(bestParen.bbox[3], d.bbox[3])],
        rec_text: `${bestParen.rec_text.trim()}${n}.`,
        rec_score: Math.min(d.rec_score, bestParen.rec_score),
        _pass1d: true,
        _format: 'B',
        _parenBbox: bestParen.bbox
      })
    } else {
      // 無左 paren detection、估計：cell 在 d 左邊 ~50 px 寬
      // social sub1 的 ")2.有關人民..." OCR 漏抓 "(" detection、但 "(" 仍在紙上 d.bbox[0] 左邊
      const ESTIMATED_PAREN_W = 50
      const cellX1 = Math.max(0, d.bbox[0] - ESTIMATED_PAREN_W)
      const cellX2 = d.bbox[0] + 8  // 含住 ")" 本身
      byN.set(n, {
        bbox: [cellX1, d.bbox[1], d.bbox[2], d.bbox[3]],
        rec_text: `( )${n}.${t.slice(m[0].length)}`,
        rec_score: d.rec_score * 0.8,  // 降一點 score 表示估計
        _pass1d: true,
        _format: 'B',
        _parenBbox: [cellX1, d.bbox[1], cellX2, d.bbox[3]]
      })
    }
  }
}

// ── Pass 1C：page-edge 幾何 row 補抓（無 text 也救）────────────
//
// 解決：jpeg OCR 在 page 第一題 (e.g. Q11、page 2 top) 上經常 text 全爛、
// 連 Pass 1A/1B 都救不到、但 OCR 仍偵測到 row 形狀（wide bbox 在 column 內）。
// 6 種失敗 mode 都有 row-shape detection 在 y=~120 column 內：
//   - empty text (score=0)：seat 4, 15, 24
//   - 只「（）」：seat 22
//   - 只「）」：seat 25
//   - 「II」（OCR 把 11 看錯）+ wide right neighbor：seat 28
//
// 策略：
// 1. 對每 column (left/right) 的最上 missing N、找最上 row-shape detection
// 2. 同 y 鄰近 detections 合併成完整 row bbox（解 seat 28 的拆段問題）
// 3. deriveCellBbox 走 no-paren fallback、用 nDigits 推 cell offset
// 也處理 page 底部 missing 對稱情況。

function pass1cPageEdgeAnchor(detections, applicableNs, byN, imgH) {
  const sortedNs = [...applicableNs].sort((a, b) => a - b)

  // 依已 matched N 推 column 分組
  const cols = {
    left: { xMin: 0, xMax: COL_X_LEFT_MAX, ns: [] },
    right: { xMin: COL_X_RIGHT_MIN, xMax: COL_X_RIGHT_MAX, ns: [] }
  }
  for (const n of sortedNs) {
    if (!byN.has(n)) continue
    const x = byN.get(n).bbox[0]
    cols[x < 400 ? 'left' : 'right'].ns.push(n)
  }
  // 缺的 N 用相鄰 matched 推 column
  for (const n of sortedNs) {
    if (byN.has(n)) continue
    let closest = null, closestDist = Infinity
    for (const m of sortedNs) {
      if (!byN.has(m)) continue
      const d = Math.abs(m - n)
      if (d < closestDist) { closestDist = d; closest = m }
    }
    if (closest != null) {
      const x = byN.get(closest).bbox[0]
      cols[x < 400 ? 'left' : 'right'].ns.push(n)
    }
  }

  for (const colName of ['left', 'right']) {
    const col = cols[colName]
    if (col.ns.length === 0) continue
    const colNs = [...col.ns].sort((a, b) => a - b)

    // 上邊：找 top-most missing N（沒 matched N 在它之前）
    for (let i = 0; i < colNs.length; i++) {
      const n = colNs[i]
      if (byN.has(n)) break
      const matchedAfter = colNs.slice(i + 1).filter(m => byN.has(m))
      const yMax = matchedAfter.length > 0 ? byN.get(matchedAfter[0]).bbox[1] - 30 : 400
      const yMin = 50
      tryEdgeAnchor(detections, n, col.xMin, col.xMax, yMin, yMax, 'top', byN)
      if (!byN.has(n)) break  // 找不到、停止往下試
    }
    // 下邊：找 bottom-most missing N
    for (let i = colNs.length - 1; i >= 0; i--) {
      const n = colNs[i]
      if (byN.has(n)) break
      const matchedBefore = colNs.slice(0, i).filter(m => byN.has(m))
      const yMin = matchedBefore.length > 0 ? byN.get(matchedBefore[matchedBefore.length - 1]).bbox[3] + 30 : imgH - 400
      const yMax = imgH - 50
      tryEdgeAnchor(detections, n, col.xMin, col.xMax, yMin, yMax, 'bottom', byN)
      if (!byN.has(n)) break
    }
  }
}

function tryEdgeAnchor(detections, n, colXMin, colXMax, yMin, yMax, edge, byN) {
  // v5 reject filter：明顯是選項或題幹的 row
  // 選項標記：(A)/(B)/(C)/(D) 後接數字、運算符、單位等（math/英文選項）
  // 題幹/section header：開頭是中文字（非 paren / 非數字）
  // 注意：「(A)請問下列...」是學生在 Q1 答題格寫了 A、後接題幹中文、要保留當 Q1 anchor
  const isOptionOrStem = (t, w = 9999) => {
    if (!t) return false
    const s = String(t).trim()
    // 含問號（？或?）→ 是 question header（即使開頭是 "(A)" 也不 reject）
    // 解 math sub1 Q1 "(A )請問下列哪一算式不成立？" 必須保留當 Q1 anchor
    const hasQMark = /[?？]/.test(s)
    // (A)/(B)/(C)/(D) 開頭、且不含 "?" → 選項標記（無論寬度）
    if (!hasQMark && /^[（(]\s*[A-DＡ-Ｄa-dａ-ｄ]\s*[）)]/.test(s)) return true
    // (字母)+數字/運算 → 選項（其他字母）
    if (/^[（(][A-Za-zＡ-Ｚａ-ｚ]\s*[）)]\s*[\d.+\-×÷=．]/.test(s)) return true
    // 開頭中文字 → section header / 題幹
    if (/^[一-鿿]/.test(s)) return true
    return false
  }

  // Find row-shape detection in col x range, in y range, width > 250
  const cands = detections.filter(d => {
    if (d.bbox[0] < colXMin || d.bbox[0] >= colXMax) return false
    if (d.bbox[1] < yMin || d.bbox[1] > yMax) return false
    const w = d.bbox[2] - d.bbox[0]
    if (w <= 250) return false
    // v5: 過濾明顯不是 question header 的 row（傳 row width 區分長短）
    if (isOptionOrStem(d.rec_text, w)) return false
    return true
  })
  if (cands.length === 0) return

  cands.sort((a, b) => edge === 'top' ? a.bbox[1] - b.bbox[1] : b.bbox[1] - a.bbox[1])

  // v1 distinctness check：candidate 不能跟 byN 已 set 的 cell y center 太近
  // 之前 4 個 missing N 都找同一個 top row、塞同一 cell 給 4 個 N、bug 來源
  const existingYCenters = []
  for (const [, row] of byN) {
    existingYCenters.push((row.bbox[1] + row.bbox[3]) / 2)
  }
  const MIN_Y_DISTANCE = 30  // 不同 row 至少差 30 px

  let best = null
  for (const cand of cands) {
    const yCenter = (cand.bbox[1] + cand.bbox[3]) / 2
    const tooClose = existingYCenters.some(y => Math.abs(y - yCenter) < MIN_Y_DISTANCE)
    if (tooClose) continue
    best = cand
    break
  }
  if (!best) return  // 所有 candidates 都跟 existing 重疊、放棄

  // 合併同 y (±20) 內、x 端可能在 column 內或往右延伸的鄰近 detections
  const yCenter = (best.bbox[1] + best.bbox[3]) / 2
  const sameY = detections.filter(d => {
    const yc = (d.bbox[1] + d.bbox[3]) / 2
    if (Math.abs(yc - yCenter) > 20) return false
    // 必須有部分在 column 開始位置之後（避免抓到完全不相關的右邊欄 detection）
    return d.bbox[0] < 700  // 大致排除右邊欄（如果這是 left col case）、雙欄都不會誤抓
  })

  const x1 = Math.min(...sameY.map(d => d.bbox[0]))
  const y1 = Math.min(...sameY.map(d => d.bbox[1]))
  const x2 = Math.max(...sameY.map(d => d.bbox[2]))
  const y2 = Math.max(...sameY.map(d => d.bbox[3]))

  byN.set(n, {
    bbox: [x1, y1, x2, y2],
    rec_text: '',
    rec_score: 0.5,
    _pass1c: true,
    _edge: edge
  })
}

// ── Pass 2：y 內插補漏 ────────────────────────────────────────

/**
 * 對 applicableQids 內缺的 N、用 Pass 1 結果預測 y、找該位置的 OCR detection
 */
function pass2InterpolateMissing(byN, allDetections, applicableNs, cellByN_px = new Map()) {
  // v5: option marker reject — Pass 2 不可挑到選項標記 row（①②③④❶❷❸❹、(1)(2)）
  const isOptionRow = (t) => {
    const s = String(t || '').trim()
    if (!s) return false
    // ①②③④⑤ U+2460-U+2464、⓪⓵-⓽ U+24EA, U+24F5-、❶❷❸❹❺ U+2776-、㊀-㊉
    if (/^[①-⑳⓪⓵-⓿❶-❿㈠-㈩]/.test(s)) return true
    // 數字 + 圈號或方塊起頭：option enumerator like 0/1/2/3 followed by Chinese content
    if (/^\d[^.．\d]/.test(s) && /[一-鿿]/.test(s)) return true
    return false
  }
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
      // v5: 排除 option marker row（避免內插落到 ①②③④ option 行）
      const candidates = allDetections.filter(d =>
        Math.abs(d.bbox[1] - predY) < Y_INTERPOLATION_TOLERANCE
        && d.bbox[0] >= sec.colXMin
        && d.bbox[0] < sec.colXMax
        && !isOptionRow(d.rec_text)
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

  // v5 B_PARTIAL: 卷子是 B 格式、但 OCR 漏抓 "(...)" 前綴、只剩 "N." 開頭
  // 估計 paren 在 N. 左邊、寬約 60px
  if (row._format === 'B_PARTIAL') {
    const ESTIMATED_PAREN_W = 70
    const cellX1 = Math.max(0, x1 - ESTIMATED_PAREN_W)
    const cellX2 = Math.min(fullW, x1 + 10)  // 含 N. 開頭一點點
    return {
      x: cellX1 / fullW,
      y: Math.max(0, y1 - padY) / fullH,
      w: (cellX2 - cellX1) / fullW,
      h: (Math.min(fullH, y2 + padY) - Math.max(0, y1 - padY)) / fullH
    }
  }

  // v2 format B: 「(...) N.」社會卷格式、cell 在 N. 前面的括號內
  if (row._format === 'B') {
    // v5: OCR 漏抓「(」、text 開頭變「X)N.」、估計「(」在 x1 左邊 ~20px
    // 整個 cell 從 (x1-25) 到 (X) 結束位置 + padding
    const eMatch = t.match(/^([A-Za-z0-9])\s*[）)]/)
    if (eMatch) {
      const parenEndChar = t.includes('）') ? '）' : ')'
      const parenEndIdx = t.indexOf(parenEndChar) + 1
      const totalW = strW(t)
      const ratioEnd = strW(t.slice(0, parenEndIdx)) / totalW
      const rowW = x2 - x1
      const cellX1 = Math.max(0, x1 - 25 - padL)  // 估「(」在 x1 左 25px、再加 padding
      const cellX2 = Math.min(fullW, x1 + ratioEnd * rowW + padR)
      const finalX2 = Math.max(cellX2, cellX1 + 95)
      return {
        x: cellX1 / fullW,
        y: Math.max(0, y1 - padY) / fullH,
        w: (Math.min(fullW, finalX2) - cellX1) / fullW,
        h: (Math.min(fullH, y2 + padY) - Math.max(0, y1 - padY)) / fullH
      }
    }
    // text 開頭應該是 "(  )N." 或 "(X)N."
    const bMatch = t.match(/^[（(]([^）)]{0,4})[）)]\s*(\d{1,2})\s*[.．]/)
    if (bMatch) {
      // paren 範圍：t 開頭到 ) 後一個位置
      const parenEndChar = t.includes('）') ? '）' : ')'
      const parenEndIdx = t.indexOf(parenEndChar) + 1
      const totalW = strW(t)
      const ratioEnd = strW(t.slice(0, parenEndIdx)) / totalW
      const rowW = x2 - x1
      // cell 從 row 開頭、到括號末尾、加 padding
      // v5: padR 從 padR/2 加大到 padR、避免「只框到 (」(社會 1-2-2 等 case)
      const cellX1 = Math.max(0, x1 - padL)
      const cellX2 = Math.min(fullW, x1 + ratioEnd * rowW + padR)
      // v5: 最小寬度保底 95px、math sub2 Q2 印刷的「(  )2.」括號約 90px 寬、加 padding 後 95 才夠
      const finalX2 = Math.max(cellX2, cellX1 + 95)
      return {
        x: cellX1 / fullW,
        y: Math.max(0, y1 - padY) / fullH,
        w: (Math.min(fullW, finalX2) - cellX1) / fullW,
        h: (Math.min(fullH, y2 + padY) - Math.max(0, y1 - padY)) / fullH
      }
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

  // v4 normalize 繁簡：OCR 常把「題組」識別成「题組」「题组」、anchorHint 是繁體「題組」
  // 不 normalize 會在 t.includes(g) 失敗 → hasGroups=false → fallback 沒分組 → 同 N 跨組 collision
  const normalize = (s) => String(s || '')
    .replace(/题/g, '題')
    .replace(/组/g, '組')
    .replace(/园/g, '園')

  // v3 group-aware：用 anchorHint 內的「題組X」名稱拆組、各組 N 獨立
  // 配 OCR section header 區分同 N 屬於哪個題組
  const groupNameByQid = new Map()
  const ZH_NUMERAL_RE = /(題組[一二三四五六七八九十百零０-９0-9]+)/
  for (const q of applicable) {
    const hint = normalize(q.anchorHint || '')
    const m = hint.match(ZH_NUMERAL_RE)
    if (m) groupNameByQid.set(q.id, m[1])
  }
  const hasGroups = groupNameByQid.size > 0 && groupNameByQid.size === applicable.length
  const groups = [...new Set(groupNameByQid.values())]

  // 找 OCR detection 含 group name 的 y 位置（section header）
  // 用來決定每個 group 的 y 範圍
  const groupYRange = new Map()  // group name -> [yMin, yMax]
  if (hasGroups) {
    const headerYs = new Map()  // group -> y center
    for (const g of groups) {
      for (const d of detections) {
        const t = normalize(d.rec_text || '').trim()
        if (t.includes(g)) {
          headerYs.set(g, d.bbox[1])
          break  // first hit
        }
      }
    }
    // 把 group 依 y 排序、每個 group 的 yMax 是下個 group 的 yMin
    const sortedGroups = [...headerYs.entries()].sort((a, b) => a[1] - b[1])
    for (let i = 0; i < sortedGroups.length; i++) {
      const [g, y] = sortedGroups[i]
      const nextY = i + 1 < sortedGroups.length ? sortedGroups[i + 1][1] : imgH
      groupYRange.set(g, [y, nextY])
    }
  }

  // 2. N → qid mapping（v3：含 group key、解決同 N 跨題組 collision）
  // structure: groupKey -> Map<N, qid>
  // groupKey: hasGroups ? groupName : '__no_group__'
  const nToQidByGroup = new Map()
  for (const q of applicable) {
    const n = extractPrintedN(q.id)
    if (n == null) continue
    const groupKey = hasGroups ? (groupNameByQid.get(q.id) || '__no_group__') : '__no_group__'
    if (!nToQidByGroup.has(groupKey)) nToQidByGroup.set(groupKey, new Map())
    nToQidByGroup.get(groupKey).set(n, q.id)
  }

  // v3 per-group loop：每個題組獨立跑 Pass 1A/1B/1C/2、detection 限制在 group 的 y 範圍
  const candidatesByQid = {}
  let matchedCount = 0
  let fallbackCount = 0
  let widthSafetyCount = 0
  let pass1aCount = 0
  let pass1bCount = 0
  let pass1cCount = 0
  let pass1dCount = 0
  let pass1bUsed = 0
  let pass1cUsed = 0
  let pass1dUsed = 0

  for (const [groupKey, nToQid] of nToQidByGroup) {
    // Filter detections by group y range（純 group flow）
    let groupDetections = detections
    if (groupKey !== '__no_group__' && groupYRange.has(groupKey)) {
      const [yMin, yMax] = groupYRange.get(groupKey)
      groupDetections = detections.filter(d => {
        const yc = (d.bbox[1] + d.bbox[3]) / 2
        return yc >= yMin && yc < yMax
      })
    }
    const groupNs = [...nToQid.keys()]

    // Pass 1A：text 開頭 "N." or "(...)N." 匹配（限於該 group detection）
    const byN = pass1FindRowsByText(groupDetections)
    const ga = byN.size

    // v5 paper format inference：統計 matched row 的 format A vs B、推論卷子整體格式
    // 解 math Q4 case：OCR 漏抓 "(A)" 只剩 "4.右圖..."、format=A、但卷子整體是 B
    // → 把這種 row 改成 _format='B_PARTIAL'、cell 放 N. 左邊（估計 paren 位置）
    let formatACount = 0, formatBCount = 0
    for (const row of byN.values()) {
      if (row._format === 'B') formatBCount++
      else if (row._format === 'A') formatACount++
    }
    const paperIsB = formatBCount > formatACount

    // v5 column-consistency reject：Pass 1A 後檢查 N 分布
    // 若某欄佔 ≥75%、outlier N 比主欄最小 N 還小 → 不合理、reject
    //   解 math sub1 case：Q1 OCR 漏抓、Pattern A 抓到右欄 N=1（section 4 的 Q1）、
    //   但主欄 Q2-Q5 都在左欄、N=1 應該 < N=2、位置應在左欄上方
    //   不刪 natural Q25 兩欄 case：右欄 N=25 > 左欄 N=21~24、合法兩欄排版
    if (byN.size >= 4) {
      const leftCnt = [...byN.values()].filter(r => r.bbox[0] < 400).length
      const rightCnt = byN.size - leftCnt
      const total = byN.size
      let outlierCol = null
      if (leftCnt / total >= 0.75) outlierCol = 'right'
      else if (rightCnt / total >= 0.75) outlierCol = 'left'
      if (outlierCol) {
        const mainNs = [...byN.entries()]
          .filter(([n, r]) => outlierCol === 'right' ? r.bbox[0] < 400 : r.bbox[0] >= 400)
          .map(([n]) => n)
        const mainMinN = Math.min(...mainNs)
        for (const [n, row] of [...byN.entries()]) {
          const inOutlier = outlierCol === 'right' ? row.bbox[0] >= 400 : row.bbox[0] < 400
          if (!inOutlier) continue
          // outlier N 小於主欄最小 N → 不合理（按 N 順序它應該在主欄前面）
          if (n < mainMinN) byN.delete(n)
        }
      }
    }

    // Pass 1B：「N」+鄰近 paren detection 配對
    pass1bFindDigitParenPairs(groupDetections, groupNs, byN)
    const gb = byN.size - ga
    // Pass 1D：「)N.」+左側 paren detection 配對（split-paren 救援）
    pass1dSplitParenRescue(groupDetections, groupNs, byN)
    const gd = byN.size - ga - gb
    // Pass 1C：page-edge 幾何 row 補抓
    pass1cPageEdgeAnchor(groupDetections, groupNs, byN, imgH)
    const gc = byN.size - ga - gb - gd

    // v5: paper format=B、把 format=A 的 row 改 B_PARTIAL（cell 放 N. 左邊）
    if (paperIsB) {
      for (const [, row] of byN) {
        if (row._format === 'A') row._format = 'B_PARTIAL'
      }
    }
    // Pass 1 cell bbox map
    const cellByN_px = new Map()
    for (const [n, row] of byN) {
      const cell = deriveCellBbox(row, n, imgW, imgH)
      if (cell) {
        cellByN_px.set(n, {
          x1: cell.x * imgW, y1: cell.y * imgH,
          x2: (cell.x + cell.w) * imgW, y2: (cell.y + cell.h) * imgH,
        })
      }
    }
    // Pass 2 interpolate
    pass2InterpolateMissing(byN, groupDetections, groupNs, cellByN_px)

    // Output per-group results
    for (const n of groupNs) {
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
      if (row._pass1c) pass1cUsed++
      if (row._pass1d) pass1dUsed++
    }
    pass1aCount += ga
    pass1bCount += gb
    pass1cCount += gc
    pass1dCount += gd
  }
  return {
    candidatesByQid,
    stats: {
      applicable: applicable.length,
      matched: matchedCount,
      matchRate: applicable.length ? +(matchedCount / applicable.length).toFixed(3) : 0,
      pass1aMatched: pass1aCount,
      pass1bMatched: pass1bCount,
      pass1cMatched: pass1cCount,
      pass1dMatched: pass1dCount,
      pass1bUsed,
      pass1cUsed,
      pass1dUsed,
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
