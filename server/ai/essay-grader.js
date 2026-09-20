// 2026-09-19 作文批改（P3）：逐直行抄寫 → 逐句眉批＋四向度診斷 → 建議級分。
//   ⛔ 三段 prompt 皆逐字沿用已驗證的實驗腳本（redpenaisever/local-only/essay/）：
//      抄寫＝exp0 逐行臂（實驗0：整篇一次抄字錯率 4~24% 且漏行，逐行 1.2~2.1%、別字保留）
//      眉批＝exp2v3-feedback.mjs（實驗2 v3：掛向度＋會考規準用語＋程度詞，對官方樣卷說明召回 64~70%）
//      級分＝exp1b-judge.mjs A 臂（實驗1：通用規準即可，±1 命中 51/51；AI 起草的題目專屬判準會變差）
//   ⛔ 題目一律「送題本圖」不送文字（實驗4：級分 7/7 全對；AI 轉述圖意會失真、起草的詮釋範圍會讓給分偏高搖擺）
//   ⛔ 動這裡的 prompt 必須同步改 judge-verdict-cache.js 的 JUDGE_PROMPT_VERSIONS。
import { AI_ROUTE_KEYS } from './routes.js'

/** 會考寫作測驗六級分規準（內建、第一版固定；與 local-only/essay/rubric_generic.txt 同一份） */
export const CAP_RUBRIC = `【國中教育會考寫作測驗評分規準】
六級分：六級分的文章是優秀的，這種文章明顯具有下列特徵：
- 立意取材：能依據題目或寫作任務，適切地統整、運用材料，並能進一步闡述說明以凸顯主旨。
- 結構組織：文章結構完整，脈絡分明，內容前後連貫。
- 遣詞造句：能精確使用語詞，並有效運用各種句型使文句流暢。
- 錯別字、格式與標點符號：幾乎沒有錯別字，及格式、標點符號運用上的錯誤。
五級分：五級分的文章在一般水準之上，這種文章明顯具有下列特徵：
- 立意取材：能依據題目或寫作任務，適當地統整、運用材料，並能闡述說明主旨。
- 結構組織：文章結構完整，但偶有轉折不流暢之處。
- 遣詞造句：能正確使用語詞，並運用各種句型使文句通順。
- 錯別字、格式與標點符號：少有錯別字，及格式、標點符號運用上的錯誤，但並不影響文意的表達。
四級分：四級分的文章已達一般水準，這種文章明顯具有下列特徵：
- 立意取材：能依據題目或寫作任務，統整、運用材料，尚能闡述說明主旨。
- 結構組織：文章結構大致完整，但偶有不連貫、轉折不清之處。
- 遣詞造句：能正確使用語詞，文意表達尚稱清楚，但有時會出現冗詞贅句；句型較無變化。
- 錯別字、格式與標點符號：有一些錯別字，及格式、標點符號運用上的錯誤，但不至於造成理解上太大的困難。
三級分：三級分的文章在表達上是不充分的，這種文章明顯具有下列特徵：
- 立意取材：嘗試依據題目或寫作任務，統整、運用材料，但不甚適當，或發展不夠充分。
- 結構組織：文章結構鬆散；或前後不連貫。
- 遣詞造句：用字遣詞不太恰當，或出現錯誤；或冗詞贅句過多。
- 錯別字、格式與標點符號：有一些錯別字，及格式、標點符號運用上的錯誤，以致造成理解上的困難。
二級分：二級分的文章在表達上呈現嚴重的問題，這種文章明顯具有下列特徵：
- 立意取材：雖嘗試依據題目或寫作任務，統整、運用材料，但有所不足，或大量引述題幹內容，發展有限。
- 結構組織：文章結構不完整；或僅有單一段落，但可區分出結構。
- 遣詞造句：遣詞造句常有錯誤。
- 錯別字、格式與標點符號：不太能掌握格式，不太會使用標點符號，錯別字頗多。
一級分：一級分的文章在表達上呈現極嚴重的問題，這種文章明顯具有下列特徵：
- 立意取材：僅解釋題目或題幹內容；或雖提及主題，但材料過於簡略或無法選取相關材料加以發展。
- 結構組織：沒有明顯的文章結構；或僅有單一段落，且不能辨認出結構。
- 遣詞造句：用字遣詞極不恰當，頗多錯誤；或文句支離破碎，難以理解。
- 錯別字、格式與標點符號：不能掌握格式，不會運用標點符號，錯別字極多。
零級分：完全離題、只訂題目、僅抄寫題目或題幹內容、使用詩歌體、空白卷。`

