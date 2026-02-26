import { AI_ROUTE_KEYS } from './routes.js'

function toFiniteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function extractCandidateText(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : []
  return candidates
    .flatMap((candidate) => candidate?.content?.parts ?? [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim()
}

function tryParseCandidateJson(data) {
  const text = extractCandidateText(data)
  if (!text) return null
  const cleaned = text.replace(/```json|```/g, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    // Continue to best-effort extraction.
  }

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

function validateGradingResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('GRADING_JSON_PARSE_FAILED')
    return { warnings, metrics }
  }

  const details = Array.isArray(parsed.details) ? parsed.details : []
  const totalScore = toFiniteNumber(parsed.totalScore)
  const detailScoreSum = details.reduce((sum, detail) => {
    const score = toFiniteNumber(detail?.score)
    return sum + (score ?? 0)
  }, 0)

  metrics.detailsCount = details.length
  metrics.totalScore = totalScore
  metrics.detailScoreSum = detailScoreSum

  if (details.length === 0) {
    warnings.push('GRADING_DETAILS_EMPTY')
  }

  if (totalScore !== null && Math.abs(totalScore - detailScoreSum) > 1) {
    warnings.push('GRADING_TOTAL_SCORE_MISMATCH')
  }

  const missingStudentAnswerCount = details.filter(
    (detail) => typeof detail?.studentAnswer !== 'string'
  ).length
  if (missingStudentAnswerCount > 0) {
    warnings.push('GRADING_STUDENT_ANSWER_MISSING')
    metrics.missingStudentAnswerCount = missingStudentAnswerCount
  }

  return { warnings, metrics }
}

function validateAnswerKeyResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('ANSWER_KEY_JSON_PARSE_FAILED')
    return { warnings, metrics }
  }

  const questions = Array.isArray(parsed.questions) ? parsed.questions : []
  const totalScore = toFiniteNumber(parsed.totalScore)
  const scoreSum = questions.reduce((sum, question) => {
    const maxScore = toFiniteNumber(question?.maxScore)
    return sum + (maxScore ?? 0)
  }, 0)

  metrics.questionCount = questions.length
  metrics.totalScore = totalScore
  metrics.maxScoreSum = scoreSum

  if (questions.length === 0) {
    warnings.push('ANSWER_KEY_QUESTIONS_EMPTY')
  }

  const missingQuestionIdCount = questions.filter(
    (question) => !String(question?.id || '').trim()
  ).length
  if (missingQuestionIdCount > 0) {
    warnings.push('ANSWER_KEY_ID_MISSING')
    metrics.missingQuestionIdCount = missingQuestionIdCount
  }

  if (totalScore !== null && Math.abs(totalScore - scoreSum) > 1) {
    warnings.push('ANSWER_KEY_TOTAL_SCORE_MISMATCH')
  }

  return { warnings, metrics }
}

function validateTeacherSummaryResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('TEACHER_SUMMARY_JSON_PARSE_FAILED')
    return { warnings, metrics }
  }

  const bullets = Array.isArray(parsed.bullets) ? parsed.bullets : []
  const remedy = typeof parsed.remedy === 'string' ? parsed.remedy.trim() : ''

  metrics.bulletCount = bullets.length
  metrics.hasRemedy = remedy.length > 0

  if (bullets.length < 2 || bullets.length > 3) {
    warnings.push('TEACHER_SUMMARY_BULLET_COUNT_OUT_OF_RANGE')
  }
  if (!remedy) {
    warnings.push('TEACHER_SUMMARY_REMEDY_MISSING')
  }

  return { warnings, metrics }
}

function validateDomainDiagnosisResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('DOMAIN_DIAGNOSIS_JSON_PARSE_FAILED')
    return { warnings, metrics }
  }

  const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : ''
  const trendSummary = typeof parsed.trendSummary === 'string' ? parsed.trendSummary.trim() : ''
  const teachingActions = Array.isArray(parsed.teachingActions)
    ? parsed.teachingActions.filter((action) => typeof action === 'string' && action.trim())
    : []

  metrics.overviewLength = overview.length
  metrics.trendSummaryLength = trendSummary.length
  metrics.teachingActionCount = teachingActions.length

  if (!overview) warnings.push('DOMAIN_DIAGNOSIS_OVERVIEW_MISSING')
  if (!trendSummary) warnings.push('DOMAIN_DIAGNOSIS_TREND_SUMMARY_MISSING')
  if (teachingActions.length < 2 || teachingActions.length > 3) {
    warnings.push('DOMAIN_DIAGNOSIS_ACTIONS_COUNT_OUT_OF_RANGE')
  }

  return { warnings, metrics }
}

function validateUnknownResponse(data) {
  const warnings = []
  const metrics = {}
  const hasCandidates = Array.isArray(data?.candidates) && data.candidates.length > 0
  metrics.hasCandidates = hasCandidates
  if (!hasCandidates) warnings.push('MODEL_RESPONSE_CANDIDATES_EMPTY')
  return { warnings, metrics }
}

export function validateResponseByRoute(routeKey, data) {
  switch (routeKey) {
    case AI_ROUTE_KEYS.GRADING_EVALUATE:
      return validateGradingResponse(data)
    case AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT:
    case AI_ROUTE_KEYS.ANSWER_KEY_REANALYZE:
      return validateAnswerKeyResponse(data)
    case AI_ROUTE_KEYS.REPORT_TEACHER_SUMMARY:
      return validateTeacherSummaryResponse(data)
    case AI_ROUTE_KEYS.REPORT_DOMAIN_DIAGNOSIS:
      return validateDomainDiagnosisResponse(data)
    default:
      return validateUnknownResponse(data)
  }
}

