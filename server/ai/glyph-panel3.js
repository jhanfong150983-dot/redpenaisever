// ═══ 字形／注音三判官 v3（2026-08-30 user 逐格拍板）═══════════════════════════
//
// 【設計原則】只有「判對」才可能進複核——防放水；判錯一律不進複核，交給學生申訴。
//   user 原話：「只有答對的，才送低信心，絕對不能放水。不然我擔心又一堆低信心要老師看。」
//
// 【為什麼要改】舊制的兩個病：
//   ① 字形三票是**同一個 prompt 跑三次、溫度 0** → 實測 280 格裡 278 格全票一致（99.3%），
//      根本不是交叉驗證、只是複製同一個偏誤（級分制檔案早就警告過這件事），卻付 3 倍成本。
//   ② 注音是多數決 → `same,same,different` 判 same 且只給 75 分（>70 不進複核）
//      → 實測 49 格這樣靜默通過。user 人工判讀抓到 1-1-8（ㄆㄥ）就是這樣放水的。
//
// 【三判官＝同一判準的三個觀察角度】（不是三個不同標準，也不是「找碴者」）
//   舊注音 C「找不同」實測 44/45 是為反而反（user 全數人工判讀），故 v3 不再設對抗型判官。
//
// 【決策規則】三條：
//   1. 前兩票一致且非 same → 定案、**不跑第三票**（省成本）、80 分
//   2. 前兩票都 same       → 判 same、跑第三票；C 同意 97、C 反對 **65（進複核）**
//   3. 前兩票不一致        → 跑第三票決勝；結果是 same 才 65（進複核），其餘 80
//      ・same+different / same+blank → 取 C 站的那邊
//      ・different+blank → C 說 blank 判 blank，否則 different（兩票都認為「非正解」，
//        不讓唯一一張 same 票翻盤成放水）
//
// ⚠ 不送老師手寫標準圖：字形參考圖管線 2026-07-12 已刻意拔除
//   （沙盒 A1 有圖 vs A2 無圖逐格逐輪完全相同＝零增量；且參考圖曾是誤殺源）。
//   注音 v2 有送標準圖是它自己的設計，v3 沿用各自原本的輸入形態。

/** 複核門檻：<70 進複核面板（與 staged-grading 的 systemConfidence 判定一致） */
export const REVIEW_THRESHOLD = 70

/**
 * 三判官決策。
 * @param {'same'|'different'|'blank'} a 判官 A
 * @param {'same'|'different'|'blank'} b 判官 B
 * @param {'same'|'different'|'blank'|null} c 判官 C（規則 1 時為 null＝未跑）
 * @returns {{ verdict:string, confidence:number, needsThird:boolean, reason:string }}
 */
export function decidePanel3(a, b, c) {
  const valid = (v) => v === 'same' || v === 'different' || v === 'blank'
  if (!valid(a) || !valid(b)) return { verdict: '', confidence: 0, needsThird: false, reason: '判官失敗' }

  // 規則 1：前兩票一致且非 same → 不需第三票
  if (a === b && a !== 'same') {
    return { verdict: a, confidence: 80, needsThird: false, reason: a === 'blank' ? '兩票一致未作答' : '兩票一致判錯' }
  }
  // 規則 2：前兩票都 same → 判 same，第三票只決定信心
  if (a === b) {
    if (!valid(c)) return { verdict: 'same', confidence: 97, needsThird: true, reason: '兩票放行、第三票失敗' }
    return c === 'same'
      ? { verdict: 'same', confidence: 97, needsThird: true, reason: '三票一致放行' }
      : { verdict: 'same', confidence: 65, needsThird: true, reason: `判對但第三判官認為${c === 'blank' ? '未作答' : '不符'}——請確認是否放水` }
  }
  // 規則 3：前兩票不一致 → 第三票決勝
  if (!valid(c)) return { verdict: 'different', confidence: 80, needsThird: true, reason: '兩票分歧、第三票失敗（從嚴）' }
  const pair = [a, b]
  const verdict = (pair.includes('different') && pair.includes('blank'))
    ? (c === 'blank' ? 'blank' : 'different')   // 兩票都認為非正解 → 不讓單張 same 翻盤
    : c                                          // same+different / same+blank → 取 C 站的那邊
  return verdict === 'same'
    ? { verdict, confidence: 65, needsThird: true, reason: '兩票分歧、第三判官判對——請確認是否放水' }
    : { verdict, confidence: 80, needsThird: true, reason: '兩票分歧、第三判官判錯' }
}

/** 前兩票是否需要跑第三票（呼叫端據此決定要不要付第三次的錢） */
export function needsThirdVote(a, b) {
  const valid = (v) => v === 'same' || v === 'different' || v === 'blank'
  if (!valid(a) || !valid(b)) return true
  return !(a === b && a !== 'same')
}

// ── 三判官 prompt（國字）──────────────────────────────────────────────────
// 判準三者完全相同（沿用現行字形判準），只換「觀察路徑」。
const GLYPH_CRITERIA = `判準（老師改考卷的標準）：字醜、潦草、微小筆畫差異（多一點/少一橫/內部細節模糊）都算 same。
只有「某一大塊寫成別的東西」「缺了一整塊」「整個字是另一個字或自創字」才是 different。
格內完全沒有手寫筆跡（只有印刷）→ verdict="blank"。`

