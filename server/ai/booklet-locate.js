// 題本題目定位（booklet question localization）— 純 page 版（id → 題本頁碼）
// ───────────────────────────────────────────────────────────────────────────
// 目的：給「整本題本圖（每頁一張）+ answer_key」，產出每一題的 internalId -> { page }
//        （該題出現在題本第幾頁；page 為 0-based index，對齊傳入 bookletImages 的順序）。
// 為何需要：answer_only 的學情報告原本把整本題本一次丟給 AI、且用 id 第一段亂猜頁碼
//          （id 第一段是「答案卡照片號」≠ 題本頁碼）→ AI 跨頁把題號對錯
//          （例：1-2-14 字義被當成標點題 1-2-5）。改成「一頁只判該頁、回報該頁有哪些題」，
//          報告就只附該錯題所在的「正確整頁」+ 正確的 id→頁 指引，消除跨頁混淆。
//
// 實驗結論（scripts/exp-booklet-pageonly.mjs 等）：
//  - 純 page、不用 bbox：3.5-flash（MODEL_PRO）id→頁 = 36/36、0 dup、0 flip、子題群消歧 100%。
//  - 2.5-flash 不行（子題群孤兒題翻車、加 context 會吞整頁）→ detection 必須用 MODEL_PRO/3.5。
//  - bbox 不需要（page-only 已足夠定位到正確頁）。
//
// 範圍與限制：
//  - 只定位「有題幹/選項可辨識」的題型（single_choice / multi_choice / true_false / short_answer）。
//    fill_blank-only 的大題（如「一、國字注音」格子題）不納入（模型本來也不會回、報告對這類維持原處理）。
//  - 題組（每篇印刷題號各自從 1 重來，id 形如 1-3-2-3）靠「第幾篇 + 該篇印刷題號」對到內部 id。
//  - callModel 由呼叫端注入（runner 用 callGeminiGenerateContent；production 走 orchestrator）。

const FRAMABLE_TYPES = new Set(['single_choice', 'multi_choice', 'true_false', 'short_answer'])
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']

function idSegments(id) { return String(id).split('-') }
function sectionOf(id) { return idSegments(id)[1] }
// 題組 key：depth>=4 時取「section-group」（"1-3-2-3" -> "3-2"）；否則取 section
function groupKeyOf(id) {
  const s = idSegments(id)
  return s.length >= 4 ? `${s[1]}-${s[2]}` : s[1]
}

/**
 * 從 answer_key.questions 建 id-tree（給 prompt 當「已知結構」）+ 可辨識題集合。
 * 回傳：{ treeText, framableIds:Set }
 */
export function buildBookletIdTree(answerKeyQuestions) {
  const questions = Array.isArray(answerKeyQuestions) ? answerKeyQuestions : []
  const bySection = new Map()
  for (const q of questions) {
    const id = q?.id
    if (!id) continue
    const sec = sectionOf(id)
    if (!bySection.has(sec)) bySection.set(sec, [])
    bySection.get(sec).push(q)
  }

  const framableIds = new Set()
  const sectionLines = []

  const sortedSecs = [...bySection.keys()].sort((a, b) => Number(a) - Number(b))
  for (const sec of sortedSecs) {
    const qs = bySection.get(sec)
    const types = [...new Set(qs.map(q => q?.questionCategory).filter(Boolean))]
    const framable = qs.some(q => FRAMABLE_TYPES.has(q?.questionCategory))
    const isGrouped = qs.some(q => idSegments(q.id).length >= 4)
    const cn = CN_NUM[Number(sec)] || sec

    if (framable) qs.forEach(q => { if (FRAMABLE_TYPES.has(q?.questionCategory)) framableIds.add(q.id) })

    if (!framable) {
      sectionLines.push(`- 大題${cn}（${types.join('/') || '填答格'}，無題幹/選項、免判）：${qs[0].id} ~ ${qs[qs.length - 1].id}`)
      continue
    }

    if (isGrouped) {
      const byGroup = new Map()
      for (const q of qs) {
        const g = idSegments(q.id)[2]
        if (!byGroup.has(g)) byGroup.set(g, [])
        byGroup.get(g).push(q.id)
      }
      const groupLines = []
      for (const g of [...byGroup.keys()].sort((a, b) => Number(a) - Number(b))) {
        const ids = byGroup.get(g).sort()
        groupLines.push(`    第(${CN_NUM[Number(g)] || g})篇：${ids[0]} ~ ${ids[ids.length - 1]}（${ids.length} 題）`)
      }
      sectionLines.push(`- 大題${cn}（題組；每篇印刷題號各自從 1 重新開始）：\n${groupLines.join('\n')}`)
    } else {
      const ids = qs.map(q => q.id).sort((a, b) => Number(idSegments(a)[2]) - Number(idSegments(b)[2]))
      sectionLines.push(`- 大題${cn}（${types.join('/')}）：${ids[0]} ~ ${ids[ids.length - 1]}（題號全段連續）`)
    }
  }

  return { treeText: sectionLines.join('\n'), framableIds }
}

