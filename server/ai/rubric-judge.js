// ═══ rubric 判官：社會／自然的開放式概念題，看圖逐維度判分 ═══════════════════
//
// 【它取代什麼】Phase B 裡「accessor 拿 read 的文字去判分」這一段。
//   read **照樣跑**（檢討單／家長報告／學情分析都要學生寫了什麼），只是判分不再看文字。
//
// 【為什麼】社會卷 4-5-5-1 沙盒（29 份）：2.5 把「斯文豪」讀成「其實憂／其紋豪」，
//   升 3.6 之後改成用歷史知識補出真實人名「李春生」——那是真人但不在本卷清單裡，
//   看起來完全合理、老師掃過去不會起疑。轉寫錯誤會直接連累判分，而判官根本不需要
//   抄對人名，它只要判斷「學生填的是不是清單裡與經濟發展相關的那一位」。
//   **沒有轉寫這一步，這類幻覺就沒有發生的地方。**
//
// 【為什麼不套用到國語】國語帶 rubric 的 20 題，criteria **100%** 寫了「用字書寫正確」；
//   社會 39 題、數學 151 題、自然 3 題則是 **0%**。國語的錯字本身就是評分對象，
//   必須靠 read＋查表制（而且註釋題值域收斂、快取命中率 80%）。這條界線是從資料量出來的。
//
// 【沙盒結果】社會卷 8 題 × 8 生（分層抽樣）＝64 格，用 **production 的 crop**（read 收到的
//   同一份 bytes，零新增裁圖程式）：夾住逐維度上限後 **56/64（87.5%）與現行判分一致**，
//   判官較高 7、較低 1。圈選類維度表現最好（2-3-6 全中）——那是視覺判定，
//   read 得先把「圈了哪一個」轉成文字才判得動。
//
// ⚠ 已知並已處理：判官會忽略逐維度上限（滿分 1 分的維度打到 2~3 分，64 格中 5 格）。
//   prompt 明寫允許值 ＋ 這裡再夾一次，兩道防線。

/** 判官給分一律夾在 [0, 該維度 maxScore]——prompt 講了還是會超，所以程式端必須再擋一次 */
export function clampDimScore(raw, maxScore) {
  const n = Number(raw)
  const m = Math.max(0, Number(maxScore) || 0)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(m, Math.round(n)))
}

/** 這一題適不適用 rubric 判官（純函式、方便測試與稽核） */
export function isRubricJudgeTarget(question, domainHint) {
  const dims = question?.rubricsDimensions
  if (!Array.isArray(dims) || dims.length === 0) return false
  if (question?.levelRubric) return false                    // 級分制優先
  const d = String(domainHint ?? '')
  return d.includes('社會') || d.includes('自然')
}

/**
 * 由 rubricsDimensions 動態生成 prompt，不寫死任何題目內容。
 *
 * 三處刻意設計：
 *  ① evidence 排在 score **之前**——字形（blocks→verdict）／注音（analysis→verdict）都是
 *     分析在前、判定在後。第一版寫成 score 在前＝先承諾數字再補證據，是設計瑕疵。
 *  ② 圈選／勾選類維度是**視覺判定**（看記號、不看文字）——這正是轉寫最容易出錯、
 *     而判官最擅長的地方。系統裡那條「立場詞抄在輸出最前面、用｜接理由」的 read 規則
 *     就是在補這個洞。
 *  ③ 錯字不扣分，但「語句通順」類維度看句子讀不讀得通——這兩件事第一版被混在一起放行。
 */
