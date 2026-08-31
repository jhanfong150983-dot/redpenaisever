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
// 【決策規則】v3 精簡版（2026-08-31 user 拍板）——兩條：
//   1. **前兩票一致 → 定案、不跑第三票**（same 97／different・blank 80）
//   2. 前兩票不一致 → 跑第三票（仲裁者）決勝；結果是 same 才 65（進複核），其餘 80
//      ・same+different / same+blank → 取 C 站的那邊
//      ・different+blank → C 說 blank 判 blank，否則 different（兩票都認為「非正解」，
//        不讓唯一一張 same 票翻盤成放水）
//
// ⭐ 為什麼砍掉「same,same 也要跑第三票」（原 v3 的 rule 2）：
//   實測 35 格 A、B 都判 same 的格，**C 反對 0 格**（國字 18/0、注音 17/0）——
//   因為 C 被設計成「乾淨的確認者」，前兩票說對它必然跟著說對。
//   它連設計目的都沒達成：那格真放水（pmview 1-1-8）C 也說 same。
//   全庫佐證：字形舊 prompt 280 格 same,same,different **= 0 格**（三票同一 prompt、本來就不獨立）。
//   砍掉後：判定 0 格改變、進複核 0 格減少（本次 4 格進複核全來自規則 2 的決勝路徑）、
//   呼叫數 139→104（比現行 130 還少 20%）。
//
// ⭐ 第三票的角色因此改變 → 改用「仲裁者」（arbiterPrompt）：
//   它只在 A、B 打平時出場，面對的是兩個互相矛盾的意見、不是一個既成共識，
//   所以「為反而反」的舞台已經消失。仲裁者拿到雙方**觀察內容**（analysis/blocks，不是 reason）、
//   但**不給判決、不標明誰是誰**——避免它被寫得比較具體的一方說服而不是被圖說服
//   （同一個家族的鐵則：不可給 read1 答案）。決勝票採從嚴設計，符合「寧可誤殺、不可放水」。
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

  // 規則 1：前兩票一致 → 定案，不跑第三票（same 也一樣，實測 C 反對 0/35）
  if (a === b) {
    return a === 'same'
      ? { verdict: 'same', confidence: 97, needsThird: false, reason: '兩票一致放行' }
      : { verdict: a, confidence: 80, needsThird: false, reason: a === 'blank' ? '兩票一致未作答' : '兩票一致判錯' }
  }
  // 規則 2：前兩票不一致 → 仲裁者決勝
  if (!valid(c)) return { verdict: 'different', confidence: 80, needsThird: true, reason: '兩票分歧、仲裁失敗（從嚴）' }
  const pair = [a, b]
  const verdict = (pair.includes('different') && pair.includes('blank'))
    ? (c === 'blank' ? 'blank' : 'different')   // 兩票都認為非正解 → 不讓單張 same 翻盤
    : c                                          // same+different / same+blank → 取 C 站的那邊
  return verdict === 'same'
    ? { verdict, confidence: 65, needsThird: true, reason: '兩票分歧、仲裁判對——請確認是否放水' }
    : { verdict, confidence: 80, needsThird: true, reason: '兩票分歧、仲裁判錯' }
}

