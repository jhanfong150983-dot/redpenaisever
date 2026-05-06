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
  lines.push(`⚠️ 重要：candidate bbox 已往外延伸 ±${(xPad*100).toFixed(0)}%（x 軸）和 ±${(yPad*100).toFixed(0)}%（y 軸），但 OCR 仍可能切到學生手寫筆跡邊緣字。`)
  lines.push('   請將 candidate 視為「最小範圍」、依 TYPE RULE 必要時再往外擴 — 寧可 bbox 略寬涵蓋整段筆跡，也不要切到字。')
  lines.push('   學生筆跡（特別是行末或冒號後的延伸）常超出 OCR 偵測邊界。')
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
