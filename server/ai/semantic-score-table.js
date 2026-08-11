// ═══ 值→分數表(查表制)─ 2026-08-11 user 拍板設計 ═══════════════════════════════
// 目標:⑥⑦語意題「同答、同分、同理由」結構化 + 重批/跨班零 AI。
// Pilot 範圍:國語 short_answer(帶 rubricsDimensions)。
// 設計(全記錄在 memory project_value_score_table_design_2026-08-11):
//   - 懶建表:逐卷批改中,查表命中→凍結結果直接用;未命中→投票評分(2 票+不合加賽)→凍入表
//   - 投票:兩票全同=unanimous;2:1=majority;三票全歧=split_max 取最高分(user:老師慣習偏寬、不升級 PRO)+低信心
//   - 錯字覆核(charerr)也按值快取(純文字判、3 票多數決,鏡像 staged-grading 的 B-CharErr prompt)
//   - 表掛 answer_key_template 層跨班共用(borrow 精神同 pdf_classify_template);無 template 用 assignmentId
//   - 併發凍結:unique(scope,qid,value) upsert-ignore、輸的重讀勝者
//   - 沙盒依據:exp-zhushi-batch-0811(批次比逐卷更晃 69-77% → 一致性靠「凍結」不靠「重現」;
//     兩判例 user 眼球裁決批次版勝出:半答案=部分分、一次次=0)

// 正規化:全半形標點/空白折疊、頭尾標點去除——**一字不折**(錯字是 charerr 的事,不可被正規化吞掉)
export function normSemanticValue(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/，/g, ',').replace(/。/g, '.').replace(/；/g, ';').replace(/：/g, ':').replace(/、/g, ',')
    .replace(/^[,.;:!?，。；：、！？\s]+|[,.;:!?，。；：、！？\s]+$/g, '')
}

export async function resolveSemanticScopeKey(supabase, assignmentId) {
  if (!assignmentId) return null
  try {
    const { data } = await supabase.from('assignments').select('answer_key_template_id').eq('id', assignmentId).maybeSingle()
    return data?.answer_key_template_id || assignmentId
  } catch {
    return assignmentId
  }
}

// → Map(questionId → Map(valueNorm → entry))
export async function loadSemanticTable(supabase, scopeKey, questionIds) {
  const out = new Map()
  if (!scopeKey || !questionIds?.length) return out
  const { data, error } = await supabase
    .from('semantic_score_tables')
    .select('question_id, value_norm, value_raw, score, max_score, rubric_scores, char_err, verdict, low_conf')
    .eq('scope_key', scopeKey)
    .in('question_id', questionIds)
  if (error) throw new Error(`loadSemanticTable: ${error.message}`)
  for (const row of data || []) {
    const qm = out.get(row.question_id) ?? new Map()
    qm.set(row.value_norm, row)
    out.set(row.question_id, qm)
  }
  return out
}

// 語意評分單值 prompt(鏡像沙盒驗證版+整數約束;anchors=既有表當量尺錨點)
function buildSemanticJudgePrompt(q, raw, anchors) {
  const dims = (q.rubricsDimensions || []).map((d) => `  - ${d.name}(${d.maxScore} 分):${d.criteria}`).join('\n')
  const anchorText = anchors.length
    ? `\n【既有量尺(同題其他寫法的定案分數,評分時保持同一把尺)】\n${anchors.map((a) => `- 「${a.value_raw}」→ ${a.score} 分`).join('\n')}\n`
    : ''
  return `你是國小國語科的批改老師。請依 rubric 維度為以下學生作答評分。

【題目資訊】
- 題型:注釋/語詞解釋(short_answer)
- 參考答案:「${q.referenceAnswer ?? q.answer}」
- 配分:${q.maxScore} 分
- rubricsDimensions(評分維度,唯一評分錨點):
${dims}
${anchorText}
【評分規則(嚴格遵守)】
- Grade by key concept presence using rubricsDimensions only. Do NOT use rubric 4-level fallback.
- criteria 中「準確提及「X」」等描述的是「目標概念」而非逐字要求,不做關鍵字比對——只判斷學生答案是否表達相同意義。
- referenceAnswer 是「範例答案」不是必要覆蓋清單。
- 國語注釋題:referenceAnswer 本身 2-4 字(如「深藍」「回頭」)是正常的,字面吻合即應滿分,不因答案短而扣分。
- 你只判**語意**(保留=滿分/部分保留=部分分/語意改變=0),錯字**不影響你的給分**;
- 🚨 絕對不要在 reason 裡寫「錯字不扣分」之類的說法;若學生有錯字,理由只需描述語意是否正確,不要對用字下結論。
- 每個維度只依自己的 criteria 獨立判分,禁止連坐。
- 🚨 每個維度分數只能是 0 到該維度滿分的**整數**。

【學生作答】
「${raw}」

【輸出】只輸出 JSON:
{"rubricScores":[{"dimension":"${(q.rubricsDimensions?.[0]?.name) ?? ''}","score":0,"maxScore":${(q.rubricsDimensions?.[0]?.maxScore) ?? 1},"reason":"..."}]}`
}

