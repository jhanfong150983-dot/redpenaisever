/**
 * BBox Anchor Match — Phase A classify 增益模組
 *
 * 用 answerKey.anchorHint 文字內容 + OCR 偵測文字 fuzzy 配對，
 * 對 inline answer types（fill_blank / multi_fill / fill_variants / table_cell / single_choice）
 * 提供「該行答題位置」的 candidates，注入 classify prompt。
 *
 * 經實驗驗證（2026-05-07）：
 * - fill_blank inline 題型 100% 救援飄移 case（國語注釋 17/17、數練U5 needs_review 兩題）
 * - separated 題型（word_problem / single_check）OCR hint 無實質幫助 → 此模組僅針對 inline 啟動
 * - 配對失敗（OCR 抓不到 / anchor 太通用）→ 自動 fallback 純視覺 classify
 *
 * 使用：見 staged-grading.js 的 OCR 整合區塊
 */

// 「inline answer」題型白名單：題幹+答案在同一行 / cell 內
// → OCR 偵測到的 row 直接覆蓋答題區、可作 strong hint
export const INLINE_ANSWER_TYPES = new Set([
  'fill_blank',
  'multi_fill',
  'fill_variants',
  'table_cell',
  'single_choice'  // 注意：少數 single_choice 形式（題號旁括號）能 anchor、但題幹只描述位置時 fallback
])

// 簡化繁→簡：覆蓋常見 PaddleOCR 把繁體讀成簡體的 case
const TRAD_TO_SIMP = {
  '彥':'彦','凱':'凯','對':'对','長':'长','說':'说','麼':'么','個':'个','幾':'几',
  '從':'从','處':'处','應':'应','會':'会','線':'线','寬':'宽','兩':'两','為':'为',
  '時':'时','與':'与','當':'当','裡':'里','裏':'里','辦':'办','夠':'够','單':'单',
  '雙':'双','舊':'旧','頭':'头','紅':'红','綠':'绿','藍':'蓝','黃':'黄','電':'电',
  '臺':'台','樣':'样','張':'张','車':'车'
}

function normalize(s) {
  if (!s) return ''
  return String(s).split('').map(c => TRAD_TO_SIMP[c] || c).join('')
    .replace(/[\s，。.：:、；;？?!！「」『』（）()【】\[\]－—-]/g, '')
}

// Longest Common Substring 長度（連續匹配）
function lcsLength(a, b) {
  if (!a.length || !b.length) return 0
  let prev = new Array(b.length + 1).fill(0)
  let curr = new Array(b.length + 1).fill(0)
  let max = 0
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1
        if (curr[j] > max) max = curr[j]
      } else {
        curr[j] = 0
      }
    }
    [prev, curr] = [curr, prev]
    curr.fill(0)
  }
  return max
}

/**
 * 從 anchorHint 抽出可搜尋 phrases。
 * 優先抓「」內的具體文字；沒有時 fallback 到整段 hint 前 20 字。
 */
export function extractSearchPhrases(hint) {
  if (!hint) return []
  const phrases = []
  const m = String(hint).match(/「([^」]+)」/g)
  if (m) {
    for (const part of m) {
      let inner = part.slice(1, -1)
        .replace(/\([^)]*\)|（[^）]*）|（\s*）/g, '')
        .replace(/\s+/g, '')
      if (inner.length >= 3) phrases.push(inner)
    }
  }
  if (phrases.length === 0 && hint.length >= 4) {
    const trimmed = String(hint).replace(/[，。：、；！？]/g, '').trim()
    if (trimmed.length >= 4) {
      phrases.push(trimmed.slice(0, Math.min(20, trimmed.length)))
    }
  }
  return [...new Set(phrases)]
}

/**
 * 在 OCR detections 裡找 phrase 的 top-N 配對。
 * Score = Dice (2*LCS / (len(phrase) + len(ocr_text)))
 * 過濾 score >= minScore 才回傳。
 */
