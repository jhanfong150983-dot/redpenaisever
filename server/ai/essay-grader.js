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
    .map((ch) => {
      if (ch.codePointAt(0) > 0x20000) return '〔?〕'
      const mapped = SYMBOL_FIX.get(ch)
      if (mapped) return mapped
      return isGarbageSymbol(ch) ? '?' : ch
    })
    .join('')
}

/**
 * 直書引號被 AI 湊成的「角狀符號」→ 換回引號（2026-09-21，user 逐格人工判讀後拍板用 code 正規化）。
 *   直書的上引號﹁在格子右上、下引號﹂在左下，AI 認不出來時會挑一個形狀最像的框線字元。
 *   ⛔ 這張表**只收有人工判讀證據、而且 100% 一致的**：
 *     」← └(4/4) 乚(2/2) ┘ ᄂ ∟（後三個是 09-20 第一輪判讀：┌叮鈴┘＝「叮鈴」、ᄂ＝」、「綠能」被抄成 一綠能∟）
 *     「← ┐(3/3) ⌝(1/1) ┌
 *     ，← 半形逗號 ,(2/2)
 *   可以放心轉的理由：沒有學生會在作文裡寫框線字元，這些一定是 AI 湊的，轉換不會蓋掉學生真實的錯誤
 *   （跟簡體字不同——學生真的可能寫簡體，所以那個只偵測不轉）。
 *   ⚠ 這只救得了一部分：上引號也會被讀成**正常漢字**（實例：原稿「頭﹂與﹁小」→ 抄本「頭乚喫了小」，﹁→了），那種 code 救不了。
 */
const SYMBOL_FIX = new Map([
  ...[...'└乚┘ᄂ∟'].map((c) => [c, '」']),
  ...[...'┐⌝┌'].map((c) => [c, '「']),
  [',', '，'],
])

/**
 * 「一定是 AI 硬湊、但猜不出原本是什麼」的符號 → 換成看不清標記「?」（抄寫規則 5 本來就有的標記，一樣佔一格）。
 *   ⛔ 不可以照形狀去猜：人工判讀裡 冖＝冒號（我照形狀猜是上引號，猜錯）、ノ＝逗號、α＝句號，各不相同。
 *   換成「?」至少不會讓眉批去責備學生亂用符號。
 *   ⛔ 不碰注音（學生真的會寫）、不碰英數（作文裡會出現）、不碰破折號類（— ─ ― 都可能是合法的破折號）。
 */
