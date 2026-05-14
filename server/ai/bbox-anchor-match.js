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
 * 採 greedy unique assignment：
 *   1. 算所有 (qid, ocrIdx, score) 上門檻的 pairs
 *   2. 依 score 由高到低排序
 *   3. 由高分往下逐一指派、若 qid 或 ocrIdx 已被指派就跳過
 *   4. 結果：每題最多 1 條 OCR row、每條 OCR row 最多被 1 題綁
 *
 * 解決多題共用 bbox 問題（如國語注釋 1-1-4 vs 1-1-5 都配到 row 5 的情況）。
 *
 * @param {Array} answerKeyQuestions - answerKey.questions
 * @param {Array} ocrDetections - OCR /ocr endpoint 回傳的 detections
 * @param {Object} opts - { minScore, minLcs, inlineTypes }
 * @returns {Object} { candidatesByQid, stats }
 *   candidatesByQid: { qid → [{idx, text, bbox, score}] }（每題最多 1 entry）
 */
export function buildAnchorCandidates(answerKeyQuestions, ocrDetections, opts = {}) {
  const inlineTypes = opts.inlineTypes || INLINE_ANSWER_TYPES
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : 0.4
  const minLcs = typeof opts.minLcs === 'number' ? opts.minLcs : 3

  // Step 1：計算所有 (qid, ocrIdx, score) pair
  const allPairs = []
  let inlineCount = 0
  let collisions = 0
  for (const q of answerKeyQuestions || []) {
    const qid = q?.id
    if (!qid) continue
    if (!inlineTypes.has(q.questionCategory)) continue
    inlineCount++
    const phrases = extractSearchPhrases(q.anchorHint)
    if (phrases.length === 0) continue
    let pairsForThisQ = 0
    for (let i = 0; i < (ocrDetections || []).length; i++) {
      const text = normalize(ocrDetections[i].rec_text || '')
      let bestForPair = 0
      for (const phrase of phrases) {
        const np = normalize(phrase)
        if (np.length < 3) continue
        const lcs = lcsLength(text, np)
        if (lcs < minLcs) continue
        const dice = (2 * lcs) / (np.length + text.length)
        if (dice > bestForPair) bestForPair = dice
      }
      if (bestForPair >= minScore) {
        allPairs.push({ qid, ocrIdx: i, score: bestForPair, ocrItem: ocrDetections[i] })
        pairsForThisQ++
      }
    }
    if (pairsForThisQ > 1) collisions++
  }

  // Step 2：greedy 指派 — 每 qid + 每 ocrIdx 只用一次
  allPairs.sort((a, b) => b.score - a.score)
  const usedQids = new Set()
  const usedRows = new Set()
  const candidatesByQid = {}
  const lostToCollision = []  // qid 因 row 已被高分搶先而沒拿到 → audit
  for (const p of allPairs) {
    if (usedQids.has(p.qid)) continue
    if (usedRows.has(p.ocrIdx)) {
      lostToCollision.push({ qid: p.qid, ocrIdx: p.ocrIdx, score: +p.score.toFixed(3) })
      continue
    }
    candidatesByQid[p.qid] = [{
      idx: p.ocrIdx,
      text: p.ocrItem.rec_text,
      bbox: p.ocrItem.bbox,
      score: p.score
    }]
    usedQids.add(p.qid)
    usedRows.add(p.ocrIdx)
  }

  return {
    candidatesByQid,
    stats: {
      totalQuestions: (answerKeyQuestions || []).length,
      inlineCount,
      matchedCount: Object.keys(candidatesByQid).length,
      matchRate: inlineCount ? Object.keys(candidatesByQid).length / inlineCount : 0,
      assignmentMethod: 'greedy_unique',
      collisionsResolved: lostToCollision.length,
      collisionSamples: lostToCollision.slice(0, 5)
    }
  }
}

/**
 * Post-classify bbox 修正（2026-05-07 width-floor + x-shift 雙規則）。
 *
 * 兩條規則依序套用：
 *
 * **規則 1：width-floor**
 *   classify.w < OCR.w × `minWidthRatio` (0.5) → UNION x 拉寬到 OCR row 範圍
 *   解：classify 把答案框得太窄、read 切到答案
 *
 * **規則 2：x-shift（uniform 左移）**
 *   有 OCR 配對的題目均勻左移 `xShift` (default 0.010)、保留右邊界（w 自動補回）
 *   下限 = OCR.x（不會跑到題號起點之前）
 *   解：「冒號後接空白」格式 ±0.01 視覺判定誤差導致字頭被切的系統性偏移
 *   實證 1 號 1-1-6/9 / 4 號 1-1-9 / 5 號 1-1-10 等 cls.x 偏右案例
 *
 * **y-alignment guard**：classify y 中心與 OCR row y 中心差 > `yAlignThreshold` (0.04) → 兩條規則都跳過
 *   → 自動排除跨欄誤匹配（如 4 號 1-1-1/2/4 anchor 配到右欄 row）
 *
 * **width-floor 已觸發時 x-shift 自動 no-op**：因為 width-floor 已把 x 拉到 OCR.x、
 *   x-shift 下限就是 OCR.x、不會再動。
 *
 * @param {Object} opts - { minWidthRatio, yAlignThreshold, xShift }
 * @returns {Object} { alignedQuestions, overrides: [{questionId, before, after, reason}] }
 */