/** 規準問題用語表（眉批與整篇診斷只能從這裡逐字挑） */
const RUBRIC_TERMS = `【規準問題用語表】（rubricTerm 只能從這裡逐字挑選）
- 立意取材：發展不夠充分｜材料不足或過於簡略｜取材不甚適當｜大量引述題幹｜未能闡述說明主旨
- 結構組織：轉折不清或不流暢｜前後不連貫｜結構鬆散｜結構不完整｜分段不當
- 遣詞造句：冗詞贅句｜敘寫口語｜用字遣詞不恰當或錯誤｜句型缺乏變化｜文句不通順
- 錯別字、格式與標點符號：標點符號運用錯誤｜格式錯誤｜錯別字`

export const ESSAY_TRANSCRIBE_GENERATION_CONFIG = {
  generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' }, mediaResolution: 'MEDIA_RESOLUTION_HIGH', maxOutputTokens: 8192 }
}
export const ESSAY_FEEDBACK_GENERATION_CONFIG = {
  generationConfig: { temperature: 0, maxOutputTokens: 16384 }
}
export const ESSAY_LEVEL_GENERATION_CONFIG = {
  generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' }, maxOutputTokens: 2048 }
}

/** 逐直行抄寫（實驗0 逐行臂原文；一次一行，圖＝該行裁圖含右側窄欄） */
export function buildEssayTranscribePrompt() {
  return `這是學生手寫作文稿紙的掃描圖，可能是整頁、也可能只是其中一部分；圖片可能有一張或多張，多張時依序為第一頁、第二頁。稿紙是直書：每一直行由上往下寫，直行與直行由右至左排列。你是抄寫員：把圖上學生手寫的字，依書寫順序忠實逐字抄出。

⛔⛔ 最重要的一條：**你不是在讀文章，你是在描圖。**
你的工作是把每一個格子裡的筆畫辨認成字，不是把這一行讀成通順的句子。
一格一格看，**不准用上下文去猜這一格「應該」是哪個字**。
・學生寫的詞如果是錯的（用錯字、同音字、成語寫錯），那就是他寫錯了——**照他寫的抄**。
  把錯的詞改成正確的寫法，是這份工作最嚴重的錯誤：老師就是要靠你的抄本抓錯別字，
  你一改，那個錯別字就永遠消失、沒有人會發現。
・只要你心裡冒出「這裡應該是○○才對」，那就是警訊：停下來只看筆畫，寫下你**看到**的那個字。
・看不出來就照規則 5 標記，不要用猜的把它補成一個通順的詞。

規則：
1. 一個直行輸出一筆，從最右邊的直行開始、往左依序；整行沒有任何手寫的直行略過不輸出。
2. 逐字照抄學生「實際寫的字」：學生寫了別字、錯字、注音、簡體字，都照他寫的抄，絕對不可以依文意改成正確的字。
   ⚠ 注音只有在**確定學生真的用注音符號拼字**時才抄（例如整個字寫成ㄅㄧㄠˇ）。潦草的行書、草寫漢字不要猜成注音——
   例如草寫的「了」很像「ㄋ」、刪除用的小勾很像「ㄥ」，這些都不是注音。
3. 被塗黑或劃掉的字不抄；寫在格線旁的插入字，依學生標示的位置插入。
   格子裡只有塗改記號、刪除線、小勾、點這類**不是字的筆畫** → 該格當成沒寫、不要抄任何東西。
4. 標點符號照抄；直行開頭的空格用全形空格「　」表示（空幾格就幾個）。
   ⭐ **直書的標點長相跟橫書不同，各佔一格，不要誤判**：
   ・引號「」『』在直書時是**上下的角狀short筆畫**——上引號在格子的右上、下引號在格子的左下。
     看到格子裡只有一個角狀或勾狀的短筆畫，**優先考慮是引號**，不要當成注音（ㄥ、ㄋ、乚）或罕用字。
   ・破折號──與刪節號……在直書時是**直的**，各佔兩格。
   ・句號。逗號，頓號、寫在格子的右上角。
   （實測：學生寫「夏日風鈴」，上引號被抄成罕用字、下引號被抄成注音ㄥ，還連累眉批去責備學生亂用符號。）
5. 某個字筆畫寫錯、不是任何一個正確的字 → 抄最接近的字並在後面加「〔?〕」；完全看不清 → 「?」。
6. 只抄手寫，不抄印刷文字。不要補字、不要刪字、不要潤飾。
7. 只輸出常用的繁體中文字與標點。**不要使用罕用字／異體字（Unicode 擴充區的冷僻字）**——
   認不出來就照規則 5 用「〔?〕」或「?」，硬湊一個沒人用的字反而讓老師看不懂。
8. **逐格輸出**：一個格子一個字，格與格之間用「｜」分隔。空格子也要輸出（寫成全形空格）。
   這是為了逼你一格一格地看——**不要先讀完整行再拆**，要一格一格辨認、一格一格寫下來。
只輸出 JSON：{"columns":["最右直行：字｜字｜字","下一直行：字｜字｜字"]}`
}

