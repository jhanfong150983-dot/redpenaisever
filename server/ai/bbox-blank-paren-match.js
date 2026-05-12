/**
 * BBox Blank Paren Match — 「label（ ）label」inline 填空格式增益
 *
 * 處理 anchorHint 描述「prefix（ ）suffix」這種<b>括號內留空</b>的 fill_blank：
 *   anchorHint 例：「小題 (1)-① 線段圖中標示『大（ ）歲』的括號」
 *
 * 跟 bbox-bracket-gap 不一樣：
 *   - bracket_gap：兩個 OCR row（一個結尾「（」、一個開頭「）」）中間的空白 → 適合題幹被切成兩 row 的長句
 *   - blank_paren：單一 OCR row 含「prefix(content)suffix」、content 可空可有 → 適合線段圖標籤
 *
 * OCR 範例（學生填了之後）：
 *   "大(24)歲"      ← 期待匹配 anchor「大（ ）歲」
 *   "相差(48)歲"    ← 期待匹配 anchor「相差（ ）歲」
 *   "相差()倍"      ← 學生還沒填、OCR 讀到空括號
 *   "(3)倍"          ← prefix 空、anchor「（ ）倍」
 *
 * 多 qid 同 anchor 拆分：
 *   page 1 有兩處「相差（ ）倍」、qid 1-1-1-2-1 跟 1-1-2-1-2 都用同 anchor。
 *   按 qid 字典序排、OCR matches 按 y-ascending 排、zip 配對。
 *
 * 跟其他 matcher 平行存在、output schema 一致（candidatesByQid + stats）。
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
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 解 anchorHint，抽出「prefix（ ）suffix」三段。
 *
 * 規則：找 「」或『』內含「（ ）」（括號內 0~3 個空白）的 label。
 * 若整個 anchorHint 沒 「」/『』、也試找 inline 「prefix（ ）suffix」pattern。
 *
 * @returns null | { prefix, suffix, qualifier: 'bottom'|'top'|null }
 */