/** 前兩票是否需要跑第三票（呼叫端據此決定要不要付第三次的錢）——只有打平才需要 */
export function needsThirdVote(a, b) {
  const valid = (v) => v === 'same' || v === 'different' || v === 'blank'
  if (!valid(a) || !valid(b)) return true
  return a !== b
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

/**
 * B 先讀後認：先盲讀出學生寫的是哪個字，再比對標準答案（治「看到答案就往答案靠」的確認偏誤）。
 * ⚠ 2026-08-31：`read` 只有一個字，仲裁者拿不到可驗證的指控 → 補 `analysis`
 *   （user 指出「A、B 不輸出完整理由，仲裁者也沒有用」）。
 */
export function glyphPromptB(key) {
  return `這是學生手寫的一個國字。
1. read：**先不要看下面的標準答案**，直接寫出你認為學生寫的是哪一個字（潦草就寫最接近的字；完全沒手寫就寫「無」）。
2. analysis：說明你為什麼讀成這個字——你看到哪些部件、它們的位置關係如何。
3. 寫完之後，再比對標準答案「${key}」——你讀出的字，跟「${key}」是同一個字嗎？
${GLYPH_CRITERIA}
只輸出 JSON：{"read":"你讀出的字","analysis":"判讀依據（60字內）","verdict":"same|different|blank","reason":"20字內結論"}`
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

// ── 仲裁者 C（v3 精簡版的第三票；只在 A、B 打平時出場）─────────────────────
//
// 【為什麼是仲裁者不是第三個角度】user 2026-08-31：「C 已經沒有為反而反的能力了，
//   因為我們現在只把 C 放在 A、B 打平，所以他也不知道誰對誰錯。」
//   平手時 C 面對的是兩個互相矛盾的意見，不是一個既成共識 → 對抗／確認的軸線失效，
//   真正有用的是「把爭點拿到圖上驗證」。
//
// 【三個設計約束】
//   ① 給**觀察內容**（analysis／blocks／read）、不給 reason——reason 只有 20 字又被 DB 截成 30 字，
//      餵過去等於沒給（user 指出）。
//   ② **不給判決、不標明誰是誰**——否則 C 會被「寫得比較具體的一方」說服而不是被圖說服。
//      指控天生比背書具體（「下半部寫成糸」vs「結構相符」），洩漏判決＝系統性偏向指控方。
//      同一個家族的鐵則：不可給 read1 答案（見 project_read1_sentence_antifragment）。
//   ③ **從嚴**：指控要被主動推翻才放行 → 符合「寧可誤殺、不可放水」（決勝票偏誤殺方向）。
//
// 【骨架共用、判準各自】user 問「國字能不能直接用注音測完的 C」——骨架可以，判準不行：
//   注音要求完全一致（少一符號就錯），國字明示放行微筆畫（多一點少一橫都算對，
//   這是當初實測誤殺 0/48 換來的校準）。把注音判準帶進國字會整個推翻它。
const ARBITER_CLAIMS = {
  // 2026-08-31 沙盒 17 格 user 逐格判讀後補：兩個瑕疵格（0k1lpg／h81yzo）病根相同、方向相反——
  //   仲裁者跳過了「先指認這一筆是什麼」這一步。0k1lpg 把認不出的點記當成學生多寫（誤殺）、
  //   h81yzo 把認得出的 ˇ 當成打勾忽略（放水）。故不加「批改痕跡不算數」條款（那只會放大 h81yzo），
  //   改成「指認在先、才決定算不算」的雙向條款。
  //   ⭐「注音中不會出現打勾」是 user 提供的硬事實，可以寫死。
  zhuyin: `【算數的指控】少寫或多寫某個注音符號、符號認錯（例：ㄨ 寫成 ㄩ）、聲調記號有無或寫錯。
【不算數的指控】字醜、筆畫粗細、大小不一、位置偏移、書寫潦草。
⚠ 指認在先：只有你能**明確指認**成「某個注音符號」或「四個調號之一（ˊ ˇ ˋ ˙）」的筆畫才算數。
   認不出是什麼的點、線、污漬、印刷噪點 → **不構成「多寫」指控**，忽略它、不要據此判 different。
⚠ 反過來，能明確認出是「ˇ」的，它就是**三聲調號**——注音裡不會出現打勾，
   不可把 ˇ 當成老師的批改記號而忽略掉。
⚠ 印刷題目的冒號「：」、頓號、標點都不是學生的筆畫。`,
  glyph: `【算數的指控】某一大塊寫成別的東西、缺了一整塊、整個字是另一個字或自創字。
【不算數的指控】字醜、潦草、多一點、少一橫、內部細節模糊——這些老師改考卷都算對。`,
}

/**
 * 仲裁者 prompt。
 * @param {'zhuyin'|'glyph'} kind 題型（決定判準與是否附標準答案圖）
 * @param {string} key 標準答案
 * @param {string} obsA 判官 A 的觀察內容（analysis／blocks），**不含 verdict**
 * @param {string} obsB 判官 B 的觀察內容（analysis／read+analysis），**不含 verdict**
 */
export function arbiterPrompt(kind, key, obsA, obsB) {
  const isZy = kind === 'zhuyin'
  const head = isZy
    ? `這是「國字注音」題。第一張是【標準答案圖】（標準答案「${key}」）、第二張是【學生作答圖】。`
    : `這是學生手寫的一個國字。標準答案是「${key}」。`
  return `${head}

前兩位判官對這一格的看法不同。以下是他們各自的觀察——**不會告訴你他們的結論，也不會告訴你哪一段是誰寫的**：
【觀察一】${obsA || '（無內容）'}
【觀察二】${obsB || '（無內容）'}

你的任務**不是選邊站**，是把這兩段觀察裡的「具體指控」拿到圖上逐條驗證。
${ARBITER_CLAIMS[isZy ? 'zhuyin' : 'glyph']}

1. checks：逐條列出你看到的具體指控，並回答「這條在圖上成立嗎」。
2. verdict：
   ・任何一條**算數的指控**經你確認屬實 → "different"
   ・所有具體指控都不成立、或只剩不算數的那類 → "same"
   ・學生格內完全沒有手寫筆跡 → "blank"

⚠ 你是最後一票，判斷不出來時從嚴（寧可判 different 讓學生申訴，不可放水）。
只輸出 JSON：{"checks":"逐條驗證（80字內）","verdict":"same|different|blank","reason":"20字內結論"}`
}

/** 從判官回應取出「給仲裁者看的觀察內容」（不含 verdict／reason） */
export function observationOf(parsed) {
  if (!parsed) return ''
  const bits = [parsed.analysis, parsed.blocks, parsed.shape, parsed.overall].filter(Boolean)
  if (parsed.read) bits.unshift(`讀成「${parsed.read}」`)
  return bits.join('；').slice(0, 300)
}