/**
 * 抄寫回覆 → 每一直行的文字（一次送 N 行就回 N 筆）。
 * ⛔ 回傳筆數不等於送出的行數時**不可以照位置硬對**：少一行會讓後面每一行整個位移，
 *   變成整篇錯位的靜默失效（N=23 實驗漏 12 行就是這樣崩的）。呼叫端要檢查長度並退回逐行重抄。
 */
export function parseEssayTranscribeColumns(text) {
  if (!text) return null
  try {
    const s = String(text).replace(/```json|```/g, '').trim()
    const o = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1))
    if (!Array.isArray(o?.columns)) return null
    // 逐格輸出用「｜」分隔（見 prompt 規則 8）→ 併回整行
    return o.columns.map((x) => sanitizeTranscript(String(x ?? '').split('｜').join('')))
  } catch { return null }
}

/**
 * 抄本淨化：把「國中生不可能寫出來的字」換成看不清標記。
 * ⛔ 只處理 **Unicode CJK 擴充區**（U+20000 以上）——那是 𡘓 𠃑 這類冷僻字，
 *   手寫作文絕不會出現，一定是 AI 認不出筆畫時硬湊的（實測：直書引號被湊成 𠃑）。
 *   ⚠ **不碰注音符號**：學生不會寫的字真的會寫注音，那是會考「錯別字、格式與標點」
 *     向度要抓的，濾掉會漏報。注音的誤判交給 prompt 規則處理。
 */
export function sanitizeTranscript(text) {
  return [...String(text ?? '')]
    .map((ch) => (ch.codePointAt(0) > 0x20000 ? '〔?〕' : ch))
    .join('')
}

/** 抄本（逐行）→ 分段文章：直行以全形空格開頭＝新段落 */
export function columnsToParagraphs(columns) {
  const paras = []
  for (const c of columns) {
    const s = String(c ?? '').replaceAll('〔?〕', '')
    const body = s.replace(/[\s　]/g, '')
    if (!body) continue
    if (/^[\s　]+/.test(s) || paras.length === 0) paras.push(body)
    else paras[paras.length - 1] += body
  }
  return paras
}