// 錯字覆核 prompt(逐字鏡像 staged-grading B-CharErr v3)
function buildCharErrPrompt(ref, stu) {
  return `國語科用字覆核。標準答案：「${ref}」。學生作答：「${stu}」。
逐字比對，數出學生作答裡有幾個「用字錯誤」。

用字錯誤 ＝ **標準答案某個位置的字，學生寫成了別的字**，且兩字是同音／近音或字形相近：
✅ 同音或近音：「地」寫成「的」、「急」寫成「極」、「在」寫成「再」、「盡」寫成「進」。
✅ 字形相近（含部件多寫或少寫）：「都」寫成「者」、「繁」寫成「敏」、偏旁寫錯、部件漏寫。
✅ 以注音符號代替國字。

一律不算錯、count 不要加：
❌ **標準答案裡本來就沒有的字**（學生自己多寫的助詞、贅字）——那是「多寫」不是「寫錯」。
   例：標準答案「盡情飲酒」、學生「盡情的飲酒」→ 標準答案沒有那個位置的字 → count 不加。
❌ 換成另一個「不同音也不同形」的同義詞：「急速」寫成「快速」、「由」寫成「從」。
❌ 漏字、缺字、只答部分、詞序顛倒。
❌ 標點差異、簡繁體、改用自己的話但意思相同。

count = 錯字個數（0 = 沒有用字錯誤）。同一個字重複寫錯只算 1 個。
which = 每個錯字寫成「X 應為 Y」，多個用「、」分隔；沒有則空字串。不要寫解釋、不要超過 30 字。
只輸出 JSON：{"count":0,"which":""}`
}

function sumDims(q, rubricScores) {
  let total = 0
  const dims = q.rubricsDimensions || []
  for (let i = 0; i < dims.length; i++) {
    const mx = Number(dims[i]?.maxScore) || 0
    const sv = Math.round(Number(rubricScores?.[i]?.score))
    total += Math.max(0, Math.min(mx, Number.isFinite(sv) ? sv : 0))
  }
  return total
}

// 語意投票:兩票+不合加賽;回 {score, rubricScores, votes, verdict, lowConf} 或 null(全失敗 → fail-open 交 accessor)
async function voteSemantic({ askJson, q, raw, anchors }) {
  const votes = []
  const cast = async () => {
    const pj = await askJson(buildSemanticJudgePrompt(q, raw, anchors))
    if (!pj || !Array.isArray(pj.rubricScores)) return null
    return { rubricScores: pj.rubricScores, total: sumDims(q, pj.rubricScores) }
  }
  const v1 = await cast(); if (v1) votes.push(v1)
  const v2 = await cast(); if (v2) votes.push(v2)
  if (votes.length === 0) return null
  if (votes.length === 1) return { score: votes[0].total, rubricScores: votes[0].rubricScores, votes: votes.map((v) => v.total), verdict: 'majority', lowConf: true }
  if (votes[0].total === votes[1].total) {
    return { score: votes[0].total, rubricScores: votes[0].rubricScores, votes: votes.map((v) => v.total), verdict: 'unanimous', lowConf: false }
  }
  const v3 = await cast()
  if (v3) votes.push(v3)
  const tally = new Map()
  for (const v of votes) tally.set(v.total, (tally.get(v.total) || 0) + 1)
  const [topScore, topCount] = [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]
  if (topCount >= 2) {
    const win = votes.find((v) => v.total === topScore)
    return { score: topScore, rubricScores: win.rubricScores, votes: votes.map((v) => v.total), verdict: 'majority', lowConf: false }
  }
  // 三票全歧 → 取最高分(user 拍板:老師慣習偏寬、不升級 PRO)、標低信心
  const maxV = votes.reduce((a, b) => (b.total > a.total ? b : a))
  return { score: maxV.total, rubricScores: maxV.rubricScores, votes: votes.map((v) => v.total), verdict: 'split_max', lowConf: true }
}

