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
 * Post-classify override：當 classify 對 inline 題目輸出的 bbox 異常窄 → 補救；其他情況保留 classify。
 *
 * 設計演進（2026-05-07 第二輪）：
 *
 * v1（已棄用）：narrow OR xshift 觸發 → REPLACE 用 OCR row
 *   問題：xshift 把 classify 對的 bbox（在答案區、右邊）拉回印刷字區（左邊）；
 *         REPLACE 把 classify 多行 h（如 0.062）砍成 OCR row 單行 h（0.021）。
 *   實證 4 號 1-1-14：classify 給 (x=0.292, h=0.062) 看到學生跨行、被 override 蓋成 (x=0.115, h=0.021)。
 *
 * v2（本版）：
 *   - 移除 xshift trigger（classify 在答案區屬正常、不該拉回印刷字區）
 *   - 加 yDrift 偵測：classify y center 跟 OCR row 差距 > yDriftThreshold → 認為 classify 飄到別行
 *   - narrow + 同行 → UNION（保留 classify y/h，x 取 classify 跟 padded candidate 聯集）
 *   - yDrift（不同行）→ REPLACE 用 OCR row（保險、避免 classify 飄到鄰題）
 *   - 不 narrow 且同行 → 不動 classify
 *
 * v3（2026-05-07 第三輪）：
 *   - 加 xDrift skip guard：classify 跟 OCR candidate x 中心差 > xDriftSkipThreshold（預設 0.3）→ 跨欄誤匹配
 *   - 跨欄訊號：matcher 純文字配對，遇短文字「1.湛蓝」OCR row 在右欄、classify 正確左欄
 *     → yDrift trigger 把 classify 0.218 換成 OCR 0.898（推到右欄）
 *   - 此時相信 classify、不 override
 *   - 實證 4 號 1-1-1/2/4：classify x=0.218/0.215/0.279 vs OCR x=0.898/0.901/0.916（跳欄）
 *
 * @param {Object} opts - { xPadFraction, yPadFraction, minWidthRatio, yDriftThreshold, xDriftSkipThreshold }
 * @returns {Object} { alignedQuestions, overrides: [{questionId, before, after, reason}] }
 */
export function applyOcrBboxOverride(alignedQuestions, candidatesByQid, imageSize, opts = {}) {
  // 🆕 Kill switch（2026-05-07）：default OFF，回到純粹 classify+OCR HINT 狀態方便微調 prompt。
  // 設 OCR_BBOX_OVERRIDE_ENABLED=true 才啟用 override（保留 v3 邏輯供日後測試）。
  if (process.env.OCR_BBOX_OVERRIDE_ENABLED !== 'true') {
    return { alignedQuestions: alignedQuestions || [], overrides: [] }
  }
  const xPad = typeof opts.xPadFraction === 'number' ? opts.xPadFraction : 0.04
  const yPad = typeof opts.yPadFraction === 'number' ? opts.yPadFraction : 0
  const minWidthRatio = typeof opts.minWidthRatio === 'number' ? opts.minWidthRatio : 0.5
  const yDriftThreshold = typeof opts.yDriftThreshold === 'number' ? opts.yDriftThreshold : 0.05
  const xDriftSkipThreshold = typeof opts.xDriftSkipThreshold === 'number' ? opts.xDriftSkipThreshold : 0.3
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
    const aiXCenter = aiX + aiW / 2
    const aiYCenter = aiY + aiH / 2
    const candXCenter = candX + candW / 2
    const candYCenter = candY + candH / 2

    // v3 guard：x 中心差太遠（>0.3 of image width）→ matcher 大概率挑到別欄 row
    // 此時 trust classify（classify 看整張圖判斷比 matcher 純文字穩）、不 override
    const xDriftAbs = Math.abs(aiXCenter - candXCenter)
    if (xDriftAbs > xDriftSkipThreshold) {
      overrides.push({
        questionId: q.questionId,
        before: { x: +aiX.toFixed(3), y: +aiY.toFixed(3), w: +aiW.toFixed(3), h: +aiH.toFixed(3) },
        after: null,
        reason: 'skip_xdrift_cross_column',
        xDriftAbs: +xDriftAbs.toFixed(3)
      })
      return q
    }

    const tooNarrow = aiW < candW * minWidthRatio
    const yDrift = Math.abs(aiYCenter - candYCenter) > yDriftThreshold

    let reason = null
    let newBbox = null

    if (yDrift) {
      // Classify y 跟 OCR row 差太遠 → classify 飄到別行 → REPLACE 用 OCR row
      const newX = Math.max(0, candX - xPad)
      const newY = Math.max(0, candY - yPad)
      const newW = Math.min(1 - newX, candW + 2 * xPad)
      const newH = Math.min(1 - newY, candH + 2 * yPad)
      newBbox = { x: +newX.toFixed(3), y: +newY.toFixed(3), w: +newW.toFixed(3), h: +newH.toFixed(3) }
      reason = 'replace_ydrift'
    } else if (tooNarrow) {
      // 同行 + classify 縮太窄 → UNION（x 聯集、y/h 保留 classify）
      const unionX = Math.max(0, Math.min(aiX, candX - xPad))
      const unionRight = Math.max(aiX + aiW, candX + candW + xPad)
      const unionW = Math.min(1 - unionX, unionRight - unionX)
      newBbox = {
        x: +unionX.toFixed(3),
        y: +aiY.toFixed(3),
        w: +unionW.toFixed(3),
        h: +aiH.toFixed(3)
      }
      reason = 'union_narrow'
    } else {
      // 同行 + 寬度合理 → 不動 classify
      return q
    }

    overrides.push({
      questionId: q.questionId,
      before: { x: +aiX.toFixed(3), y: +aiY.toFixed(3), w: +aiW.toFixed(3), h: +aiH.toFixed(3) },
      after: newBbox,
      reason
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
 */
export function buildOcrHintsSection(candidatesByQid, imageSize) {
  const entries = Object.entries(candidatesByQid || {}).filter(([, cands]) => cands && cands.length > 0)
  if (entries.length === 0) return ''
  const [imgW, imgH] = imageSize || [1, 1]
  const lines = ['', '═══ OCR HINTS ═══', '']
  lines.push('OCR 對學生作業圖偵測到的印刷文字行位置（normalized 座標），依 anchorHint 配對到下列題目：')
  lines.push('')
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
  return lines.join('\n')
}