export function findTopMatches(phrases, ocrDetections, opts = {}) {
  const { topN = 3, minScore = 0.4, minLcs = 3 } = opts
  const candidates = []
  for (let i = 0; i < ocrDetections.length; i++) {
    const text = normalize(ocrDetections[i].rec_text || '')
    let bestForThis = 0
    for (const phrase of phrases) {
      const np = normalize(phrase)
      if (np.length < 3) continue
      const lcs = lcsLength(text, np)
      if (lcs < minLcs) continue
      const dice = (2 * lcs) / (np.length + text.length)
      if (dice > bestForThis) bestForThis = dice
    }
    if (bestForThis >= minScore) {
      candidates.push({
        idx: i,
        text: ocrDetections[i].rec_text,
        bbox: ocrDetections[i].bbox,
        score: bestForThis
      })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, topN)
}

/**
 * 對 answerKey 的所有 inline-type questions 找 OCR candidates。
 *
 * @param {Array} answerKeyQuestions - answerKey.questions
 * @param {Array} ocrDetections - OCR /ocr endpoint 回傳的 detections
 * @param {Object} opts - { topN, minScore, inlineTypes }
 * @returns {Object} { candidatesByQid, stats }
 *   candidatesByQid: { qid → [ {idx, text, bbox, score}, ... ] }
 *   stats: { totalQuestions, inlineCount, matchedCount }
 */
export function buildAnchorCandidates(answerKeyQuestions, ocrDetections, opts = {}) {
  const inlineTypes = opts.inlineTypes || INLINE_ANSWER_TYPES
  const candidatesByQid = {}
  let inlineCount = 0
  let matchedCount = 0

  for (const q of answerKeyQuestions || []) {
    const qid = q?.id
    if (!qid) continue
    if (!inlineTypes.has(q.questionCategory)) continue
    inlineCount++
    const phrases = extractSearchPhrases(q.anchorHint)
    if (phrases.length === 0) continue
    const matches = findTopMatches(phrases, ocrDetections || [], opts)
    if (matches.length > 0) {
      candidatesByQid[qid] = matches
      matchedCount++
    }
  }

  return {
    candidatesByQid,
    stats: {
      totalQuestions: (answerKeyQuestions || []).length,
      inlineCount,
      matchedCount,
      matchRate: inlineCount ? matchedCount / inlineCount : 0
    }
  }
}

/**
 * Post-classify override：當 classify 對 inline 題目輸出的 bbox 比 OCR candidate 窄太多（或 x 嚴重右偏）
 * → 用 padded candidate bbox 覆寫。
 *
 * 經驗（2026-05-07）：classify 在 prompt 強制規則下仍會按 TYPE RULE「冒號後接空白」公式縮到只框
 * 學生筆跡可見部分，導致老師看 review crop 時 bbox 太窄、無法判斷。
 *
 * 觸發條件（任一即覆寫）：
 * - bbox.w < candidate.w * minWidthRatio（預設 0.5、即縮到一半以下）
 * - bbox.x > candidate.x + xMisalignTolerance（預設 0.05、即 x 比 candidate.x 右偏超過 5%）
 *
 * @param {Array} alignedQuestions - classify 輸出的 [{questionId, visible, answerBbox, ...}]
 * @param {Object} candidatesByQid - { qid → [{idx, bbox, score, text}, ...] }；bbox 是 [x1,y1,x2,y2] pixel
 * @param {Array} imageSize - [imgW, imgH]
 * @param {Object} opts - { xPadFraction, yPadFraction, minWidthRatio, xMisalignTolerance }
 * @returns {Object} { alignedQuestions: 新陣列, overrides: [{questionId, before, after, reason}] }
 */
export function applyOcrBboxOverride(alignedQuestions, candidatesByQid, imageSize, opts = {}) {
  const xPad = typeof opts.xPadFraction === 'number' ? opts.xPadFraction : 0.04
  const yPad = typeof opts.yPadFraction === 'number' ? opts.yPadFraction : 0.005
  const minWidthRatio = typeof opts.minWidthRatio === 'number' ? opts.minWidthRatio : 0.5
  const xTol = typeof opts.xMisalignTolerance === 'number' ? opts.xMisalignTolerance : 0.05
  const [imgW, imgH] = imageSize || [1, 1]
  const overrides = []

  const out = (alignedQuestions || []).map((q) => {
    const cands = candidatesByQid?.[q.questionId]
    if (!cands || cands.length === 0) return q
    if (!q.answerBbox || typeof q.answerBbox.x !== 'number') return q
    const cand = cands[0]
    const candX = cand.bbox[0] / imgW
    const candY = cand.bbox[1] / imgH
    const candW = (cand.bbox[2] - cand.bbox[0]) / imgW
    const candH = (cand.bbox[3] - cand.bbox[1]) / imgH

    const aiX = q.answerBbox.x
    const aiW = q.answerBbox.w
    const tooNarrow = aiW < candW * minWidthRatio
    const xRightShifted = aiX > candX + xTol

    if (!tooNarrow && !xRightShifted) return q

    // padded candidate 覆寫
    const newX = Math.max(0, candX - xPad)
    const newY = Math.max(0, candY - yPad)
    const newW = Math.min(1 - newX, candW + 2 * xPad)
    const newH = Math.min(1 - newY, candH + 2 * yPad)
    const newBbox = { x: +newX.toFixed(3), y: +newY.toFixed(3), w: +newW.toFixed(3), h: +newH.toFixed(3) }
    overrides.push({
      questionId: q.questionId,
      before: { x: +aiX.toFixed(3), y: +q.answerBbox.y.toFixed(3), w: +aiW.toFixed(3), h: +q.answerBbox.h.toFixed(3) },
      after: newBbox,
      reason: tooNarrow && xRightShifted ? 'narrow+xshift' : (tooNarrow ? 'narrow' : 'xshift')
    })
    return { ...q, answerBbox: newBbox, bboxOverriddenByOcr: true }
  })

  return { alignedQuestions: out, overrides }
}

/**
 * 把 candidates 渲染成 prompt 可注入的「OCR HINTS」section 字串。
 * 若沒任何 candidate 回空字串（classify prompt 不會多 token）。
 *
 * @param {Object} opts
 * @param {number} opts.xPadFraction - 渲染時 x 軸延伸比例（每側）；OCR 文字邊界會收窄、學生手寫常溢出
 * @param {number} opts.yPadFraction - y 軸延伸比例（每側）
 */
export function buildOcrHintsSection(candidatesByQid, imageSize, opts = {}) {
  const entries = Object.entries(candidatesByQid || {}).filter(([, cands]) => cands && cands.length > 0)
  if (entries.length === 0) return ''
  const [imgW, imgH] = imageSize || [1, 1]
  // OCR 偵測常切到學生手寫的最邊緣字 → 渲染時往外延伸一點點當「保守的位置 anchor」
  const xPad = typeof opts.xPadFraction === 'number' ? opts.xPadFraction : 0.04
  const yPad = typeof opts.yPadFraction === 'number' ? opts.yPadFraction : 0.005
  const lines = ['', '═══ OCR HINTS (僅對 inline answer 題型提供) ═══', '']
  lines.push('我們對學生作業圖跑過 OCR、根據 anchorHint 配對到「答案就在該行內」的 candidate row。')
  lines.push('')
  lines.push('🚨 OCR HINT 使用規則（覆寫 TYPE RULE 對應 inline 題型 x 公式，y 公式不變）：')
  lines.push('')
  lines.push('  1. answerBbox.x **必須 ≤ candidate.x**（不得比 candidate 起點更靠右）')
  lines.push('  2. answerBbox.x + answerBbox.w **必須 ≥ candidate.x + candidate.w**（不得比 candidate 終點更靠左）')
  lines.push('  3. 你可以**往左/右擴**（學生筆跡常超出 OCR 偵測邊界、特別是行末延伸）')
  lines.push('  4. 你可以**自行調整 y/h**（含學生筆跡上下緣 + 完整字高）')
  lines.push('  5. 🚨 **嚴禁將 bbox 縮窄到只框「學生筆跡可見部分」** — 那會切到字尾延伸、AI1/AI2 看到不同字段、變 needs_review')
  lines.push('  6. 即使學生留空白未作答，bbox 仍維持 candidate 完整 x/w 範圍（不縮）')
  lines.push('')
  lines.push(`📐 candidate bbox 已含 ±${(xPad*100).toFixed(0)}% x padding 和 ±${(yPad*100).toFixed(0)}% y padding（即 candidate.x 已往左移 ${(xPad*100).toFixed(0)}%）。`)
  lines.push('   你輸出的 bbox 必須**完整涵蓋此 padded 範圍 + 視覺延伸**。')
  lines.push('')
  lines.push('（其他題型如 word_problem / single_check 等沒列出 hint，請走純視覺判斷）')
  lines.push('')
  for (const [qid, cands] of entries) {
    lines.push(`Q ${qid}:`)
    cands.forEach((c, i) => {
      const [x1, y1, x2, y2] = c.bbox
      // 已 pad 的 normalized bbox（左右各 +xPad、上下各 +yPad），clamp 到 [0,1]
      const px = Math.max(0, x1 / imgW - xPad)
      const py = Math.max(0, y1 / imgH - yPad)
      const pw = Math.min(1 - px, (x2 - x1) / imgW + 2 * xPad)
      const ph = Math.min(1 - py, (y2 - y1) / imgH + 2 * yPad)
      const nb = { x: +px.toFixed(3), y: +py.toFixed(3), w: +pw.toFixed(3), h: +ph.toFixed(3) }
      lines.push(`  c${i + 1} score=${c.score.toFixed(2)} text="${(c.text || '').slice(0, 40)}" bbox=${JSON.stringify(nb)} (已含 ±${(xPad*100).toFixed(0)}% padding)`)
    })
  }
  return lines.join('\n')
}