/** 逐句眉批＋四向度診斷（實驗2 v3 原文；題目以圖片附在後面） */
export function buildEssayFeedbackPrompt(paras, gradeLabel) {
  return `你是一位資深的國中國文老師，正在批改學生的作文。批改的目的是幫助學生精進寫作能力，所以重點不是打分數，而是「具體指出哪一句可以更好、建議怎麼改」。
作文內容是由手寫稿紙逐字抄錄的文字，錯別字已照學生原樣保留。
作文題目見附圖：請先閱讀圖中的題目、引導材料與圖片${gradeLabel ? `。學生是${gradeLabel}` : ''}。

${CAP_RUBRIC}
【學生作文】（每段前的 [n] 是段落編號，不是學生寫的）
${paras.map((p, i) => `[${i + 1}] ${p}`).join('\n')}

${RUBRIC_TERMS}

【請輸出以下回饋】
1. typos：文中的錯別字（學生寫成另一個字的「別字」、用錯的同音/形近字）。
   ⭐ **一律以「詞」為單位，不要只給單獨一個字**：把錯字連同相鄰的字一起組成至少 2 個字的詞（例：不要給「覆」，要給「重覆」→「重複」；不要給「拾」，要給「拾它」→「給它」）。
   單獨一個字看不出對錯，有詞才判斷得出來。就算組出來的不是辭典收錄的詞也沒關係，照給。
   wrong=學生寫的詞（逐字照抄，含錯字）、correct=正確的詞、context=包含該錯詞的原文片段（逐字照抄、6~12 字）。
   沒有就給空陣列。不要把口語用詞、標點問題列進來。
2. sentenceFeedback：挑出 4~6 個「最值得修改、對這位學生最有學習價值」的句子，給逐句眉批。
   - quote：原句，必須逐字出自作文（連錯字都照抄）、不超過 40 字。
   - dimension：立意取材｜結構組織｜遣詞造句｜錯別字、格式與標點符號 四選一。
   - rubricTerm：這句的問題屬於規準問題用語表中的哪一項（逐字挑選、須與 dimension 同一向度）。
   - problem：先具體描述這句話哪裡有問題，句尾再扣回規準用語，格式如：「連續使用口語問句（『是不是』、『你想看看』），使文章敘寫口語。」
   - suggestion：直接示範改寫後的句子。要保留學生原本的意思與國中生的語氣，不可替他加入新的內容或華麗詞藻。
   - why：一句話說明這樣改好在哪裡（學生看得懂的說法）。
3. paragraphFeedback：段落或全文結構層次的建議（例如某段與主旨無關、段落順序、開頭結尾呼應），每則指明 paragraph 編號；0~3 則，沒有就空陣列。
4. strengths：1~2 個寫得好的句子（quote 逐字）與原因——讓學生知道什麼該保留。
5. dimensionDiagnosis：四個向度各一筆「整篇」層次的診斷，語氣與用語比照會考閱卷說明。
   - terms：這篇文章在該向度「整體上」存在的問題，每項為 {"term":規準問題用語表逐字挑選,"severity":"偶有"|"明顯"|"嚴重"}。
   - 列入門檻：同類問題在文中出現兩處以上、或單一處已明顯影響閱讀，才算整篇層次的問題；只出現一次的小瑕疵放在 sentenceFeedback 就好，不要列進 terms。
   - 程度校準：「偶有」=零星出現、不影響理解（會考說明的『偶有』『稍嫌』）；「明顯」=多處出現、讀者會注意到；「嚴重」=已妨礙理解或貫穿全文。
   - 寫得好的文章多數向度本來就沒有整篇層次的問題：該向度沒有就給空陣列並在 comment 肯定其表現，不要為了挑毛病而挑。逐句眉批可以照給（好文章也能更好），但整篇診斷要克制。
   - comment：一句話說明。
6. summary：給學生的總評，80 字以內，先肯定再給最重要的一個努力方向。

只輸出 JSON：
{"typos":[{"wrong":"","correct":"","context":""}],"sentenceFeedback":[{"quote":"","dimension":"","rubricTerm":"","problem":"","suggestion":"","why":""}],"paragraphFeedback":[{"paragraph":1,"comment":""}],"strengths":[{"quote":"","why":""}],"dimensionDiagnosis":[{"name":"立意取材","terms":[{"term":"","severity":"偶有"}],"comment":""},{"name":"結構組織","terms":[],"comment":""},{"name":"遣詞造句","terms":[],"comment":""},{"name":"錯別字、格式與標點符號","terms":[],"comment":""}],"summary":""}`
}

/** 建議級分（實驗1b A 臂原文：只給通用規準；題目以圖片附在後面） */
export function buildEssayLevelPrompt(paras, chars) {
  return `你是國中教育會考寫作測驗的閱卷委員。請依評分依據，為下面這篇學生作文評定級分（0~6 的整數）。
作文內容是由手寫稿紙逐字抄錄的文字，錯別字已照學生原樣保留；抄錄過程可能有極少數漏字或多字，請勿因此扣分。
作文題目見附圖：請先閱讀圖中的題目、引導材料與圖片。

${CAP_RUBRIC}
【評分方式】
會考寫作是整體式評分：綜合四個向度判斷文章整體落在哪一個級分，不是四個向度的平均；立意取材與結構組織是主要依據。
先逐向度判斷（各給 1~6 的整數，並引用作文原句為證；引用必須逐字出自作文、每則 30 字以內），再給整體級分。

【受評作文】（共 ${chars} 字、${paras.length} 段）
${paras.join('\n')}

只輸出 JSON：
{"dimensions":[{"name":"立意取材","level":0,"comment":"...","quotes":["..."]},{"name":"結構組織","level":0,"comment":"...","quotes":["..."]},{"name":"遣詞造句","level":0,"comment":"...","quotes":["..."]},{"name":"錯別字、格式與標點符號","level":0,"comment":"...","quotes":["..."]}],"overall":0,"reason":"..."}`
}