const STROKE_HAN = new Set([...'冖乛亅丨丿乀乁亠凵匚匸勹厶'])
function isGarbageSymbol(ch) {
  if (STROKE_HAN.has(ch)) return true
  const cp = ch.codePointAt(0)
  // ⛔ U+2500~2503（─ ━ │ ┃）要放行：抄寫 prompt 規則 4 自己就教模型用「──」寫破折號，直書時還可能是直的
  return (cp >= 0x2504 && cp <= 0x257f)      // 其餘框線字元
    || (cp >= 0x2300 && cp <= 0x23ff)        // 技術符號（⌞ ⌜ 之類）
    || (cp >= 0x30a0 && cp <= 0x30ff)        // 片假名（ノ）
    || (cp >= 0x3040 && cp <= 0x309f)        // 平假名
    || (cp >= 0x0370 && cp <= 0x03ff)        // 希臘字母（α）
    || (cp >= 0x1100 && cp <= 0x11ff)        // 韓文字母
    || (cp >= 0x3130 && cp <= 0x318f)        // 韓文相容字母
    || (cp >= 0xac00 && cp <= 0xd7af)        // 韓文音節
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
/**
 * @param {object} [gsatRubric] 學測國寫的每卷專屬評分原則（essay.items[].rubric）。
 *   ⛔ 不給＝會考，輸出必須與過去**逐字元相同**（local-only/essay/_cap_prompt_hashes.json 有凍結的雜湊可比對）。
 *   給了＝學測：只換「老師的學段」與「評分依據」兩處，眉批的向度與規準用語表沿用（那是通用的寫作診斷語彙，
 *   也是檢討模式分組的依據）。
 */
export function buildEssayFeedbackPrompt(paras, gradeLabel, gsatRubric) {
  const stage = gsatRubric ? '高中' : '國中'
  const rubricBlock = gsatRubric ? formatGsatRubric(gsatRubric) : CAP_RUBRIC
  return `你是一位資深的${stage}國文老師，正在批改學生的作文。批改的目的是幫助學生精進寫作能力，所以重點不是打分數，而是「具體指出哪一句可以更好、建議怎麼改」。
作文內容是由手寫稿紙逐字抄錄的文字，錯別字已照學生原樣保留。
作文題目見附圖：請先閱讀圖中的題目、引導材料與圖片${gradeLabel ? `。學生是${gradeLabel}` : ''}。

${rubricBlock}
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
   - suggestion：直接示範改寫後的句子。要保留學生原本的意思與${stage}生的語氣，不可替他加入新的內容或華麗詞藻。
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

// ═══ 學測國寫（format:'gsat'）的等第判官 ═════════════════════════════════════
// 與會考的差別：①規準是**每份卷專屬**的（官方評分原則的「作答情形」逐級描述了這一題要寫到什麼），
//   建卷時由 AI 起草、老師修改，存在 generated_sheet.essay.items[].rubric；
//   ②輸出是六等第 A+／A／B+／B／C+／C（＋0），不是 1~6 級分。層數相同 → 內部沿用 0~6 的 level，只換顯示標籤。
// 2026-09-21 實驗（115 第二大題、6 份官方佳作＋反向對照，local-only/essay/_gsat_level_exp.mjs）：
//   佳作 6/6 判 A+；截斷成 251／95 字 → C+；別題的會考作文 3 篇 → 0、0、C。
//   那個 C 的判官理由明明寫「嚴重離題」卻沒給 0 → 加 onTopic 欄位、由 code 定 0（分類交給明確欄位，不靠判官自己換算）。
//   ⚠ 真值只有佳作：高分端與方向性驗過，B／C 之間的刻度**沒有驗證**。

/** level(0~6) ↔ 學測等第 */
export const GSAT_GRADES = ['0', 'C', 'C+', 'B', 'B+', 'A', 'A+']

// 2026-09-22 user 拍板：學測**以分數計、不以等第計**（知性題 25＝(一)4＋(二)21、情意題 25，方便老師事後加減分）。
//   判官仍判等第（14/14 驗證過的那一步），程式再對到官方分數帶的**中間值**；等第只當參考顯示。
//   官方分數帶（115 評分原則）：情意題 A+25-22／A21-18／B+17-14／B13-10／C+9-6／C5-1；
//   知性題(二) A+21-19／A18-15／B+14-12／B11-8／C+7-5／C4-1；知性題(一) A4-3／B2／C1。
//   index 對齊 GSAT_GRADES：[0, C, C+, B, B+, A, A+]
export const GSAT_ITEM_KINDS = {
  affective: { label: '情意題', maxScore: 25, scores: [0, 3, 8, 12, 16, 20, 24] },
  expository2: { label: '知性題(二)', maxScore: 21, scores: [0, 3, 6, 10, 13, 17, 20] },
  // (一) 只有 A／B／C 三級：C+→C、B+→B、A+→A
  expository1: { label: '知性題(一)', maxScore: 4, scores: [0, 1, 1, 2, 2, 4, 4] },
}
/** 學測寫作題的種類（essay.items[0].kind）；沒填＝情意題（第一期只開這一種） */
export function essayGsatItemKind(layout) {
  const k = layout?.essay?.items?.[0]?.kind
  return GSAT_ITEM_KINDS[k] ? k : 'affective'
}
/** 等第 index（0~6）→ 分數 */
export function gsatScoreOf(levelIdx, kind = 'affective') {
  const t = GSAT_ITEM_KINDS[kind] ?? GSAT_ITEM_KINDS.affective
  const i = Math.min(6, Math.max(0, Number(levelIdx) || 0))
  return t.scores[i]
}

/**
 * 學測國寫的**通用**六等第階梯——固定寫死，地位等同會考的 CAP_RUBRIC；老師不必經手。
 *
 * 官方評分原則其實是兩層：跟題目有關的只有中間那一句（這一題要寫什麼），
 *   程度階梯（具體／明確／大致／簡略／稍能觸及）與結構、文辭用語是固定的（115 的兩張表用同一套）。
 *   這裡留下固定那層，「本題的寫作要求」讓判官自己從題目圖讀——跟會考判官的做法一致。
 * 2026-09-21 實測（user 問「不能像會考一樣直接用嗎」→ 同一批 14 個案例對比，local-only/essay/_gsat_generic_rubric.mjs）：
 *   通用階梯 14/14 符合預期、每卷專屬規準（115 官方原文）13/14；
 *   判官自己從題目圖讀出的要求＝「隔閡的原因｜看待心結與換位思考｜提出回應」，與官方列的三項一致；
 *   離題的那篇（皮影戲）專屬版放水給 C+、通用版正確給 0。→ **不需要每卷專屬規準、建卷不必多一步。**
 */
export const GSAT_GENERIC_RUBRIC = {
  bands: [
    ['A+', '能具體而深入地完成本題的寫作要求，內容切合題旨。結構嚴謹，文辭暢達。'],
    ['A', '能明確完成本題的寫作要求，內容切合題旨。結構完整，文辭流暢。'],
    ['B+', '能大致完成本題的寫作要求。結構適當，文辭通順。'],
    ['B', '能簡略完成本題的寫作要求，唯想法較為粗淺，或僅泛論。結構尚可，文辭平順。'],
    ['C+', '稍能觸及本題的寫作要求，然內容空洞，結構鬆散，文辭欠通順。'],
    ['C', '敘寫雜亂，文句不通。'],
    ['0', '空白卷、文不對題，或僅抄錄題幹、題目。'],
  ],
}

/**
 * 版面資料 → 這份卷要用的學測評分原則。不是學測（沒有明確的 format:'gsat'）→ null＝走會考判官。
 *   學測預設用內建的通用階梯；items[0].rubric 有填才覆蓋（保留給日後第一大題那種有標準答案的知性題）。
 */
export function essayGsatRubricOf(layout) {
  const g = layout?.essay
  if (g?.format !== 'gsat') return null
  const r = g.items?.[0]?.rubric
  return r && Array.isArray(r.bands) && r.bands.length ? r : GSAT_GENERIC_RUBRIC
}

function formatGsatRubric(rubric) {
  const bands = (rubric.bands ?? []).map((b) => `${String(b[0]).padEnd(2)}：${b[1]}`).join('\n')
  return `【本題評分原則】（學科能力測驗・國語文寫作能力測驗${rubric.title ? `；本題題目「${rubric.title}」` : ''}）
${bands}`
}

export function buildGsatLevelPrompt(rubric, paras, chars) {
  const elements = Array.isArray(rubric.elements) ? rubric.elements.filter(Boolean) : []
  return `你是大學入學考試中心「學科能力測驗・國語文寫作能力測驗」的閱卷委員。請依本題的評分原則，為下面這篇考生作答評定等第。
作答內容是由手寫答題卷逐字抄錄的文字，錯別字已照考生原樣保留；抄錄過程可能有極少數漏字或多字，請勿因此降等。
試題見附圖：請先閱讀圖中的題目、引導文字與圖片。

${formatGsatRubric(rubric)}

【評分方式】（依大考中心閱卷程序）
1. 先判斷這篇作答**是不是在寫本題**（onTopic）。寫的不是本題要求的內容、空白、或僅抄錄題目 → onTopic 填 false。
2. ${elements.length ? `逐項檢核本題要求的內容有沒有寫到、寫到什麼程度，並引用作答原句為證（逐字引用、每則 30 字以內）：\n${elements.map((e, i) => `   ${i + 1}) ${e}`).join('\n')}` : '檢核本題要求的內容有沒有寫到、寫到什麼程度，並引用作答原句為證（逐字引用、每則 30 字以內）。'}
3. 再看結構與文辭。
4. 先判定屬於 A、B、C 哪一等，再依表現高下決定是原級還是＋級。
5. 錯別字與標點只在**明顯偏多**時才影響等第；零星錯字不降等。
6. 依作答**實際寫出來的內容**評定：文章沒寫完、內容單薄，就照評分原則給對應的等第，不要因為開頭寫得好就推測後面也好。

【受評作答】（共 ${chars} 字、${paras.length} 段）
${paras.join('\n')}

只輸出 JSON：
{"onTopic":true,"elements":[{"name":"...","degree":"具體|明確|大致|簡略|稍觸及|未觸及","quote":"..."}],"structure":"...","diction":"...","band":"A|B|C|0","grade":"A+|A|B+|B|C+|C|0","reason":"..."}`
}

/**
 * 判官回覆 → 管線通用的 level 形狀（overall 0~6／reason／dimensions），外加 grade 與 onTopic。
 * ⛔ 離題一律 0：由 code 依 onTopic 決定，不看判官自己填的 grade
 *   （實測判官會寫「嚴重離題，故評為 C 等」——理由對、換算錯）。
 */
export function normalizeGsatLevel(json) {
  if (!json || typeof json !== 'object') return null
  const onTopic = json.onTopic !== false
  const idx = GSAT_GRADES.indexOf(String(json.grade ?? '').trim().toUpperCase())
  const overall = !onTopic ? 0 : idx >= 0 ? idx : null
  const dims = (Array.isArray(json.elements) ? json.elements : []).map((e) => ({
    name: String(e?.name ?? ''),
    comment: String(e?.degree ?? ''),
    quotes: e?.quote ? [String(e.quote)] : [],
  }))
  for (const [name, v] of [['結構', json.structure], ['文辭', json.diction]]) {
    if (v) dims.push({ name, comment: String(v), quotes: [] })
  }
  return { overall, grade: overall == null ? null : GSAT_GRADES[overall], onTopic, reason: String(json.reason ?? ''), dimensions: dims }
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