export function parseBlankParenHint(hint) {
  if (!hint) return null
  const h = String(hint)

  // Step 1: 找 「...（ ）...」 in 「」 or 『』
  let labelText = null
  const m1 = h.match(/[「『]([^」』]*?[（(]\s*[）)][^」』]*?)[」』]/)
  if (m1) labelText = m1[1]
  // Step 2: fallback — inline match without quotes
  if (!labelText) {
    const m2 = h.match(/([一-鿿]{0,4})[（(]\s*[）)]([一-鿿]{0,4})/)
    if (m2) labelText = `${m2[1]}（ ）${m2[2]}`
  }
  if (!labelText) return null

  // Step 3: split around the empty parens
  const parts = labelText.match(/^([^（(]*)[（(]\s*[）)](.*)$/)
  if (!parts) return null
  const prefix = parts[1].trim()
  const suffix = parts[2].trim()
  if (!prefix && !suffix) return null  // 太弱、不收

  let qualifier = null
  if (/最下方|底部|最下面|最下/.test(h)) qualifier = 'bottom'
  else if (/最上方|頂部|最上面|最上/.test(h)) qualifier = 'top'

  return { prefix, suffix, qualifier }
}

/**
 * 在 detections 中找所有匹配 `^prefix[（(].*?[）)]suffix$` 的 row。
 * 括號內任意內容（可空）、全形/半形都接受、簡繁正規化。
 *
 * mode='exact'：必須 prefix + bracket + suffix 都到位
 * mode='prefix_only'：suffix 容錯（OCR 對單字尾巴常 misread、例「歲→线」）、
 *   只要求 `^prefix[（(].*?[）)].{0,3}$`、score 降為 0.6
 */
function findBlankParenRows(detections, parsed, mode = 'exact') {
  const prefixNorm = normalize(parsed.prefix)
  const suffixNorm = normalize(parsed.suffix)
  const prefixPat = prefixNorm ? escapeRegex(prefixNorm) : ''
  const suffixPat = suffixNorm ? escapeRegex(suffixNorm) : ''
  const re = mode === 'prefix_only'
    ? new RegExp(`^${prefixPat}\\s*[（(][^）)]*[）)].{0,3}$`)
    : new RegExp(`^${prefixPat}\\s*[（(][^）)]*[）)]\\s*${suffixPat}\\s*$`)

  const matches = []
  for (let i = 0; i < detections.length; i++) {
    const text = (detections[i].rec_text || '').trim()
    const textNorm = normalize(text)
    if (re.test(textNorm)) {
      matches.push({ idx: i, det: detections[i] })
    }
  }
  return matches
}

/**
 * Main entry：對 answerKey fill_blank 含「（ ）」blank anchor 的題配 candidates。
 */
export function buildBlankParenCandidates(answerKeyQuestions, ocrDetections, imageSize) {
  const stats = {
    totalCandidates: 0,
    parsedCount: 0,
    matchedCount: 0,
    matchRate: 0,
    multiAssignedGroups: 0,
    assignmentMethod: 'blank_paren'
  }
  if (!Array.isArray(answerKeyQuestions) || !Array.isArray(ocrDetections)) {
    return { candidatesByQid: {}, stats }
  }

  // Step 1：filter 合格 question 並解 anchorHint
  const parsedQs = []
  for (const q of answerKeyQuestions) {
    if (!q?.questionCategory || !FILL_TYPES.has(q.questionCategory)) continue
    if (!q.anchorHint) continue
    stats.totalCandidates++
    const parsed = parseBlankParenHint(q.anchorHint)
    if (!parsed) continue
    parsedQs.push({ q, parsed })
    stats.parsedCount++
  }
  if (parsedQs.length === 0) return { candidatesByQid: {}, stats }

  // Step 2：依 (prefix, suffix) 分組
  const groups = new Map()
  for (const item of parsedQs) {
    const key = `${item.parsed.prefix}||${item.parsed.suffix}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }

  // Step 3：每組分配 (qid → OCR row)、共兩輪
  //   Round 1 (exact)：嚴格 prefix + (.*) + suffix
  //   Round 2 (fuzzy)：suffix 容錯（OCR 對單字尾常 misread、例「歲→线」）、avoid usedRowIdx、score 0.6
  const result = {}
  const usedRowIdx = new Set()
  const matchedQids = new Set()

  function assignMatchesToGroup(items, matches, parsed, scoreVal, tag) {
    // sort matches by y-center asc
    matches.sort((a, b) => {
      const ay = (a.det.bbox[1] + a.det.bbox[3]) / 2
      const by = (b.det.bbox[1] + b.det.bbox[3]) / 2
      return ay - by
    })

    // 未配 qid（exact 階段已配掉的 skip）
    const remainingItems = items
      .filter(it => !matchedQids.has(it.q.id))
      .sort((a, b) => String(a.q.id).localeCompare(String(b.q.id)))
    if (remainingItems.length === 0) return 0

    let assigned = 0
    // qualifier-aware：單 qid + bottom 取最後；單 qid + top 取最前
    if (remainingItems.length === 1 && parsed.qualifier === 'bottom' && matches.length > 0) {
      const m = matches[matches.length - 1]
      const q = remainingItems[0].q
      result[q.id] = [{
        idx: m.idx,
        text: `blank-paren [${parsed.prefix}( )${parsed.suffix}|bottom${tag}]: ${(m.det.rec_text || '').slice(0, 20)}`,
        bbox: m.det.bbox,
        score: scoreVal
      }]
      usedRowIdx.add(m.idx)
      matchedQids.add(q.id)
      assigned++
    } else if (remainingItems.length === 1 && parsed.qualifier === 'top' && matches.length > 0) {
      const m = matches[0]
      const q = remainingItems[0].q
      result[q.id] = [{
        idx: m.idx,
        text: `blank-paren [${parsed.prefix}( )${parsed.suffix}|top${tag}]: ${(m.det.rec_text || '').slice(0, 20)}`,
        bbox: m.det.bbox,
        score: scoreVal
      }]
      usedRowIdx.add(m.idx)
      matchedQids.add(q.id)
      assigned++
    } else {
      const n = Math.min(remainingItems.length, matches.length)
      for (let i = 0; i < n; i++) {
        const m = matches[i]
        const q = remainingItems[i].q
        result[q.id] = [{
          idx: m.idx,
          text: `blank-paren [${parsed.prefix}( )${parsed.suffix}${tag}]: ${(m.det.rec_text || '').slice(0, 20)}`,
          bbox: m.det.bbox,
          score: scoreVal
        }]
        usedRowIdx.add(m.idx)
        matchedQids.add(q.id)
        assigned++
      }
    }
    return assigned
  }

  // Round 1: exact
  for (const [key, items] of groups.entries()) {
    const parsed = items[0].parsed
    const matches = findBlankParenRows(ocrDetections, parsed, 'exact').filter(m => !usedRowIdx.has(m.idx))
    if (matches.length === 0) continue
    const n = assignMatchesToGroup(items, matches, parsed, 1.0, '')
    stats.matchedCount += n
    if (items.length > 1 && n > 1) stats.multiAssignedGroups++
  }

  // Round 2: fuzzy (suffix 容錯)
  for (const [key, items] of groups.entries()) {
    if (items.every(it => matchedQids.has(it.q.id))) continue
    const parsed = items[0].parsed
    if (!parsed.prefix) continue  // prefix 空時 fuzzy 太危險、不開
    const matches = findBlankParenRows(ocrDetections, parsed, 'prefix_only').filter(m => !usedRowIdx.has(m.idx))
    if (matches.length === 0) continue
    const n = assignMatchesToGroup(items, matches, parsed, 0.6, '|fuzzy')
    stats.matchedCount += n
    stats.fuzzyMatched = (stats.fuzzyMatched || 0) + n
  }

  stats.matchRate = stats.totalCandidates > 0 ? +(stats.matchedCount / stats.totalCandidates).toFixed(3) : 0
  return { candidatesByQid: result, stats }
}