// 錯字覆核三票多數決(平手取較小=加法式精神);null=全失敗(fail-open 當 0 錯字、不快取)
async function voteCharErr({ askJson, ref, stu, voteN = 3 }) {
  const votes = []
  for (let i = 0; i < voteN; i++) {
    const pj = await askJson(buildCharErrPrompt(ref, stu))
    if (pj != null) votes.push({ count: Math.max(0, Math.floor(Number(pj.count) || 0)), which: String(pj.which ?? '') })
  }
  if (!votes.length) return null
  const tally = new Map()
  for (const v of votes) tally.set(v.count, (tally.get(v.count) || 0) + 1)
  const cnt = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
  const rep = votes.find((v) => v.count === cnt) ?? votes[0]
  return { count: cnt, which: rep.which.slice(0, 30) }
}

// 評新值+凍結(併發安全:upsert-ignore、衝突時重讀勝者)
export async function judgeAndFreezeValue({ supabase, askJson, askJsonPro, scopeKey, q, raw, anchors, model, config }) {
  const valueNorm = normSemanticValue(raw)
  if (!valueNorm) return null
  const sem = await voteSemantic({ askJson, q, raw, anchors })
  if (!sem) return null
  const ref = String(q.referenceAnswer ?? q.answer ?? '').trim()
  const ce = sem.score > 0 ? await voteCharErr({ askJson: askJsonPro ?? askJson, ref, stu: raw }) : { count: 0, which: '' }
  const entry = {
    scope_key: scopeKey,
    question_id: q.id,
    value_norm: valueNorm,
    value_raw: String(raw).slice(0, 200),
    score: sem.score,
    max_score: Number(q.maxScore) || null,
    rubric_scores: sem.rubricScores,
    char_err: ce ?? { count: 0, which: '', failOpen: true },
    votes: sem.votes,
    verdict: sem.verdict,
    low_conf: sem.lowConf,
    model: model || null,
    config: config || null
  }
  const { data: inserted, error } = await supabase
    .from('semantic_score_tables')
    .upsert(entry, { onConflict: 'scope_key,question_id,value_norm', ignoreDuplicates: true })
    .select('question_id, value_norm, value_raw, score, max_score, rubric_scores, char_err, verdict, low_conf')
  if (error) throw new Error(`freezeEntry: ${error.message}`)
  if (Array.isArray(inserted) && inserted.length > 0) return inserted[0]
  // 衝突=別的卷先凍了 → 用勝者(同答同分同理由的保證)
  const { data: winner } = await supabase
    .from('semantic_score_tables')
    .select('question_id, value_norm, value_raw, score, max_score, rubric_scores, char_err, verdict, low_conf')
    .eq('scope_key', scopeKey).eq('question_id', q.id).eq('value_norm', valueNorm)
    .maybeSingle()
  return winner ?? entry
}

// 表 entry → accessor scores 形狀的格(語意分 − 快取錯字扣分;同答同分同理由)
export function composeCellFromEntry(entry, q, raw) {
  const semantic = Number(entry.score) || 0
  const maxScore = Number(entry.max_score ?? q.maxScore) || 0
  const ceCount = Math.max(0, Number(entry.char_err?.count) || 0)
  const applyCe = semantic > 0 && ceCount > 0
  const finalScore = applyCe ? Math.max(0, semantic - ceCount) : semantic
  const dims = Array.isArray(entry.rubric_scores) ? entry.rubric_scores : []
  const dimText = dims.map((d) => `${d.dimension}（${d.score}/${d.maxScore}分）：${d.reason}`).join(' ')
  const reason = applyCe
    ? `用字錯誤 ${ceCount} 處：${entry.char_err?.which || '出現錯別字'}（每處扣 1 分，${semantic}→${finalScore}）`
    : (dimText || (finalScore === maxScore ? `學生寫「${raw}」，答案正確` : `學生寫「${raw}」`))
  return {
    questionId: q.id,
    isCorrect: maxScore > 0 && finalScore === maxScore,
    score: finalScore,
    maxScore,
    errorType: finalScore === maxScore ? 'none' : 'concept',
    reason,
    scoringReason: reason,
    rubricScores: dims,
    confidence: 100,
    scoreConfidence: entry.low_conf ? 65 : 90,
    studentFinalAnswer: String(raw),
    needExplain: maxScore > 0 && finalScore < maxScore,
    _semanticTable: true,
    _semanticLowConf: entry.low_conf === true,
    ...(applyCe ? { _charErrOverride: true } : {})
  }
}
