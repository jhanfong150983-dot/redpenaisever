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

function validateGradingClassifyResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('GRADING_CLASSIFY_JSON_PARSE_FAILED')
    return { warnings, metrics }
  }

  const alignedQuestions = Array.isArray(parsed.alignedQuestions) ? parsed.alignedQuestions : []
  const visibleCount = alignedQuestions.filter((item) => item?.visible === true).length

  metrics.alignedCount = alignedQuestions.length
  metrics.visibleCount = visibleCount

  if (alignedQuestions.length === 0) warnings.push('GRADING_CLASSIFY_ALIGNED_EMPTY')

  return { warnings, metrics }
}

function validateGradingReadAnswerResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('GRADING_READ_ANSWER_JSON_PARSE_FAILED')
    return { warnings, metrics }
  }

  const answers = Array.isArray(parsed.answers) ? parsed.answers : []
  const readCount = answers.filter((item) => item?.status === 'read').length
  const unreadableCount = answers.filter((item) => item?.status === 'unreadable').length
  const blankCount = answers.filter((item) => item?.status === 'blank').length
  const missingQuestionIdCount = answers.filter(
    (item) => typeof item?.questionId !== 'string' || !item.questionId.trim()
  ).length
  const readEmptyAnswerCount = answers.filter((item) => {
    if (item?.status !== 'read') return false
    const raw = typeof item?.studentAnswerRaw === 'string' ? item.studentAnswerRaw.trim() : ''
    return !raw || raw === '未作答' || raw === '無法辨識'
  }).length

  metrics.answerCount = answers.length
  metrics.readCount = readCount
  metrics.blankCount = blankCount
  metrics.unreadableCount = unreadableCount
  metrics.missingQuestionIdCount = missingQuestionIdCount
  metrics.readEmptyAnswerCount = readEmptyAnswerCount

  if (answers.length === 0) warnings.push('GRADING_READ_ANSWER_EMPTY')
  if (missingQuestionIdCount > 0) warnings.push('GRADING_READ_ANSWER_QUESTION_ID_MISSING')
  if (readEmptyAnswerCount > 0) warnings.push('GRADING_READ_ANSWER_EMPTY_RAW_VALUE')

  return { warnings, metrics }
}

function validateGradingAccessorResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('GRADING_ACCESSOR_JSON_PARSE_FAILED')
    return { warnings, metrics }
  }

  const scores = Array.isArray(parsed.scores) ? parsed.scores : []
  const totalScore = toFiniteNumber(parsed.totalScore)
  const scoreSum = scores.reduce((sum, item) => {
    const score = toFiniteNumber(item?.score)
    return sum + (score ?? 0)
  }, 0)
  const invalidRangeCount = scores.filter((item) => {
    const score = toFiniteNumber(item?.score)
    const maxScore = toFiniteNumber(item?.maxScore)
    if (score === null || maxScore === null) return false
    return score < 0 || score > maxScore
  }).length

  metrics.scoreCount = scores.length
  metrics.totalScore = totalScore
  metrics.scoreSum = scoreSum
  metrics.invalidRangeCount = invalidRangeCount

  if (scores.length === 0) warnings.push('GRADING_ACCESSOR_SCORES_EMPTY')
  if (totalScore === null) warnings.push('GRADING_ACCESSOR_TOTAL_MISSING')
  if (totalScore !== null && Math.abs(totalScore - scoreSum) > 1) {
    warnings.push('GRADING_ACCESSOR_TOTAL_SCORE_MISMATCH')
  }
  if (invalidRangeCount > 0) warnings.push('GRADING_ACCESSOR_SCORE_OUT_OF_RANGE')

  return { warnings, metrics }
}

function validateGradingLocateResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('GRADING_LOCATE_JSON_PARSE_FAILED')
    return { warnings, metrics }
  }

  const locatedQuestions = Array.isArray(parsed.locatedQuestions)
    ? parsed.locatedQuestions
    : []

  const hasValidBbox = (bbox) => {
    if (!bbox || typeof bbox !== 'object') return false
    const x = toFiniteNumber(bbox.x)
    const y = toFiniteNumber(bbox.y)
    const w = toFiniteNumber(bbox.w)
    const h = toFiniteNumber(bbox.h)
    if ([x, y, w, h].some((item) => item === null)) return false
    if (w <= 0 || h <= 0) return false
    return true
  }

  const withQuestionBboxCount = locatedQuestions.filter((item) =>
    hasValidBbox(item?.questionBbox ?? item?.question_bbox)
  ).length
  const withAnswerBboxCount = locatedQuestions.filter((item) =>
    hasValidBbox(item?.answerBbox ?? item?.answer_bbox)
  ).length

  metrics.locatedCount = locatedQuestions.length
  metrics.withQuestionBboxCount = withQuestionBboxCount
  metrics.withAnswerBboxCount = withAnswerBboxCount

  if (locatedQuestions.length === 0) warnings.push('GRADING_LOCATE_EMPTY')
  if (withQuestionBboxCount === 0 && withAnswerBboxCount === 0) {
    warnings.push('GRADING_LOCATE_BBOX_EMPTY')
  }

  return { warnings, metrics }
}

function validateGradingExplainResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('GRADING_EXPLAIN_JSON_PARSE_FAILED')
    return { warnings, metrics }
  }

  const details = Array.isArray(parsed.details) ? parsed.details : []
  const mistakes = Array.isArray(parsed.mistakes) ? parsed.mistakes : []
  const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : []
  const missingReasonCount = details.filter(
    (item) => {
      const hasReason = typeof item?.reason === 'string' && item.reason.trim()
      const hasGuidance = typeof item?.studentGuidance === 'string' && item.studentGuidance.trim()
      return !hasReason && !hasGuidance
    }
  ).length

  metrics.detailCount = details.length
  metrics.mistakeCount = mistakes.length
  metrics.suggestionCount = suggestions.length
  metrics.missingReasonCount = missingReasonCount

  if (details.length === 0) warnings.push('GRADING_EXPLAIN_DETAILS_EMPTY')
  if (missingReasonCount > 0) warnings.push('GRADING_EXPLAIN_REASON_MISSING')

  return { warnings, metrics }
}

function validateGradingRecheckResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('GRADING_RECHECK_JSON_PARSE_FAILED')
    return { warnings, metrics }
  }

  const results = Array.isArray(parsed.results) ? parsed.results : []
  const passedCount = results.filter((item) => item?.passed === true).length
  const failedCount = results.filter((item) => item?.passed === false).length
  const missingQuestionIdCount = results.filter(
    (item) => !String(item?.questionId || '').trim()
  ).length
  const missingReasonCount = results.filter((item) => {
    if (item?.passed !== false) return false
    const hasReason = typeof item?.reason === 'string' && item.reason.trim()
    const hasGuidance = typeof item?.newGuidance === 'string' && item.newGuidance.trim()
    return !hasReason && !hasGuidance
  }).length

  metrics.resultCount = results.length
  metrics.passedCount = passedCount
  metrics.failedCount = failedCount
  metrics.missingQuestionIdCount = missingQuestionIdCount
  metrics.missingReasonCount = missingReasonCount

  if (results.length === 0) warnings.push('GRADING_RECHECK_RESULTS_EMPTY')
  if (missingQuestionIdCount > 0) warnings.push('GRADING_RECHECK_QUESTION_ID_MISSING')
  if (missingReasonCount > 0) warnings.push('GRADING_RECHECK_REASON_MISSING')

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
    case AI_ROUTE_KEYS.GRADING_CLASSIFY:
      return validateGradingClassifyResponse(data)
    case AI_ROUTE_KEYS.GRADING_READ_ANSWER:
    case AI_ROUTE_KEYS.GRADING_RE_READ_ANSWER:
      return validateGradingReadAnswerResponse(data)
    case AI_ROUTE_KEYS.GRADING_ACCESSOR:
      return validateGradingAccessorResponse(data)
    case AI_ROUTE_KEYS.GRADING_LOCATE:
      return validateGradingLocateResponse(data)
    case AI_ROUTE_KEYS.GRADING_EXPLAIN:
      return validateGradingExplainResponse(data)
    case AI_ROUTE_KEYS.GRADING_RECHECK:
      return validateGradingRecheckResponse(data)
    case AI_ROUTE_KEYS.GRADING_EVALUATE:
    case AI_ROUTE_KEYS.GRADING_PHASE_A:
    case AI_ROUTE_KEYS.GRADING_PHASE_B:
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
