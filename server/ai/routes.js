export const AI_ROUTE_KEYS = Object.freeze({
  GRADING_EVALUATE: 'grading.evaluate',
  GRADING_CLASSIFY: 'grading.classify',
  GRADING_READ_ANSWER: 'grading.read_answer',
  GRADING_RE_READ_ANSWER: 'grading.re_read_answer',
  GRADING_DETAIL_READ: 'grading.detail_read',
  GRADING_ARBITER: 'grading.arbiter',
  GRADING_PHASE_A: 'grading.phase_a',
  GRADING_PHASE_A_CLASSIFY: 'grading.phase_a_classify',
  GRADING_PHASE_A_READ: 'grading.phase_a_read',
  GRADING_PHASE_A_ARBITER: 'grading.phase_a_arbiter',
  GRADING_PHASE_B: 'grading.phase_b',
  GRADING_PHASE_B_ACCESSOR: 'grading.phase_b_accessor',
  GRADING_PHASE_B_EXPLAIN: 'grading.phase_b_explain',
  GRADING_ACCESSOR: 'grading.accessor',
  GRADING_LOCATE: 'grading.locate',
  GRADING_EXPLAIN: 'grading.explain',
  // 2026-06-30 錯題引導改 on-demand：學生在訂正時按鈕觸發、單題生成（server 端取答案卷、不洩漏給 client）
  GRADING_ERROR_GUIDANCE: 'grading.error_guidance',
  GRADING_RECHECK: 'grading.recheck',
  GRADING_CONSISTENCY_JUDGE: 'grading.consistency_judge',
  // VJ（視覺判斷題：diagram_color / map_symbol / grid_geometry）專用三階段、全走 PRO
  GRADING_VJ_RUBRIC: 'grading.vj_rubric',   // A0：答案卷 → vjRubric（itemLabels/condition/gradingDefinition）
  GRADING_VJ_BLANK: 'grading.vj_blank',     // Phase A：單一 PRO blank reader（每項有沒有畫）
  GRADING_VJ_GRADE: 'grading.vj_grade',     // Phase B：rubric + 權威 blank 參數判對錯
  ANSWER_KEY_EXTRACT: 'answer_key.extract',
  ANSWER_KEY_LOCATE: 'answer_key.locate',
  ANSWER_KEY_REANALYZE: 'answer_key.reanalyze',
  ANSWER_KEY_TAG_CONCEPTS: 'answer_key.tag_concepts',
  REPORT_TEACHER_SUMMARY: 'report.teacher_summary',
  REPORT_DOMAIN_DIAGNOSIS: 'report.domain_diagnosis',
  ADMIN_TAG_AGGREGATION: 'admin.tag_aggregation',
  PERSPECTIVE_DETECT_CORNERS: 'perspective.detect_corners',
  UNKNOWN: 'unknown'
})

const AI_ROUTE_KEY_SET = new Set(Object.values(AI_ROUTE_KEYS))

export function normalizeRouteKey(routeKey) {
  if (typeof routeKey !== 'string') return null
  const normalized = routeKey.trim().toLowerCase()
  if (!normalized) return null
  return AI_ROUTE_KEY_SET.has(normalized) ? normalized : null
}

function collectPromptText(contents) {
  if (!Array.isArray(contents)) return ''
  const chunks = []
  for (const content of contents) {
    const parts = Array.isArray(content?.parts) ? content.parts : []
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        chunks.push(part.text.trim())
      }
    }
  }
  return chunks.join('\n').toLowerCase()
}

function hasAnyKeyword(text, keywords) {
  for (const keyword of keywords) {
    if (text.includes(keyword)) return true
  }
  return false
}

const ROUTE_KEYWORDS = Object.freeze({
  reportDomainDiagnosis: [
    'domainplan',
    '領域診斷',
    'trendsummary',
    'teachingactions',
    'abilityinsight',
    'domain diagnosis'
  ],
  reportTeacherSummary: [
    'instructionplan',
    '老師行動摘要',
    '"bullets"',
    '"remedy"',
    'teacher summary'
  ],
  answerKeyReanalyze: [
    '重新分析模式',
    'reanalyze',
    'needsreanalysis'
  ],
  answerKeyTagConcepts: [
    '108課綱概念標記任務',
    'tag_concepts',
    'concept_code_only'
  ],
  answerKeyExtract: [
    '從標準答案圖片提取可機器批改的答案表',
    '題型分類',
    'answerkey',
    'extract answer key',
    '答案卷圖片'
  ],
  gradingEvaluate: [
    '【批改流程】',
    'studentanswer',
    '逐題批改',
    '批改學生作業',
    'gradingresult'
  ]
})

export function resolveRouteKey({
  requestedRouteKey,
  contents,
  routeHint = {}
} = {}) {
  const normalized = normalizeRouteKey(requestedRouteKey)
  if (normalized) return normalized

  const promptText = collectPromptText(contents)
  if (!promptText) {
    if (routeHint.hasResolvedAnswerKey) return AI_ROUTE_KEYS.GRADING_EVALUATE
    return AI_ROUTE_KEYS.UNKNOWN
  }

  if (hasAnyKeyword(promptText, ROUTE_KEYWORDS.answerKeyReanalyze)) {
    return AI_ROUTE_KEYS.ANSWER_KEY_REANALYZE
  }
  if (hasAnyKeyword(promptText, ROUTE_KEYWORDS.answerKeyTagConcepts)) {
    return AI_ROUTE_KEYS.ANSWER_KEY_TAG_CONCEPTS
  }
  if (hasAnyKeyword(promptText, ROUTE_KEYWORDS.reportDomainDiagnosis)) {
    return AI_ROUTE_KEYS.REPORT_DOMAIN_DIAGNOSIS
  }
  if (hasAnyKeyword(promptText, ROUTE_KEYWORDS.reportTeacherSummary)) {
    return AI_ROUTE_KEYS.REPORT_TEACHER_SUMMARY
  }
  if (
    !routeHint.hasResolvedAnswerKey &&
    hasAnyKeyword(promptText, ROUTE_KEYWORDS.answerKeyExtract)
  ) {
    return AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT
  }
  if (
    routeHint.hasResolvedAnswerKey ||
    hasAnyKeyword(promptText, ROUTE_KEYWORDS.gradingEvaluate)
  ) {
    return AI_ROUTE_KEYS.GRADING_EVALUATE
  }

  return AI_ROUTE_KEYS.UNKNOWN
}