export function parseJsonLoose(text) {
  if (!text) return null
  try {
    const s = String(text).replace(/```json|```/g, '').trim()
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    return JSON.parse(s.slice(a, b + 1))
  } catch { return null }
}

const flat = (s) => String(s ?? '').replace(/[\s　]/g, '').replaceAll('〔?〕', '')

/**
 * 引用句 code 驗證＋定位：引用必須逐字出自抄本，否則視為判官幻覺（標 false）。
 * 回 {ok, page, col} —— col 供複核 UI 與檢討單把眉批對回原卷的直行。
 */
/**
 * 全文攤平成一串字，並記下每個字落在「第幾頁第幾行第幾格」。
 * ⚠ 格位要用**原始文字**的索引算：稿紙一格一字，**開頭空兩格也佔兩格**，
 *   用 flat() 之後的索引會整行位移兩格（裁圖就會裁錯字）。
 */
function flattenWithCells(columns) {
  let text = ''
  const map = []
  for (const c of columns) {
    const raw = String(c.text ?? '')
    for (let r = 0; r < raw.length; r++) {
      const ch = raw[r]
      if (/[\s　]/.test(ch)) continue          // 空格佔格但不是字，不進搜尋字串
      map.push({ page: c.page, col: c.col, row: r + 1 })  // row 1-based＝該行第幾格
      text += ch
    }
  }
  return { text, map }
}

export function locateQuote(columns, quote) {
  const q = flat(quote)
  if (!q) return { ok: false }
  const { text, map } = flattenWithCells(columns)
  const i = text.indexOf(q)
  if (i < 0) return { ok: false }
  const a = map[i]
  const z = map[i + q.length - 1]
  return { ok: true, page: a.page, col: a.col, row: a.row, toCol: z.col, toRow: z.row }
}

/**
 * 錯別字的精確格位：先用 context 定位（單字如「的」滿篇都是、只靠 wrong 會定錯），
 * 再在 context 裡找 wrong 的偏移量。
 * @returns {{ok:boolean, page?:number, col?:number, row?:number, toCol?:number, toRow?:number}}
 */
export function locateTypoCell(columns, context, wrong) {
  const w = flat(wrong)
  if (!w) return { ok: false }
  const { text, map } = flattenWithCells(columns)
  const ctx = flat(context)
  let i = -1
  if (ctx) {
    const ci = text.indexOf(ctx)
    if (ci >= 0) {
      const off = ctx.indexOf(w)
      if (off >= 0) i = ci + off
    }
  }
  if (i < 0) i = text.indexOf(w)   // 沒有 context 或對不上 → 退而求其次
  if (i < 0) return { ok: false }
  const a = map[i]
  const z = map[i + w.length - 1]
  return { ok: true, page: a.page, col: a.col, row: a.row, toCol: z.col, toRow: z.row }
}

/** 零 AI 閘門：空白卷／字數過少／與題幹高度重疊（抄題幹）→ 不送眉批、直接給候選級分 */
export function essayZeroAiGate(columns, opts = {}) {
  const chars = columns.reduce((n, c) => n + flat(c.text).length, 0)
  if (chars === 0) return { level: 0, reason: '空白卷：整份稿紙沒有任何手寫內容' }
  const minChars = opts.minChars ?? 30
  if (chars < minChars) return { level: 1, reason: `內容過少（僅 ${chars} 字）：無法判斷各項能力` }
  return null
}

export const ESSAY_ROUTES = {
  transcribe: AI_ROUTE_KEYS.GRADING_ESSAY_TRANSCRIBE,
  feedback: AI_ROUTE_KEYS.GRADING_ESSAY_FEEDBACK,
  level: AI_ROUTE_KEYS.GRADING_ESSAY_LEVEL,
}