export function applyOcrBboxOverride(alignedQuestions, candidatesByQid, imageSize, opts = {}) {
  const minWidthRatio = typeof opts.minWidthRatio === 'number' ? opts.minWidthRatio : 0.5
  const yAlignThreshold = typeof opts.yAlignThreshold === 'number' ? opts.yAlignThreshold : 0.04
  const xShift = typeof opts.xShift === 'number'
    ? opts.xShift
    : parseFloat(process.env.OCR_BBOX_X_SHIFT ?? '0.010')
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
    const aiY = q.answerBbox.y
    const aiW = q.answerBbox.w
    const aiH = q.answerBbox.h
    const aiYCenter = aiY + aiH / 2
    const candYCenter = candY + candH / 2

    if (Math.abs(aiYCenter - candYCenter) > yAlignThreshold) return q

    let workingX = aiX
    let workingW = aiW
    const appliedRules = []
    const auditMeta = {}

    // 規則 1：width-floor（UNION x 到 OCR row 範圍）
    const minRequiredW = candW * minWidthRatio
    if (workingW < minRequiredW) {
      const unionX = Math.max(0, Math.min(workingX, candX))
      const unionRight = Math.max(workingX + workingW, candX + candW)
      workingX = unionX
      workingW = Math.min(1 - unionX, unionRight - unionX)
      appliedRules.push('width_floor')
      auditMeta.ocrW = +candW.toFixed(3)
      auditMeta.minRequiredW = +minRequiredW.toFixed(3)
    }

    // 規則 2：x-shift（左移 + 保留右邊界）
    if (xShift > 0) {
      const shiftedX = Math.max(candX, workingX - xShift)
      if (shiftedX < workingX) {
        const rightEdge = workingX + workingW
        workingW = rightEdge - shiftedX
        workingX = shiftedX
        appliedRules.push('x_shift')
        auditMeta.xShiftAmount = +(aiX - shiftedX).toFixed(3)
      }
    }

    if (appliedRules.length === 0) return q

    const newBbox = {
      x: +workingX.toFixed(3),
      y: +aiY.toFixed(3),
      w: +Math.min(1 - workingX, workingW).toFixed(3),
      h: +aiH.toFixed(3)
    }
    overrides.push({
      questionId: q.questionId,
      before: { x: +aiX.toFixed(3), y: +aiY.toFixed(3), w: +aiW.toFixed(3), h: +aiH.toFixed(3) },
      after: newBbox,
      reason: appliedRules.join('+'),
      ...auditMeta
    })
    return { ...q, answerBbox: newBbox, bboxOverriddenByOcr: true }
  })

  return { alignedQuestions: out, overrides }
}

/**
 * 把 candidates 渲染成 prompt 可注入的「OCR HINTS」section 字串。
 * 若沒任何 candidate 回空字串。
 *
 * 2026-05-07 簡化：移除所有 padding 邏輯與使用建議。bbox 給原始 OCR normalized 座標，
 * 不附任何 padding 或修改建議，讓 classify 純粹依 TYPE RULE 自行判斷答題框。
 *
 * 2026-05-14 按 score 分兩組描述：
 *   - score >= 1.0 (cell_anchor / single_choice / sub_cell exact): bbox 是「精確答案 cell 邊界」
 *     prompt 要求 classify 直接採用、不擴張
 *   - score < 1.0 (LCS+Dice 文字配對 / sub_cell loose): bbox 是「印刷文字行位置」
 *     prompt 維持「僅供參考、依 TYPE RULE 自行判斷」
 */
function renderHintBlock(entries, imgW, imgH) {
  const lines = []
  for (const [qid, cands] of entries) {
    lines.push(`Q ${qid}:`)
    cands.forEach((c, i) => {
      const [x1, y1, x2, y2] = c.bbox
      const nb = {
        x: +(x1 / imgW).toFixed(3),
        y: +(y1 / imgH).toFixed(3),
        w: +((x2 - x1) / imgW).toFixed(3),
        h: +((y2 - y1) / imgH).toFixed(3)
      }
      lines.push(`  c${i + 1} text="${(c.text || '').slice(0, 40)}" bbox=${JSON.stringify(nb)}`)
    })
  }
  return lines
}

export function buildOcrHintsSection(candidatesByQid, imageSize) {
  const entries = Object.entries(candidatesByQid || {}).filter(([, cands]) => cands && cands.length > 0)
  if (entries.length === 0) return ''
  const [imgW, imgH] = imageSize || [1, 1]

  const deterministic = entries.filter(([, cands]) => (cands[0]?.score ?? 0) >= 1.0)
  const heuristic = entries.filter(([, cands]) => (cands[0]?.score ?? 0) < 1.0)

  const lines = ['', '═══ OCR HINTS ═══', '']

  if (deterministic.length > 0) {
    lines.push('【精確答案 cell 邊界】（OCR 結構分析、deterministic、由印刷編號+section header 算出）：')
    lines.push('以下 bbox 是各題答案 cell 的精確邊界。請【直接採用此 bbox】、**不要**自行擴張 y/h/x/w 或往題目印刷區延伸。bbox 已排除題號跟題目文字、只含學生答案區。')
    lines.push('')
    lines.push(...renderHintBlock(deterministic, imgW, imgH))
    if (heuristic.length > 0) lines.push('')
  }

  if (heuristic.length > 0) {
    lines.push('【印刷文字行位置】（OCR+文字配對、僅供參考）：')
    lines.push('以下是 OCR 偵測到的印刷文字行位置（normalized 座標）、答案區可能在文字附近。請依 TYPE RULE 自行判斷答題框。')
    lines.push('')
    lines.push(...renderHintBlock(heuristic, imgW, imgH))
  }

  return lines.join('\n')
}