export function buildRubricJudgePrompt(q) {
  const dims = q?.rubricsDimensions ?? []
  const allowed = (m) => {
    const n = Math.max(0, Number(m) || 0)
    return n <= 0 ? '0' : Array.from({ length: n + 1 }, (_, i) => i).join('、')
  }
  const list = dims.map((d, i) =>
    `${i + 1}.【${d.name}】滿分 ${d.maxScore} 分——${d.criteria}\n   　score 只能填：${allowed(d.maxScore)}`).join('\n')
  const hasPick = dims.some((d) => /圈選|勾選|選擇/.test(String(d.name) + String(d.criteria)))
  const hasFluency = dims.some((d) => /通順|流暢|語句|表達/.test(String(d.name)))
  let n = 3
  const rules = [
    '先把紅框裡學生手寫的內容看過一遍，再逐維度給分。',
    '**逐維度獨立**：每個維度只看它自己的標準，不要因為某一項寫錯就連坐其他項。',
    `判的是**內容對不對**，不是字寫得漂不漂亮。錯字、簡寫、標點不同、字跡潦草**都不扣分**——只要你認得出學生想寫的是什麼。`,
  ]
  if (hasFluency) rules.push('⚠「語句通順／表達」這類維度**例外**：它看的是**句子讀不讀得通、意思連不連貫**，不是看有沒有錯字。寫錯字但句子通順 → 仍給分；沒錯字但語意破碎 → 不給分。')
  if (hasPick) rules.push('**圈選／勾選／選擇類的維度**：看學生在**印刷選項上畫的記號**（圈、打勾、劃線、塗黑），不是看他寫了什麼字。先確定他選的是哪一個，再對照標準。沒有任何記號 → 該維度 0 分。')
  rules.push('**看不清楚或畫面資訊不足以判斷某個維度**：該維度給 0 分，並在 uncertain 說明是哪一個維度、缺什麼。不要為了給分假設看不到的內容。')
  rules.push('⚠ 每個維度的 score **不可超過該維度的滿分**（上面每一項都標了允許值）。')

  return `你是社會科的閱卷老師，正在批改一張學生手寫的考卷。

【批改範圍】
圖中的「紅色方框」標示這一次要批改的作答區。框外的題幹、選項、其他題的作答是**背景資訊**，
可以參考但不是批改對象。

【評分標準】滿分 ${q?.maxScore} 分，共 ${dims.length} 個維度：
${list}

【參考答案】（老師寫的其中一種正確寫法，不是唯一解；學生用自己的話寫、只要意思對就算）
${String(q?.referenceAnswer ?? q?.answer ?? '')}

【怎麼判】
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

【每個維度都要先寫證據、再給分】——證據是你在圖上**實際看到**的東西（學生寫的字、畫的記號），
看不清的字用 ?。先寫證據再寫分數，不要反過來。

只輸出 JSON：
{"dims":[${dims.map((d) => `{"name":"${d.name}","evidence":"在圖上看到什麼","reason":"20字內判斷依據","score":0}`).join(',')}],
"uncertain":"沒把握或畫面不足的地方；沒有就填空字串"}`
}

/**
 * 把判官回應整理成可入分的結果。逐維度夾上限（prompt 講了還是會超）。
 * @returns {{ score, maxScore, dims, uncertain, confidence, reason }|null}
 */
export function parseRubricJudgeResult(parsed, q) {
  const dims = q?.rubricsDimensions ?? []
  const got = Array.isArray(parsed?.dims) ? parsed.dims : null
  if (!got || got.length === 0) return null
  const byName = new Map(got.map((d) => [String(d?.name ?? '').trim(), d]))
  const out = []
  let missing = 0
  for (const d of dims) {
    const hit = byName.get(String(d.name).trim())
    if (!hit) { missing++; out.push({ name: d.name, score: 0, maxScore: d.maxScore, evidence: '', reason: '判官未回報此維度' }); continue }
    out.push({
      name: d.name,
      score: clampDimScore(hit.score, d.maxScore),
      maxScore: Number(d.maxScore) || 0,
      evidence: String(hit.evidence ?? '').slice(0, 120),
      reason: String(hit.reason ?? '').slice(0, 60),
    })
  }
  if (missing === dims.length) return null
  const score = out.reduce((s, d) => s + d.score, 0)
  const maxScore = dims.reduce((s, d) => s + (Number(d.maxScore) || 0), 0)
  const uncertain = String(parsed?.uncertain ?? '').trim()
  // 信心：判官自陳沒把握或有維度沒回報 → 低信心送複核（門檻 <70）；否則 90。
  //   ⚠ 沿用「畫面資訊不足 → 該維度 0 分 + uncertain」的設計：分數已從嚴，
  //     由低信心讓老師看見，符合寧可誤殺不放水。
  const confidence = (uncertain || missing > 0) ? 65 : 90
  const detail = out.map((d) => `${d.name} ${d.score}/${d.maxScore}`).join('、')
  return {
    score, maxScore, dims: out, uncertain,
    confidence,
    reason: `逐維度判分（${detail}）${uncertain ? `；判官沒把握：${uncertain.slice(0, 40)}` : ''}`,
  }
}
