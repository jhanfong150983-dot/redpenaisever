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

export const MODEL_PRO = process.env.MODEL_PRO || 'gemini-3.5-flash'
export const MODEL_FLASH = process.env.MODEL_FLASH || 'gemini-2.5-flash'

// 503 overload 自動 fallback 順序
export const FALLBACK_CHAIN = [MODEL_FLASH, 'gemini-3-flash-preview']

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
  [AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT]: MODEL_FLASH,         // 答案卷題目辨識（印刷 OCR、FLASH 夠）
  [AI_ROUTE_KEYS.ANSWER_KEY_REANALYZE]: MODEL_FLASH,       // 答案卷重新分析
  [AI_ROUTE_KEYS.ANSWER_KEY_TAG_CONCEPTS]: MODEL_FLASH,    // 108 課綱概念標記
  [AI_ROUTE_KEYS.REPORT_TEACHER_SUMMARY]: MODEL_FLASH,     // 老師週報
  [AI_ROUTE_KEYS.REPORT_DOMAIN_DIAGNOSIS]: MODEL_FLASH,    // 學生領域診斷
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
