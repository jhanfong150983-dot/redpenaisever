/**
 * BBox Bracket Gap Match — fill_blank with「（ ）」答題區增益
 *
 * 對 fill_blank（or multi_fill / fill_variants）類含 bracket 的 anchorHint：
 *   anchorHint 例：「位於『答：多美走（ ）公尺』的括號中」
 *
 * 解 root cause：題幹和答案行可能都含「多美走」「公尺」keyword、
 * LCS+Dice 可能配到題幹 row（如「多美走路的速率是 72」）、不是答案 row（「答：多美走（  ）公尺」）。
 * classify 收到題幹 row HINT、視覺判斷飄到題幹位置 → bbox 跨卷散布大（22 份實證 17% spread）。
 *
 * 解法：找 OCR row 中「結尾『（』」+「開頭『）』」的 pair（**只有答案行才有此特徵**、題幹自動排除）、
 * gap = 兩 OCR row 中間的空白區、就是學生填答位置。
 *
 * 實證（5 份 sample）：
 *   - 1-1-1-1 多美走（ 4/5 找到 pair（多美走 row 1）
 *   - 1-1-1-2 彥凱走（ 1/5 找到 pair（OCR 對 row 2 左半偵測率不穩、需 fallback）
 *
 * Score threshold = 0.7：phrase 跟 pair 的 left+right combined 至少 dice 0.7、
 * 否則回 null（不誤配）、由 LCS fallback 接手。
 */

const FILL_TYPES = new Set(['fill_blank', 'multi_fill', 'fill_variants'])

const TRAD_TO_SIMP = {
  '彥':'彦','凱':'凯','對':'对','長':'长','說':'说','麼':'么','個':'个','幾':'几',
  '從':'从','處':'处','應':'应','會':'会','線':'线','寬':'宽','兩':'两','為':'为',
  '時':'时','與':'与','當':'当','裡':'里','裏':'里'
}

function normalize(s) {
  if (!s) return ''
  return String(s).split('').map(c => TRAD_TO_SIMP[c] || c).join('')
    .replace(/[\s，。.：:、；;？?!！「」『』（）()【】\[\]－—-]/g, '')
}

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

function dice(a, b) {
  if (!a || !b) return 0
  const n = lcsLength(a, b)
  return (2 * n) / (a.length + b.length)
}

function extractSearchPhrase(hint) {
  if (!hint) return ''
  const m = String(hint).match(/「([^」]+)」/) || String(hint).match(/『([^』]+)』/)
  if (m) return normalize(m[1])
  return normalize(hint).slice(0, 30)
}

/**
 * 找一個 fill_blank-with-bracket 題的 gap bbox
 * @returns null | { bbox: [x1,y1,x2,y2], leftRow, rightRow, score }
 */
export function findBracketGap(anchorHint, ocrDetections, opts = {}) {
  const yTolFrac = opts.yTolFrac ?? 0.6
  const minScore = opts.minScore ?? 0.7
  const phrase = extractSearchPhrase(anchorHint)
  if (!phrase || phrase.length < 3) return null

  // Step 1：left candidates — rec_text 結尾是「（」「(」
  const leftCands = []
  for (let i = 0; i < ocrDetections.length; i++) {
    const t = (ocrDetections[i].rec_text || '').trim()
    if (/[（(]\s*$/.test(t)) {
      leftCands.push({ idx: i, det: ocrDetections[i], leftCore: t.replace(/[（(]\s*$/, '') })
    }
  }
  if (leftCands.length === 0) return null

  // Step 2：對每 left、找 right candidate（同 y、右邊、開頭「）」）
  const pairs = []
  for (const L of leftCands) {
    const Lyc = (L.det.bbox[1] + L.det.bbox[3]) / 2
    const Lh = L.det.bbox[3] - L.det.bbox[1]
    const yTol = Lh * yTolFrac

    for (let j = 0; j < ocrDetections.length; j++) {
      if (j === L.idx) continue
      const Rd = ocrDetections[j]
      const Rt = (Rd.rec_text || '').trim()
      if (!/^[）)]/.test(Rt)) continue
      const Ryc = (Rd.bbox[1] + Rd.bbox[3]) / 2
      if (Math.abs(Ryc - Lyc) > yTol) continue
      if (Rd.bbox[0] <= L.det.bbox[2]) continue

      const Rcore = Rt.replace(/^[）)]\s*/, '')
      const combined = normalize(L.leftCore) + normalize(Rcore)
      const score = dice(phrase, combined)
      pairs.push({ left: L, right: { idx: j, det: Rd, rightCore: Rcore }, score })
    }
  }
  if (pairs.length === 0) return null

  pairs.sort((a, b) => b.score - a.score)
  const best = pairs[0]
  if (best.score < minScore) return null

  const Lb = best.left.det.bbox
  const Rb = best.right.det.bbox
  return {
    bbox: [Lb[2], Math.min(Lb[1], Rb[1]), Rb[0], Math.max(Lb[3], Rb[3])],
    leftRow: { idx: best.left.idx, text: (best.left.det.rec_text || '').trim() },
    rightRow: { idx: best.right.idx, text: (best.right.det.rec_text || '').trim() },
    score: +best.score.toFixed(3)
  }
}

/**
 * Main entry：對 answerKey fill_blank-with-bracket 題配 candidates。
 * Output schema 同 buildAnchorCandidates。
 *
 * 條件：
 *   - questionCategory 是 fill_blank / multi_fill / fill_variants
 *   - anchorHint 含「（」「）」字
 *
 * 配不到的題沒 candidates、由上層 LCS fallback 處理。
 */
export function buildBracketGapCandidates(answerKeyQuestions, ocrDetections, imageSize) {
  const result = {}
  const stats = {
    totalCandidates: 0,
    parsedCount: 0,
    matchedCount: 0,
    matchRate: 0,
    assignmentMethod: 'bracket_gap'
  }
  if (!Array.isArray(answerKeyQuestions) || !Array.isArray(ocrDetections)) {
    return { candidatesByQid: {}, stats }
  }

  const candidates = answerKeyQuestions.filter(q =>
    q?.questionCategory && FILL_TYPES.has(q.questionCategory) &&
    q.anchorHint && /[（(].*[）)]/.test(q.anchorHint)
  )
  stats.totalCandidates = candidates.length
  if (candidates.length === 0) return { candidatesByQid: {}, stats }

  for (const q of candidates) {
    stats.parsedCount++
    const gap = findBracketGap(q.anchorHint, ocrDetections)
    if (!gap) continue

    result[q.id] = [{
      idx: gap.leftRow.idx,
      text: `bracket-gap score=${gap.score} ${gap.leftRow.text.slice(0, 15)}/${gap.rightRow.text.slice(0, 15)}`,
      bbox: gap.bbox,
      score: gap.score
    }]
    stats.matchedCount++
  }

  stats.matchRate = stats.totalCandidates > 0 ? +(stats.matchedCount / stats.totalCandidates).toFixed(3) : 0
  return { candidatesByQid: result, stats }
}
