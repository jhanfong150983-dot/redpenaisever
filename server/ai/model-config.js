/**
 * model-config.js — 2026-05-21 model 分流配置中央化
 *
 * 設計原則：
 *   1. 只 2 個 env var：MODEL_PRO / MODEL_FLASH（換 model 時改這 2 個即可）
 *   2. 每個 stage 用哪個 tier 寫死在 code（產品決策、進 PR review）
 *   3. 透過 STAGE_MODEL[routeKey] 統一查詢、不再散在各檔
 *
 * Tier 分類邏輯：
 *   - PRO   = 視覺定位 / OCR 類 stage（容錯低、改錯一個 token 全套錯）
 *   - FLASH = 純文字 / 邏輯 / 報表類 stage（小 model 夠用、便宜 20 倍）
 *
 * 切換時機（A/B test 完成後動 code）：
 *   - READ 系列 2026-05-21 已切到 FLASH（user 決定不 A/B、pro 3.1 + AI2 校對 prompt 偶發整份判 blank）
 *
 * fallback chain：
 *   - PRO 503 overload → 自動 fallback 到 FLASH → 再 fallback 到 hardcoded
 */

import { AI_ROUTE_KEYS } from './routes.js'

// 2026-07-22 全套 3.5→3.6（user 拍板）：四路由沙盒＝read 100%(3.5=94%)+輸出側帳單-42%、
//   classify 在偷懶案例框貼手寫(3.5 框壓印刷字、眼球裁決)、extract 單題 2/5 題型翻動(微退可接受)、
//   注音判官誤殺 2→3(邊界字跡、放水維持 0、寧殺勿放可接受)。回退=env MODEL_PRO 設回 3.5。
export const MODEL_PRO = process.env.MODEL_PRO || 'gemini-3.6-flash'
export const MODEL_FLASH = process.env.MODEL_FLASH || 'gemini-2.5-flash'

// 2026-08-04 判官家族 pin 3.5（user 拍板）：B班國語 A/B 實錘（exp-judge-35v36、61 格×2 model×2 輪）
//   3.6 判官＝丟零星 d 票被「一票殺」放大成誤殺（翻盤格同 7 月 13/29）、兩輪自翻 3/29、
//   格外作答判 blank（3.5 看得到）；3.5＝全 61 格兩輪零翻動、同 7 月 23/29、
//   真錯誤 19/20 照殺（放水零代價）、且單價便宜 5 倍。一票殺規則本來就是在 3.5 票行為上校準的（V11）。
//   範圍＝判官家族 6 個 call site（與 JUDGE_HIGHRES 同組），classify/read/extract 維持 MODEL_PRO 3.6。
export const JUDGE_MODEL = process.env.JUDGE_MODEL || 'gemini-3.5-flash'

// 2026-06-30：移除降階換模型（FALLBACK_CHAIN 清空）。
//   決策：批改要「跨次精準度一致」，降階到不同 model 會產生不同結果 → 違反目標。
//   503/504/429/網路斷線一律「同模型退避重試」(model-adapter)，不切換到別的 model。
//   （要恢復降階：填回 [MODEL_FLASH, 'gemini-3-flash-preview'] 之類。）
export const FALLBACK_CHAIN = []

/**
 * stage → model 對應表
 * key 是 AI_ROUTE_KEYS 裡的 routeKey
 */
