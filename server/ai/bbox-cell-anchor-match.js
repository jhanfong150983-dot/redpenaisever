/**
 * BBox Cell Anchor Match — Phase A classify 增益模組（answer_only 專用）
 *
 * 跟 `bbox-anchor-match.js` 平行存在、output schema 一致：
 *   { candidatesByQid: { qid → [{ idx, text, bbox, score }] }, stats }
 *
 * 演算法（跟既有 LCS+Dice 不同）：
 *   1. anchorHint regex 抽 (sectionName, cellOrdinal | parent+sub)
 *      格式：「位於『一、單選題』表格第 N 格」「位於『三、非選題』第 N 大題的子格 (M)」
 *   2. OCR 偵測 section header（^[一二三四五六]、）→ 各 section 的 y 範圍
 *   3. section y 範圍內找短數字字元（1~2 位、容忍 OCR 誤讀如「9」→「g」）
 *   4. 取 y 最上方一行當「印刷編號 row」、依 x 排序
 *   5. cell x 邊界 = 相鄰 anchor 中點；首末格用 typical_w/2 buffer
 *   6. sub-cell parent 偵測：anchorHint 含「子格 (M)」→ expand parent 為 sub_count × sibling_median
 *
 * 為什麼這策略適合 answer_only：
 *   - answer_only 的 anchorHint 是純結構描述、沒可配對的具體文字 → LCS 失敗
 *   - 但 anchorHint 已經結構化、適合 regex
 *   - OCR 偵測印刷編號 row 直接給「真實 cell anchor x」、不需 frontend 等距外推
 *
 * 實證（2026-05-07 物理畢業考 29 題）：
 *   - 29/29 配對成功
 *   - Section 1 frontend 等距外推 75px 累積誤差（1-11 偏右半格）→ 完全消除
 *   - 步距 [89-99]px 反映紙張透視傾斜、OCR 抓到真實位置
 */

// 容忍 OCR 誤讀的「短數字」regex（1~2 位純數字、或單字元 g/G/q/o/O/i/I/l/L 當作 1-2 位數）
const NUMBER_LIKE = /^([0-9]{1,2}|g|G|q|o|O|i|I|l|L)$/

/**
 * 解 answer_only 模式的 anchorHint。
 * @returns null | { sectionName, type: 'cell', cellOrdinal } | { sectionName, type: 'subcell', parentOrdinal, subOrdinal }
 */
export function parseCellAnchorHint(hint) {
  if (!hint) return null
  let m = String(hint).match(/位於『([^』]+)』.*?第\s*(\d+)\s*大題的子格\s*\((\d+)\)/)
  if (m) return { sectionName: m[1], type: 'subcell', parentOrdinal: +m[2], subOrdinal: +m[3] }
  m = String(hint).match(/位於『([^』]+)』.*?第\s*(\d+)\s*格/)
  if (m) return { sectionName: m[1], type: 'cell', cellOrdinal: +m[2] }
  return null
}

/**
 * 從 OCR detections 找出 section headers（「^[一二三四五六]、X」）。
 * 同 sectionChar 多次偵測時取 y_top 最小（最上方）那一個。
 * @returns Array<{ sectionChar, sectionType, y_start, y_end, y_top, y_bot, raw }>，依 y_top 排序
 */
