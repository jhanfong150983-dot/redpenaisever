export const AI_ROUTE_KEYS = Object.freeze({
  GRADING_EVALUATE: 'grading.evaluate',
  ANSWER_KEY_EXTRACT: 'answer_key.extract',
  ANSWER_KEY_REANALYZE: 'answer_key.reanalyze',
  REPORT_TEACHER_SUMMARY: 'report.teacher_summary',
  REPORT_DOMAIN_DIAGNOSIS: 'report.domain_diagnosis',
  ADMIN_TAG_AGGREGATION: 'admin.tag_aggregation',
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