export const STAGE_MODEL = Object.freeze({
  // ──────────────────────────────────────────────────
  // 🔴 視覺定位 / OCR — 用 PRO
  // ──────────────────────────────────────────────────
  [AI_ROUTE_KEYS.GRADING_CLASSIFY]: MODEL_PRO,         // Phase A1 切題 bbox
  [AI_ROUTE_KEYS.GRADING_PHASE_A_CLASSIFY]: MODEL_PRO, // 同 GRADING_CLASSIFY
  // ⚠️ 2026-05-21: READ 系列從 PRO 切到 FLASH（user 不 A/B 直接換）
  // 原因：MODEL_PRO=gemini-3.1-pro-preview + AI2 校對 prompt 偶發整份判 blank
  //   (社會期中考實證 3/9 submission 重症：80%+ AI2 blank、AI1 同樣 crop 卻 read 到答案)
  // FLASH 沒這個化學反應、且便宜 ~20x
  [AI_ROUTE_KEYS.GRADING_READ_ANSWER]: MODEL_FLASH,    // Phase A2 學生答案 OCR
  [AI_ROUTE_KEYS.GRADING_DETAIL_READ]: MODEL_FLASH,    // AI1 細讀（含 crop 圖）
  [AI_ROUTE_KEYS.GRADING_RE_READ_ANSWER]: MODEL_FLASH, // AI2 校對 re-read
  [AI_ROUTE_KEYS.GRADING_PHASE_A_READ]: MODEL_FLASH,   // 同 read
  [AI_ROUTE_KEYS.GRADING_RECHECK]: MODEL_PRO,          // 學生訂正重批（含 OCR、保留 PRO）
  [AI_ROUTE_KEYS.ANSWER_KEY_LOCATE]: MODEL_PRO,        // 答案卷 bbox 定位（同 classify 性質）
  // ── VJ 視覺判斷題（diagram_color / map_symbol / grid_geometry）：全 PRO ──
  // 2026-05-30 實測：flash 連 blank 偵測都不安全（真空白幻覺出筆跡）；PRO blank 100% 穩定。
  // grade 判對錯更需強模型。三階段都 PRO。成本框在 VJ 題（每題每生 blank×1 + grade×1 = 2 個 PRO call）。
  [AI_ROUTE_KEYS.GRADING_VJ_RUBRIC]: MODEL_PRO,        // A0 答案卷 → vjRubric
  [AI_ROUTE_KEYS.GRADING_VJ_BLANK]: MODEL_PRO,         // Phase A 單一 blank reader
  [AI_ROUTE_KEYS.GRADING_VJ_GRADE]: MODEL_PRO,         // Phase B rubric 判對錯
  [AI_ROUTE_KEYS.GRADING_LEVEL_JUDGE]: MODEL_PRO,      // 級分制判官（讀手寫推導、需 PRO 視覺）
  [AI_ROUTE_KEYS.GRADING_RUBRIC_JUDGE]: MODEL_PRO,     // rubric 判官（社會/自然看圖逐維度判分）
  // 2026-05-23: 紙張四角偵測切到 FLASH
  // 原因：(1) 老師端 AssignmentImport 已 skip、只剩學生拍照觸發
  //       (2) 找白色矩形邊緣是相對簡單視覺任務、FLASH 夠用
  //       (3) PRO 對學生上傳量太貴、不划算
  [AI_ROUTE_KEYS.PERSPECTIVE_DETECT_CORNERS]: MODEL_FLASH,

  // ──────────────────────────────────────────────────
  // ✅ 純文字 / 邏輯 / 報表 — 用 FLASH
  // ──────────────────────────────────────────────────
  [AI_ROUTE_KEYS.GRADING_ARBITER]: MODEL_FLASH,            // Phase A3 一致性判官（純文字比對）
  [AI_ROUTE_KEYS.GRADING_PHASE_A_ARBITER]: MODEL_FLASH,    // 同 ARBITER
  [AI_ROUTE_KEYS.GRADING_CONSISTENCY_JUDGE]: MODEL_FLASH,  // 同 ARBITER（路由 alias）
  [AI_ROUTE_KEYS.GRADING_ACCESSOR]: MODEL_FLASH,           // Phase B1 算分
  [AI_ROUTE_KEYS.GRADING_PHASE_B_ACCESSOR]: MODEL_FLASH,   // 同 ACCESSOR
  [AI_ROUTE_KEYS.GRADING_EXPLAIN]: MODEL_FLASH,            // Phase B2 錯題解釋
  [AI_ROUTE_KEYS.GRADING_PHASE_B_EXPLAIN]: MODEL_FLASH,    // 同 EXPLAIN
  [AI_ROUTE_KEYS.GRADING_ERROR_GUIDANCE]: MODEL_FLASH,     // 學生 on-demand 單題錯題引導（純文字）
  [AI_ROUTE_KEYS.GRADING_GRADE_ONE]: MODEL_FLASH,          // 末端審查人工輸入單題重批（accessor）
  // 2026-06-22: FLASH(2.5-flash) 對「密集勾選題」讀不準——A大題 multi_check 整頁 3/5、
  //   常誤判成 single_check 只收一個答案、B1 題號 off-by-one 2/5。換 PRO(3.5-flash) 後整頁
  //   ① multi_check 5/5、② 題號 5/5（N=5 實證，local-only/eng_final_exam_2026-06-22）。
  //   extract 是一次性建答案卷（非每生），成本可接受；印刷 OCR 部分 PRO 同樣勝任。
  [AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT]: MODEL_PRO,           // 答案卷題目辨識（含密集勾選、需 PRO 視覺）
  [AI_ROUTE_KEYS.ANSWER_KEY_SOLVE]: MODEL_PRO,             // 生成答案卷：AI 解題起草（3.6＋default thinking，段1 沙盒實證國82.5%/數91%）
  [AI_ROUTE_KEYS.ANSWER_KEY_READ_REFERENCE]: MODEL_PRO,   // 讀老師手寫參考答案（read 級任務、含注音/數學式）
  [AI_ROUTE_KEYS.ANSWER_KEY_REANALYZE]: MODEL_FLASH,       // 答案卷重新分析
  [AI_ROUTE_KEYS.ANSWER_KEY_TAG_CONCEPTS]: MODEL_FLASH,    // 108 課綱概念標記
  [AI_ROUTE_KEYS.REPORT_TEACHER_SUMMARY]: MODEL_FLASH,     // 老師週報
  [AI_ROUTE_KEYS.REPORT_DOMAIN_DIAGNOSIS]: MODEL_FLASH,    // 學生領域診斷
  [AI_ROUTE_KEYS.REPORT_QUESTION_ERROR_FEATURES]: MODEL_PRO,  // 開放題錯誤特徵歸納（3.5、demo 實證品質）
  [AI_ROUTE_KEYS.REPORT_PARENT_COMMENT]: MODEL_FLASH,     // 家長報告評語（純文字摘要、2.5 便宜足夠）
  [AI_ROUTE_KEYS.REPORT_PARENT_DIAGNOSIS]: MODEL_FLASH,   // 家長報告逐題錯因診斷（餵題本圖、2.5-flash、沙盒實證品質足）
  [AI_ROUTE_KEYS.REPORT_KP_TAGGING]: MODEL_PRO,           // 知識點歸類（整本題本逐題判斷考點、每卷一次性 → 用 3.5；backfill 沙盒同款）
  [AI_ROUTE_KEYS.ADMIN_TAG_AGGREGATION]: MODEL_FLASH,      // admin 標籤聚合

  // ──────────────────────────────────────────────────
  // Legacy / 預設
  // ──────────────────────────────────────────────────
  [AI_ROUTE_KEYS.GRADING_EVALUATE]: MODEL_FLASH,           // 舊 single-shot 批改（保留兼容）
  [AI_ROUTE_KEYS.GRADING_PHASE_A]: MODEL_PRO,              // Phase A wrapper（內部各 stage 各自查）
  [AI_ROUTE_KEYS.GRADING_PHASE_B]: MODEL_FLASH,            // Phase B wrapper（內部各 stage 各自查）
  [AI_ROUTE_KEYS.UNKNOWN]: MODEL_FLASH                     // 未知路由用便宜的
})

/**
 * 依 routeKey 取得對應 model
 * 找不到就回 MODEL_FLASH（最便宜的 default）
 */
export function resolveStageModel(routeKey) {
  if (!routeKey) return MODEL_FLASH
  return STAGE_MODEL[routeKey] || MODEL_FLASH
}