export function findSectionHeaders(detections, imgH) {
  const headers = []
  for (let i = 0; i < detections.length; i++) {
    const d = detections[i]
    const t = (d.rec_text || '').trim()
    const m = t.match(/^([一二三四五六])、([^\s（(（]+)/)
    if (!m) continue
    headers.push({
      idx: i,
      sectionChar: m[1],
      sectionType: m[2],
      raw: t,
      x_left: d.bbox[0], y_top: d.bbox[1],
      x_right: d.bbox[2], y_bot: d.bbox[3]
    })
  }
  // 同 sectionChar 多次偵測 → 留 y_top 最小
  const dedup = new Map()
  for (const h of headers) {
    if (!dedup.has(h.sectionChar) || h.y_top < dedup.get(h.sectionChar).y_top) {
      dedup.set(h.sectionChar, h)
    }
  }
  const list = [...dedup.values()].sort((a, b) => a.y_top - b.y_top)
  // 標記 y_start / y_end
  for (let i = 0; i < list.length; i++) {
    list[i].y_start = list[i].y_top
    list[i].y_end = list[i + 1]?.y_top ?? imgH
  }
  return list
}

/**
 * 在指定 section y 範圍內找「印刷編號 row」。
 * 啟發式：
 *   - 過濾短數字 detection（1~2 位）
 *   - 取 y_top 最小的一群（最上方一行）、容差 ±50px
 *   - 依 x 排序
 */
export function findCellNumberRow(detections, section, opts = {}) {
  const yTolerance = opts.yTolerance ?? 50
  const inSection = detections.filter(d => {
    const cy = (d.bbox[1] + d.bbox[3]) / 2
    return cy > section.y_start && cy < section.y_end
  })
  const candidates = inSection
    .map((d, i) => ({ d, i, text: (d.rec_text || '').trim() }))
    .filter(({ text }) => NUMBER_LIKE.test(text))
  if (candidates.length === 0) return []
  candidates.sort((a, b) => a.d.bbox[1] - b.d.bbox[1])
  const baseY = candidates[0].d.bbox[1]
  const numRow = candidates.filter(c => Math.abs(c.d.bbox[1] - baseY) < yTolerance)
  numRow.sort((a, b) => a.d.bbox[0] - b.d.bbox[0])
  return numRow.map(c => ({
    idx: c.i,
    text: c.text,
    x_left: c.d.bbox[0], y_top: c.d.bbox[1],
    x_right: c.d.bbox[2], y_bot: c.d.bbox[3],
    x_center: (c.d.bbox[0] + c.d.bbox[2]) / 2,
    y_center: (c.d.bbox[1] + c.d.bbox[3]) / 2
  }))
}

/**
 * 從 numRow 推每格 cell bbox（px 座標 + normalized）。
 * 中間格用相鄰 anchor 中點切；首末格用 typical_w/2 buffer。
 */
export function deriveCellBboxes(numRow, section, imgW, imgH) {
  if (numRow.length === 0) return []
  const cells = []
  const cellYStart = numRow[0].y_top
  const cellYEnd = Math.min(section.y_end, cellYStart + 200)

  // typical cell width：用內部 anchor pair（i-1 ~ i+1）的半寬
  const interiorWidths = []
  for (let i = 1; i < numRow.length - 1; i++) {
    interiorWidths.push((numRow[i + 1].x_left - numRow[i - 1].x_right) / 2)
  }
  if (interiorWidths.length === 0 && numRow.length >= 2) {
    for (let i = 0; i < numRow.length - 1; i++) {
      interiorWidths.push(numRow[i + 1].x_left - numRow[i].x_left)
    }
  }
  const typicalW = interiorWidths.length > 0
    ? interiorWidths.sort((a, b) => a - b)[Math.floor(interiorWidths.length / 2)]
    : 100

  for (let i = 0; i < numRow.length; i++) {
    const cur = numRow[i]
    const prev = numRow[i - 1]
    const next = numRow[i + 1]
    let xLeft, xRight
    if (prev) xLeft = (prev.x_right + cur.x_left) / 2
    else xLeft = Math.max(0, cur.x_left - typicalW / 2)
    if (next) xRight = (cur.x_right + next.x_left) / 2
    else xRight = Math.min(imgW, cur.x_right + typicalW / 2)
    cells.push({
      ordinal: i + 1,
      anchor: cur,
      bbox_px: { x: xLeft, y: cellYStart, w: xRight - xLeft, h: cellYEnd - cellYStart },
      bbox_norm: {
        x: +(xLeft / imgW).toFixed(3),
        y: +(cellYStart / imgH).toFixed(3),
        w: +((xRight - xLeft) / imgW).toFixed(3),
        h: +((cellYEnd - cellYStart) / imgH).toFixed(3)
      }
    })
  }
  return cells
}

/**
 * sub-cell parent 偵測 + 展開：parent cell 寬度應該是 sub_count × sibling_median。
 * 如果 parent 偏窄（推算用相鄰 anchor 中點切的結果），往左展。
 */
export function applySubCellExpansion(cells, subCountByParentOrd, imgW, imgH) {
  for (const [parentOrd, subCount] of subCountByParentOrd.entries()) {
    const idx = parentOrd - 1
    if (idx < 0 || idx >= cells.length) continue
    const parent = cells[idx]
    const otherCells = cells.filter((_, i) => i !== idx)
    if (otherCells.length === 0) continue
    const otherWidths = otherCells.map(c => c.bbox_px.w).sort((a, b) => a - b)
    const medianOther = otherWidths[Math.floor(otherWidths.length / 2)]
    const targetParentW = subCount * medianOther
    if (targetParentW > parent.bbox_px.w) {
      const xRight = parent.bbox_px.x + parent.bbox_px.w
      const newXLeft = Math.max(0, xRight - targetParentW)
      parent.bbox_px = { ...parent.bbox_px, x: newXLeft, w: xRight - newXLeft }
      parent.bbox_norm = {
        x: +(newXLeft / imgW).toFixed(3),
        y: parent.bbox_norm.y,
        w: +((xRight - newXLeft) / imgW).toFixed(3),
        h: parent.bbox_norm.h
      }
    }
  }
  return cells
}

/**
 * Main entry：對 answerKey questions 跟 OCR detections 配對、回傳 candidates。
 *
 * Output schema 跟 `bbox-anchor-match.js` `buildAnchorCandidates` 一致：
 *   { candidatesByQid: { qid → [{ idx, text, bbox, score }] }, stats }
 *
 * - bbox 為 px 座標 [x1, y1, x2, y2]（同 OCR detection 慣例）
 * - downstream `buildOcrHintsSection` / `applyOcrBboxOverride` 直接共用
 */
export function buildCellAnchorCandidates(answerKeyQuestions, ocrDetections, imageSize) {
  const [imgW, imgH] = imageSize || [1, 1]
  const result = {}
  const stats = {
    totalQuestions: 0,
    parsedCount: 0,
    sectionFound: 0,
    matchedCount: 0,
    matchRate: 0,
    assignmentMethod: 'cell_anchor',
    sectionsDetected: [],
    perSection: {}
  }
  if (!Array.isArray(answerKeyQuestions) || !Array.isArray(ocrDetections)) {
    return { candidatesByQid: {}, stats }
  }
  stats.totalQuestions = answerKeyQuestions.length

  // Step 1: section headers
  const sections = findSectionHeaders(ocrDetections, imgH)
  stats.sectionsDetected = sections.map(s => ({ char: s.sectionChar, type: s.sectionType, y_start: s.y_start, y_end: s.y_end }))
  if (sections.length === 0) return { candidatesByQid: {}, stats }

  // Step 2: 對每個 section 求 numRow + cells
  const cellsBySection = new Map()
  for (const sec of sections) {
    const numRow = findCellNumberRow(ocrDetections, sec)
    let cells = deriveCellBboxes(numRow, sec, imgW, imgH)
    // sub-cell expansion
    const subCountByParent = new Map()
    for (const q of answerKeyQuestions) {
      const p = parseCellAnchorHint(q.anchorHint)
      if (!p || p.type !== 'subcell') continue
      const sChar = p.sectionName.match(/^[一二三四五六]/)?.[0]
      if (sChar !== sec.sectionChar) continue
      subCountByParent.set(p.parentOrdinal, Math.max(subCountByParent.get(p.parentOrdinal) || 0, p.subOrdinal))
    }
    if (subCountByParent.size > 0) {
      cells = applySubCellExpansion(cells, subCountByParent, imgW, imgH)
    }
    cellsBySection.set(sec.sectionChar, cells)
    stats.perSection[sec.sectionChar] = {
      sectionType: sec.sectionType,
      numRowCount: numRow.length,
      cellCount: cells.length,
      subCells: [...subCountByParent.entries()]
    }
  }

  // Step 3: 對每題用 anchorHint 找對應 cell
  for (const q of answerKeyQuestions) {
    const qid = q?.id
    if (!qid) continue
    const parsed = parseCellAnchorHint(q.anchorHint)
    if (!parsed) continue
    stats.parsedCount++
    const sectionChar = parsed.sectionName.match(/^[一二三四五六]/)?.[0]
    if (!sectionChar) continue
    const cells = cellsBySection.get(sectionChar)
    if (!cells || cells.length === 0) continue
    stats.sectionFound++

    // ordinal: cell 用 cellOrdinal、subcell 用 parentOrdinal（之後切）
    const targetOrd = parsed.type === 'cell' ? parsed.cellOrdinal : parsed.parentOrdinal
    const cell = cells[targetOrd - 1]
    if (!cell) continue

    let bbox_px = cell.bbox_px
    // sub-cell 切分
    if (parsed.type === 'subcell') {
      const siblingCount = answerKeyQuestions.filter(qq => {
        const p = parseCellAnchorHint(qq.anchorHint)
        return p?.type === 'subcell' && p.sectionName === parsed.sectionName && p.parentOrdinal === parsed.parentOrdinal
      }).length || 1
      const subW = cell.bbox_px.w / siblingCount
      const subX = cell.bbox_px.x + subW * (parsed.subOrdinal - 1)
      bbox_px = { x: subX, y: cell.bbox_px.y, w: subW, h: cell.bbox_px.h }
    }

    // bbox 用 px [x1, y1, x2, y2] 格式（跟 ocrDetections.bbox 慣例一致）
    const bbox = [
      Math.round(bbox_px.x),
      Math.round(bbox_px.y),
      Math.round(bbox_px.x + bbox_px.w),
      Math.round(bbox_px.y + bbox_px.h)
    ]
    result[qid] = [{
      idx: cell.anchor.idx,
      text: `cell#${cell.ordinal}${parsed.type === 'subcell' ? `(${parsed.subOrdinal}/${cell.bbox_px.w})` : ''}`,
      bbox,
      score: 1.0  // cell anchor 是 deterministic、score=1
    }]
    stats.matchedCount++
  }

  stats.matchRate = stats.totalQuestions > 0 ? stats.matchedCount / stats.totalQuestions : 0
  return { candidatesByQid: result, stats }
}