export function buildBookletLocatePrompt(pageNum, pageCount, treeText) {
  return `你會看到一張國語/國文考卷題本的第 ${pageNum + 1} 頁（整本題本共 ${pageCount} 頁，頁碼從 1 算）。

整份題本的內部題號結構（已知；但「哪些題出現在這一頁」要靠你看圖判斷）：
${treeText}

任務：只回答「這一頁上實際看得到題目本體（題號 + 題幹/選項）」的題目是哪幾題（**不需要座標**）。
- 題組（閱讀測驗）的文章本體不是題目，只有底下編號的小題才算；要靠「第幾篇(一/二/三/四) + 該篇印刷題號」對到內部 id（因為各篇題號都從 1 重新開始）。
- 標「免判」的大題（如國字注音/填空格）不要輸出。
- 若某題只露出一部分、但題號與題幹看得到，也算在這一頁。

對每一題輸出：
- id：對應上面結構的內部題號
- seen：你在頁面看到的印刷標記，例如「大題二/印刷題號14」或「大題三/第(二)篇/印刷題號3」（供核對）

只回 JSON（無 markdown）：{"questions":[{"id":"1-2-14","seen":"大題二/印刷題號14"}]}
這一頁沒有的題不要輸出。`
}

/**
 * 主函式：定位整本題本，回傳每題在第幾頁。
 * @param {Object} p
 * @param {Array<{mimeType,data}>} p.bookletImages  每頁一張（data=base64），index=page（0-based）
 * @param {Array} p.answerKeyQuestions
 * @param {(args:{prompt,imageBase64,mimeType,page})=>Promise<object|null>} p.callModel  回傳已 parse 的 {questions:[...]} 或 null
 * @param {(msg:string)=>void} [p.log]
 * @returns {Promise<{locations:Object, missing:string[], meta:Object}>}
 *          locations: { [id]: { page, seen } }
 */
export async function localizeBookletQuestions({ bookletImages, answerKeyQuestions, callModel, log }) {
  const logf = typeof log === 'function' ? log : () => {}
  const images = Array.isArray(bookletImages) ? bookletImages : []
  if (images.length === 0) return { locations: {}, missing: [], meta: { reason: 'no_booklet_images' } }

  const { treeText, framableIds } = buildBookletIdTree(answerKeyQuestions)
  const pageCount = images.length

  const runPage = async (page) => {
    const img = images[page]
    if (!img?.data) return new Map()
    const prompt = buildBookletLocatePrompt(page, pageCount, treeText)
    let parsed = null
    try { parsed = await callModel({ prompt, imageBase64: img.data, mimeType: img.mimeType || 'image/webp', page }) }
    catch (e) { logf(`[booklet-locate] page ${page} call error: ${e?.message || e}`); return new Map() }
    const out = new Map()
    for (const q of (parsed?.questions || [])) {
      const id = q?.id && String(q.id)
      if (!id) continue
      out.set(id, { seen: q.seen || '' })
    }
    return out
  }

  // pass 1：每頁各跑一次
  const perPage = []
  for (let page = 0; page < pageCount; page++) {
    const mp = await runPage(page)
    perPage.push(mp)
    logf(`[booklet-locate] pass1 page ${page}: ${mp.size} found`)
  }

  const assemble = () => {
    const locations = {}
    for (let page = 0; page < perPage.length; page++) {
      for (const [id, v] of perPage[page]) {
        if (!framableIds.has(id)) continue   // 只收可辨識題
        if (locations[id]) continue           // 先到先得；重複交安全網處理
        locations[id] = { page, seen: v.seen }
      }
    }
    return locations
  }

  let locations = assemble()
  let missing = [...framableIds].filter(id => !locations[id])

  // 安全網：對「缺題」所屬 group 有出現過的頁，重跑一次取聯集（補偶發漏題）
  if (missing.length > 0) {
    const missingGroups = new Set(missing.map(groupKeyOf))
    const pagesToRerun = new Set()
    for (let page = 0; page < perPage.length; page++) {
      for (const id of perPage[page].keys()) {
        if (missingGroups.has(groupKeyOf(id))) pagesToRerun.add(page)
      }
    }
    logf(`[booklet-locate] missing ${missing.length} (${missing.join(',')}); rerun pages [${[...pagesToRerun].join(',')}]`)
    for (const page of pagesToRerun) {
      const mp2 = await runPage(page)
      for (const [id, v] of mp2) if (!perPage[page].has(id)) perPage[page].set(id, v)
    }
    locations = assemble()
    missing = [...framableIds].filter(id => !locations[id])
  }

  return {
    locations,
    missing,
    meta: { pageCount, framableCount: framableIds.size, locatedCount: Object.keys(locations).length }
  }
}