/** A 逐塊對照：把標準字拆成大部件、逐塊比對（＝現行 prompt 的角度） */
export function glyphPromptA(key, decomp) {
  const head = decomp
    ? `「${key}」的標準部件拆解（權威資料、請照這個拆解逐塊檢查、不要自行拆解）：${JSON.stringify(decomp)}
逐塊回答：學生在該位置寫的，大致上是這個部件嗎？`
    : `1. blocks：把「${key}」拆成最多 2~3 個大部件（左右或上下大塊），逐塊回答——學生在這個位置寫的，大致上是同一個東西嗎？`
  return `這是學生手寫的一個國字。標準答案是「${key}」。
${head}
${GLYPH_CRITERIA}
只輸出 JSON：{"blocks":"逐塊對照（60字內）","verdict":"same|different|blank","reason":"20字內結論"}`
}

/** B 先讀後認：先盲讀出學生寫的是哪個字，再比對標準答案（治「看到答案就往答案靠」的確認偏誤） */
export function glyphPromptB(key) {
  return `這是學生手寫的一個國字。
1. read：**先不要看下面的標準答案**，直接寫出你認為學生寫的是哪一個字（潦草就寫最接近的字；完全沒手寫就寫「無」）。
2. 寫完之後，再比對標準答案「${key}」——你讀出的字，跟「${key}」是同一個字嗎？
${GLYPH_CRITERIA}
只輸出 JSON：{"read":"你讀出的字","verdict":"same|different|blank","reason":"20字內結論"}`
}

/** C 整體輪廓：不拆部件、看整字外形與結構比例（第三個獨立角度；不是找碴者） */
export function glyphPromptC(key) {
  return `這是學生手寫的一個國字。標準答案是「${key}」。
不要逐筆畫或逐部件檢查。請用「整字輪廓」的層級判斷：
1. shape：描述學生寫的字的整體外形——左右結構還是上下結構？各部分的相對大小與位置？
2. 跟「${key}」的標準外形相比，這是同一個字嗎？
${GLYPH_CRITERIA}
⚠ 這一題的目的是確認，不是挑錯。輪廓與結構相符就回 same，不要因為筆畫細節不完美而判 different。
只輸出 JSON：{"shape":"整體輪廓描述（60字內）","verdict":"same|different|blank","reason":"20字內結論"}`
}

// ── 三判官 prompt（注音）────────────────────────────────────────────────
// 沿用 v2 的「送標準答案圖比對」形態（注音的參考圖是有效的、與字形不同）。
const ZY_CRITERIA = `⚠ 印刷題目的冒號「：」、頓號、標點都不是學生的筆畫——不要把它們當成輕聲點或調號。
判準：符號與聲調記號都與標準一致 → "same"；任一符號或聲調（含有無）不同 → "different"；
學生格內完全沒有手寫筆跡 → "blank"。`

/** A 逐符號對照（＝v2 的 pnA） */
export function zyPromptA(key) {
  return `這是「國字注音」題。第一張是【標準答案圖】（標準答案「${key}」）、第二張是【學生作答圖】。
你的任務是「比對」、不是辨認：
1. analysis：把標準「${key}」拆成注音符號＋聲調記號（一聲=無記號），逐一對照——標準圖有的符號/調號學生有沒有？學生有沒有標準圖上沒有的多餘筆畫？
${ZY_CRITERIA}
只輸出 JSON：{"analysis":"60字內","verdict":"same|different|blank","reason":"20字內"}`
}

/** B 形狀序列＋調號定位（＝v2 的 pnB） */
export function zyPromptB(key) {
  return `這是「國字注音」題。第一張是【標準答案圖】（標準答案「${key}」）、第二張是【學生作答圖】。
你的任務是「比對」：
1. analysis：由上而下列出學生實際手寫的每個注音符號、跟標準圖並排比形狀；再比調號——先定位「獨立的短斜筆/勾/點」有沒有，⚠不可把符號自身筆畫當調號。
${ZY_CRITERIA}
只輸出 JSON：{"analysis":"60字內","verdict":"same|different|blank","reason":"20字內"}`
}

/**
 * C 整體並排確認（取代 v2 的「找不同」）。
 * ⚠ v2 的 C 是對抗型（「你的任務是找不同」），實測 45 格裡 44 格為反而反（user 人工判讀）。
 *   v3 改成中性的第三個角度，並明示「目的是確認、不是挑錯」。
 */
export function zyPromptC(key) {
  return `這是「國字注音」題。第一張是【標準答案圖】（標準答案「${key}」）、第二張是【學生作答圖】。
請把兩張圖並排整體比對：
1. overall：學生寫的注音，整串看起來跟標準圖是同一串嗎？符號數量對得上嗎？調號位置對得上嗎？
${ZY_CRITERIA}
⚠ 這一題的目的是確認，不是挑錯。整串相符就回 same——字醜、大小不一、位置偏移、筆畫粗細都不算不同。
只輸出 JSON：{"overall":"整體比對（60字內）","verdict":"same|different|blank","reason":"20字內"}`
}
