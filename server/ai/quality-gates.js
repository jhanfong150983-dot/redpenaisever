import { AI_ROUTE_KEYS } from './routes.js'

// ── Severity levels for quality gate results ────────────────────────────────
// 'pass'  — all checks OK, proceed normally
// 'warn'  — minor issues detected, proceed but log
// 'fail'  — significant quality issue, should trigger retry
export const QG_SEVERITY = { PASS: 'pass', WARN: 'warn', FAIL: 'fail' }

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

// ── Helper: compute severity from warnings ──────────────────────────────────
function severityFromWarnings(warnings) {
  if (warnings.some((w) => w.startsWith('FAIL:'))) return QG_SEVERITY.FAIL
  if (warnings.length > 0) return QG_SEVERITY.WARN
  return QG_SEVERITY.PASS
}

// ── Helper: compute IoU (Intersection over Union) for two bboxes ────────────
function computeBboxIoU(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h
  const bx2 = b.x + b.w, by2 = b.y + b.h
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y))
  const intersection = ix * iy
  if (intersection === 0) return 0
  const union = a.w * a.h + b.w * b.h - intersection
  return union > 0 ? intersection / union : 0
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE VALIDATORS (original structural checks preserved, deep checks added)
// ═══════════════════════════════════════════════════════════════════════════════

function validateGradingResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('GRADING_JSON_PARSE_FAILED')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
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

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

// ── CLASSIFY: bbox quality deep validation ──────────────────────────────────
function validateGradingClassifyResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('FAIL:GRADING_CLASSIFY_JSON_PARSE_FAILED')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
  }

  const alignedQuestions = Array.isArray(parsed.alignedQuestions) ? parsed.alignedQuestions : []
  const visibleCount = alignedQuestions.filter((item) => item?.visible === true).length

  metrics.alignedCount = alignedQuestions.length
  metrics.visibleCount = visibleCount

  if (alignedQuestions.length === 0) {
    warnings.push('FAIL:GRADING_CLASSIFY_ALIGNED_EMPTY')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
  }

  // NOTE: Deep bbox checks are performed post-normalization in staged-grading.js
  // via validateClassifyQuality() which receives the normalized classifyResult.
  // This validator only handles raw response structural checks.

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

/**
 * Deep classify quality gate — called AFTER normalizeClassifyResult in staged-grading.js.
 * Receives the normalized classifyResult (with proper bbox objects) and the expected questionIds.
 * Returns { severity, warnings, metrics } where severity='fail' means retry is recommended.
 */
export function validateClassifyQuality(classifyResult, expectedQuestionIds) {
  const warnings = []
  const metrics = {}
  const aligned = Array.isArray(classifyResult?.alignedQuestions) ? classifyResult.alignedQuestions : []
  const totalExpected = expectedQuestionIds?.length ?? aligned.length

  // ── Coverage check ──
  const visibleCount = aligned.filter((q) => q.visible).length
  const coverage = totalExpected > 0 ? visibleCount / totalExpected : 0
  metrics.coverage = +coverage.toFixed(3)
  metrics.visibleCount = visibleCount
  metrics.totalExpected = totalExpected
  if (coverage < 0.7) {
    warnings.push(`FAIL:CLASSIFY_LOW_COVERAGE(${metrics.coverage})`)
  }

  // ── Bbox missing rate (visible but no answerBbox) ──
  const visibleQuestions = aligned.filter((q) => q.visible)
  const missingBboxCount = visibleQuestions.filter((q) => !q.answerBbox).length
  const missingBboxRate = visibleCount > 0 ? missingBboxCount / visibleCount : 0
  metrics.missingBboxCount = missingBboxCount
  metrics.missingBboxRate = +missingBboxRate.toFixed(3)
  if (missingBboxRate > 0.3) {
    warnings.push(`FAIL:CLASSIFY_HIGH_MISSING_BBOX(${missingBboxCount}/${visibleCount})`)
  }

  // ── Bbox size anomaly ──
  // min area 0.0001: 容許表格小格（4頁合併後 w≈0.045, h≈0.004 → area≈0.00018）
  const bboxes = visibleQuestions.filter((q) => q.answerBbox).map((q) => ({ id: q.questionId, ...q.answerBbox }))
  let sizeAnomalyCount = 0
  for (const b of bboxes) {
    const area = b.w * b.h
    if (area < 0.0001 || area > 0.5) sizeAnomalyCount++
  }
  metrics.sizeAnomalyCount = sizeAnomalyCount
  if (bboxes.length > 0 && sizeAnomalyCount / bboxes.length > 0.2) {
    warnings.push(`FAIL:CLASSIFY_BBOX_SIZE_ANOMALY(${sizeAnomalyCount}/${bboxes.length})`)
  }

  // ── Bbox out of bounds ──
  let outOfBoundsCount = 0
  for (const b of bboxes) {
    if (b.x + b.w > 1.05 || b.y + b.h > 1.05 || b.x < -0.05 || b.y < -0.05) outOfBoundsCount++
  }
  metrics.outOfBoundsCount = outOfBoundsCount
  if (outOfBoundsCount > 0) {
    warnings.push(`FAIL:CLASSIFY_BBOX_OUT_OF_BOUNDS(${outOfBoundsCount})`)
  }

  // ── Bbox overlap detection (IoU > 0.5 between any two) ──
  // Skip overlap between questions in the same group (they share bbox by design).
  // Same group = same bboxGroupId, or same ID prefix up to last segment (e.g., 6-7-8-1 and 6-7-8-2).
  const questionGroupOf = (q) => {
    const aq = aligned.find((a) => a.questionId === q.id)
    if (aq?.bboxGroupId) return aq.bboxGroupId
    // Fallback: ID prefix (strip last segment after last dash)
    const lastDash = q.id.lastIndexOf('-')
    return lastDash > 0 ? q.id.slice(0, lastDash) : q.id
  }
  let overlapCount = 0
  const overlapPairs = []
  for (let i = 0; i < bboxes.length; i++) {
    for (let j = i + 1; j < bboxes.length; j++) {
      // Skip same-group overlaps (題組題本來就會重疊)
      if (questionGroupOf(bboxes[i]) === questionGroupOf(bboxes[j])) continue
      const iou = computeBboxIoU(bboxes[i], bboxes[j])
      if (iou > 0.5) {
        overlapCount++
        overlapPairs.push({ a: bboxes[i].id, b: bboxes[j].id, iou: +iou.toFixed(3) })
      }
    }
  }
  metrics.overlapCount = overlapCount
  if (overlapCount > 0) {
    warnings.push(`FAIL:CLASSIFY_BBOX_OVERLAP(${overlapCount}_pairs)`)
    metrics.overlapPairs = overlapPairs.slice(0, 5)  // keep top 5 for logging
  }

  // ── Bbox clustering anomaly (all bboxes in a tiny Y range) ──
  if (bboxes.length >= 3) {
    const ys = bboxes.map((b) => b.y)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys.map((y, i) => y + bboxes[i].h))
    const ySpan = maxY - minY
    metrics.bboxYSpan = +ySpan.toFixed(3)
    if (ySpan < 0.15) {
      warnings.push(`FAIL:CLASSIFY_BBOX_CLUSTERED(ySpan=${metrics.bboxYSpan})`)
    }
  }

  // ── Pixel bbox rejected ──
  const pixelRejected = classifyResult?.pixelBboxRejected?.length ?? 0
  if (pixelRejected > 0) {
    metrics.pixelBboxRejected = pixelRejected
    warnings.push(`FAIL:CLASSIFY_PIXEL_BBOX_REJECTED(${pixelRejected})`)
  }

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

// ── READ ANSWER: deep validation ────────────────────────────────────────────
function validateGradingReadAnswerResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('FAIL:GRADING_READ_ANSWER_JSON_PARSE_FAILED')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
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

  if (answers.length === 0) warnings.push('FAIL:GRADING_READ_ANSWER_EMPTY')
  if (missingQuestionIdCount > 0) warnings.push('GRADING_READ_ANSWER_QUESTION_ID_MISSING')
  if (readEmptyAnswerCount > 0) warnings.push('GRADING_READ_ANSWER_EMPTY_RAW_VALUE')

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

/**
 * Deep read answer quality gate — called AFTER normalizeReadAnswerResult in staged-grading.js.
 * Compares AI1 and AI2 read results for quality signals.
 * @param {object} readResult1 - Normalized AI1 read result (answers array)
 * @param {object} readResult2 - Normalized AI2 read result (answers array)
 * @param {string[]} expectedQuestionIds - Question IDs that should have been read
 * @param {object[]} classifyAligned - Classify result aligned questions (for type context)
 * Returns { severity, warnings, metrics }
 */
export function validateReadAnswerQuality(readResult1, readResult2, expectedQuestionIds, classifyAligned) {
  const warnings = []
  const metrics = {}

  const answers1 = Array.isArray(readResult1?.answers) ? readResult1.answers : []
  const answers2 = Array.isArray(readResult2?.answers) ? readResult2.answers : []
  const expectedCount = expectedQuestionIds?.length ?? 0

  // ── QuestionId coverage (AI1) ──
  const ai1Ids = new Set(answers1.map((a) => a.questionId).filter(Boolean))
  const missingIds = expectedQuestionIds?.filter((id) => !ai1Ids.has(id)) ?? []
  const coverageRate = expectedCount > 0 ? ai1Ids.size / expectedCount : 1
  metrics.ai1Count = answers1.length
  metrics.ai2Count = answers2.length
  metrics.expectedCount = expectedCount
  metrics.missingIdCount = missingIds.length
  metrics.coverageRate = +coverageRate.toFixed(3)
  if (expectedCount > 0 && coverageRate < 0.8) {
    warnings.push(`FAIL:READ_LOW_COVERAGE(${ai1Ids.size}/${expectedCount})`)
  }

  // ── Read rate check (AI1) — too many unreadable may indicate crop/bbox issue ──
  const visibleIds = new Set(
    (classifyAligned ?? []).filter((q) => q.visible).map((q) => q.questionId)
  )
  const visibleAnswers1 = answers1.filter((a) => visibleIds.size === 0 || visibleIds.has(a.questionId))
  const readCount = visibleAnswers1.filter((a) => a.status === 'read').length
  const visibleTotal = visibleAnswers1.length || 1
  const readRate = readCount / visibleTotal
  metrics.readRate = +readRate.toFixed(3)
  if (visibleAnswers1.length >= 3 && readRate < 0.5) {
    warnings.push(`FAIL:READ_LOW_READ_RATE(${readCount}/${visibleTotal})`)
  }

  // ── Duplicate answer detection (≥3 non-trivial identical answers) ──
  const answerCounts = new Map()
  for (const a of answers1) {
    if (a.status !== 'read') continue
    const raw = typeof a.studentAnswerRaw === 'string' ? a.studentAnswerRaw.trim() : ''
    if (!raw || raw.length < 2) continue  // skip trivial single-char answers
    answerCounts.set(raw, (answerCounts.get(raw) ?? 0) + 1)
  }
  let maxDuplicateAnswer = ''
  let maxDuplicateCount = 0
  for (const [answer, count] of answerCounts) {
    if (count > maxDuplicateCount) {
      maxDuplicateCount = count
      maxDuplicateAnswer = answer
    }
  }
  metrics.maxDuplicateCount = maxDuplicateCount
  if (maxDuplicateCount >= 3) {
    warnings.push(`READ_DUPLICATE_ANSWERS(${maxDuplicateCount}_copies:"${maxDuplicateAnswer.slice(0, 20)}")`)
  }

  // ── Answer length anomaly (fill_blank > 200 chars) ──
  const classifyMap = new Map((classifyAligned ?? []).map((q) => [q.questionId, q]))
  let longAnswerCount = 0
  for (const a of answers1) {
    if (a.status !== 'read') continue
    const raw = typeof a.studentAnswerRaw === 'string' ? a.studentAnswerRaw : ''
    const qType = classifyMap.get(a.questionId)?.questionType
    if ((qType === 'fill_blank' || qType === 'true_false' || qType === 'single_choice') && raw.length > 200) {
      longAnswerCount++
    }
  }
  metrics.longAnswerCount = longAnswerCount
  if (longAnswerCount > 0) {
    warnings.push(`READ_ANSWER_TOO_LONG(${longAnswerCount})`)
  }

  // ── AI1/AI2 overall disagreement rate ──
  if (answers2.length > 0) {
    const ai2ById = new Map(answers2.map((a) => [a.questionId, a]))
    let disagreements = 0
    let comparisons = 0
    for (const a1 of answers1) {
      if (a1.status !== 'read') continue
      const a2 = ai2ById.get(a1.questionId)
      if (!a2 || a2.status !== 'read') continue
      comparisons++
      const raw1 = (a1.studentAnswerRaw ?? '').trim()
      const raw2 = (a2.studentAnswerRaw ?? '').trim()
      if (raw1 !== raw2) disagreements++
    }
    const disagreementRate = comparisons > 0 ? disagreements / comparisons : 0
    metrics.ai1ai2Comparisons = comparisons
    metrics.ai1ai2Disagreements = disagreements
    metrics.ai1ai2DisagreementRate = +disagreementRate.toFixed(3)
    if (comparisons >= 3 && disagreementRate > 0.5) {  // AI1/AI2 角色分化後閾值從 0.4 調至 0.5
      warnings.push(`FAIL:READ_HIGH_DISAGREEMENT(${disagreements}/${comparisons}=${metrics.ai1ai2DisagreementRate})`)
    }
  }

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

// ── ACCESSOR: deep validation ───────────────────────────────────────────────
function validateGradingAccessorResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('FAIL:GRADING_ACCESSOR_JSON_PARSE_FAILED')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
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

  if (scores.length === 0) warnings.push('FAIL:GRADING_ACCESSOR_SCORES_EMPTY')
  if (totalScore === null) warnings.push('GRADING_ACCESSOR_TOTAL_MISSING')
  if (totalScore !== null && Math.abs(totalScore - scoreSum) > 1) {
    warnings.push('GRADING_ACCESSOR_TOTAL_SCORE_MISMATCH')
  }
  if (invalidRangeCount > 0) warnings.push('FAIL:GRADING_ACCESSOR_SCORE_OUT_OF_RANGE')

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

/**
 * Deep accessor quality gate — called AFTER parsing accessor result in staged-grading.js.
 * @param {object} accessorResult - Parsed accessor result (scores array)
 * @param {string[]} expectedQuestionIds - Question IDs that should have been scored
 * Returns { severity, warnings, metrics }
 */
export function validateAccessorQuality(accessorResult, expectedQuestionIds) {
  const warnings = []
  const metrics = {}
  const scores = Array.isArray(accessorResult?.scores) ? accessorResult.scores : []
  const expectedCount = expectedQuestionIds?.length ?? 0

  // ── QuestionId coverage ──
  const scoredIds = new Set(scores.map((s) => s.questionId).filter(Boolean))
  const missingCount = expectedQuestionIds?.filter((id) => !scoredIds.has(id)).length ?? 0
  metrics.scoredCount = scoredIds.size
  metrics.expectedCount = expectedCount
  metrics.missingCount = missingCount
  if (missingCount > 0) {
    warnings.push(`FAIL:ACCESSOR_MISSING_QUESTIONS(${missingCount}/${expectedCount})`)
  }

  // ── All zero anomaly (suspicious if > 5 questions all scored 0) ──
  const zeroScoreCount = scores.filter((s) => toFiniteNumber(s.score) === 0).length
  const fullScoreCount = scores.filter((s) => {
    const score = toFiniteNumber(s.score)
    const maxScore = toFiniteNumber(s.maxScore)
    return score !== null && maxScore !== null && score === maxScore && maxScore > 0
  }).length
  metrics.zeroScoreCount = zeroScoreCount
  metrics.fullScoreCount = fullScoreCount
  if (scores.length >= 5 && zeroScoreCount === scores.length) {
    warnings.push(`ACCESSOR_ALL_ZERO(${zeroScoreCount})`)
  }

  // ── isCorrect vs errorType contradiction ──
  let contradictionCount = 0
  for (const s of scores) {
    const isCorrect = s.isCorrect === true
    const errorType = typeof s.errorType === 'string' ? s.errorType.trim() : ''
    if (isCorrect && errorType && errorType !== 'none') {
      contradictionCount++
    }
  }
  metrics.contradictionCount = contradictionCount
  if (contradictionCount > 0) {
    warnings.push(`FAIL:ACCESSOR_CORRECT_ERROR_CONTRADICTION(${contradictionCount})`)
  }

  // ── Low confidence rate ──
  const withConfidence = scores.filter((s) => toFiniteNumber(s.scoreConfidence) !== null)
  const lowConfCount = withConfidence.filter((s) => toFiniteNumber(s.scoreConfidence) < 50).length
  metrics.lowConfidenceCount = lowConfCount
  if (withConfidence.length >= 3 && lowConfCount / withConfidence.length > 0.4) {
    warnings.push(`ACCESSOR_LOW_CONFIDENCE(${lowConfCount}/${withConfidence.length})`)
  }

  // ── Missing studentFinalAnswer ──
  const missingStudentAnswer = scores.filter((s) => {
    const ans = typeof s.studentFinalAnswer === 'string' ? s.studentFinalAnswer.trim() : ''
    return !ans && s.score !== undefined
  }).length
  metrics.missingStudentAnswer = missingStudentAnswer
  if (missingStudentAnswer > 0) {
    warnings.push(`ACCESSOR_MISSING_STUDENT_ANSWER(${missingStudentAnswer})`)
  }

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

// ── ARBITER: deep validation ────────────────────────────────────────────────
/**
 * Deep arbiter quality gate — called AFTER parsing arbiter result.
 * @param {object[]} arbiterResults - Array of arbiter decisions
 * @param {string[]} expectedQuestionIds - Question IDs that should have been arbitrated
 * Returns { severity, warnings, metrics }
 */
export function validateArbiterQuality(arbiterResults, expectedQuestionIds) {
  const warnings = []
  const metrics = {}
  // arbiterResults can be an array of { questionId, arbiterStatus, ... }
  // OR an array of values from a Map (without questionId — the key was the questionId)
  const results = Array.isArray(arbiterResults) ? arbiterResults : []
  const expectedCount = expectedQuestionIds?.length ?? 0

  // ── Decision coverage ──
  // Results may or may not have questionId (Map values don't).
  // Count how many results we got vs how many we expected.
  metrics.decidedCount = results.length
  metrics.expectedCount = expectedCount
  const missingCount = Math.max(0, expectedCount - results.length)
  metrics.missingCount = missingCount
  if (missingCount > 0 && expectedCount > 0 && missingCount > expectedCount * 0.2) {
    warnings.push(`FAIL:ARBITER_MISSING_DECISIONS(${missingCount}/${expectedCount})`)
  }

  // ── Decision validity ──
  const VALID_STATUSES = new Set([
    'arbitrated_agree', 'needs_review'  // AI3 改為一致性判官後，不再有 pick_1/pick_2
  ])
  const invalidStatusCount = results.filter((r) => !VALID_STATUSES.has(r.arbiterStatus)).length
  metrics.invalidStatusCount = invalidStatusCount
  if (invalidStatusCount > 0) {
    warnings.push(`FAIL:ARBITER_INVALID_STATUS(${invalidStatusCount})`)
  }

  // ── needs_review ratio ──
  const needsReviewCount = results.filter((r) => r.arbiterStatus === 'needs_review').length
  metrics.needsReviewCount = needsReviewCount
  const needsReviewRate = results.length > 0 ? needsReviewCount / results.length : 0
  metrics.needsReviewRate = +needsReviewRate.toFixed(3)
  if (results.length >= 3 && needsReviewRate > 0.5) {
    warnings.push(`ARBITER_HIGH_NEEDS_REVIEW(${needsReviewCount}/${results.length})`)
  }

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

// ── EXPLAIN: deep validation ────────────────────────────────────────────────
function validateGradingExplainResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('FAIL:GRADING_EXPLAIN_JSON_PARSE_FAILED')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
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

  if (details.length === 0) warnings.push('FAIL:GRADING_EXPLAIN_DETAILS_EMPTY')
  if (missingReasonCount > 0) warnings.push('GRADING_EXPLAIN_REASON_MISSING')

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

/**
 * Deep explain quality gate — called AFTER parsing explain result.
 * @param {object} explainResult - Parsed explain result
 * @param {string[]} expectedQuestionIds - Wrong question IDs that should have explanations
 * Returns { severity, warnings, metrics }
 */
export function validateExplainQuality(explainResult, expectedQuestionIds) {
  const warnings = []
  const metrics = {}
  const details = Array.isArray(explainResult?.details) ? explainResult.details : []
  const expectedCount = expectedQuestionIds?.length ?? 0

  // ── Coverage: all wrong questions have explanations ──
  const explainedIds = new Set(details.map((d) => d.questionId).filter(Boolean))
  const missingCount = expectedQuestionIds?.filter((id) => !explainedIds.has(id)).length ?? 0
  metrics.explainedCount = explainedIds.size
  metrics.expectedCount = expectedCount
  metrics.missingCount = missingCount
  if (expectedCount > 0 && missingCount / expectedCount > 0.2) {
    warnings.push(`FAIL:EXPLAIN_LOW_COVERAGE(${missingCount}/${expectedCount})`)
  }

  // ── Short explanation detection ──
  let shortCount = 0
  for (const d of details) {
    const reason = typeof d.reason === 'string' ? d.reason.trim() : ''
    const guidance = typeof d.studentGuidance === 'string' ? d.studentGuidance.trim() : ''
    if ((reason.length + guidance.length) < 10) shortCount++
  }
  metrics.shortExplanationCount = shortCount
  if (shortCount > 0) {
    warnings.push(`EXPLAIN_TOO_SHORT(${shortCount})`)
  }

  // ── Orphan explanations (explaining correct questions) ──
  if (expectedQuestionIds) {
    const expectedSet = new Set(expectedQuestionIds)
    const orphanCount = details.filter((d) => d.questionId && !expectedSet.has(d.questionId)).length
    metrics.orphanCount = orphanCount
    if (orphanCount > 0) {
      warnings.push(`EXPLAIN_ORPHAN_QUESTIONS(${orphanCount})`)
    }
  }

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

// ── CROSS-STAGE: consistency checks ─────────────────────────────────────────

/**
 * Cross-stage check: Classify → Read consistency.
 * If classify says visible but read says mostly unreadable, the bbox may be wrong.
 * @param {object} classifyResult - Normalized classify result
 * @param {object} readResult - Normalized read answer result (AI1)
 * Returns { severity, warnings, metrics }
 */
export function validateClassifyReadConsistency(classifyResult, readResult) {
  const warnings = []
  const metrics = {}
  const aligned = Array.isArray(classifyResult?.alignedQuestions) ? classifyResult.alignedQuestions : []
  const answers = Array.isArray(readResult?.answers) ? readResult.answers : []

  const visibleIds = new Set(aligned.filter((q) => q.visible).map((q) => q.questionId))
  const readById = new Map(answers.map((a) => [a.questionId, a]))

  let visibleUnreadable = 0
  let visibleTotal = 0
  for (const id of visibleIds) {
    visibleTotal++
    const answer = readById.get(id)
    if (!answer || answer.status === 'unreadable') visibleUnreadable++
  }

  const unreadableRate = visibleTotal > 0 ? visibleUnreadable / visibleTotal : 0
  metrics.visibleTotal = visibleTotal
  metrics.visibleUnreadable = visibleUnreadable
  metrics.unreadableRate = +unreadableRate.toFixed(3)

  if (visibleTotal >= 3 && unreadableRate > 0.5) {
    warnings.push(`FAIL:CROSS_CLASSIFY_READ_HIGH_UNREADABLE(${visibleUnreadable}/${visibleTotal})`)
  }

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

/**
 * Cross-stage check: Read → Accessor consistency.
 * If read got non-blank answers but accessor scored all 0, something is wrong.
 * @param {object} readResult - Normalized read answer result
 * @param {object} accessorResult - Parsed accessor result
 * Returns { severity, warnings, metrics }
 */
export function validateReadAccessorConsistency(readResult, accessorResult) {
  const warnings = []
  const metrics = {}
  const answers = Array.isArray(readResult?.answers) ? readResult.answers : []
  const scores = Array.isArray(accessorResult?.scores) ? accessorResult.scores : []

  const readIds = new Set(
    answers.filter((a) => a.status === 'read' && (a.studentAnswerRaw ?? '').trim()).map((a) => a.questionId)
  )
  const scoreById = new Map(scores.map((s) => [s.questionId, s]))

  let readButZeroCount = 0
  let readAndScoredCount = 0
  for (const id of readIds) {
    const s = scoreById.get(id)
    if (!s) continue
    readAndScoredCount++
    if (toFiniteNumber(s.score) === 0) readButZeroCount++
  }

  metrics.readAndScoredCount = readAndScoredCount
  metrics.readButZeroCount = readButZeroCount
  const zeroRate = readAndScoredCount > 0 ? readButZeroCount / readAndScoredCount : 0
  metrics.readButZeroRate = +zeroRate.toFixed(3)

  if (readAndScoredCount >= 5 && zeroRate > 0.8) {
    warnings.push(`CROSS_READ_ACCESSOR_ALL_ZERO(${readButZeroCount}/${readAndScoredCount})`)
  }

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

// ── Remaining original validators (unchanged structure, added severity) ──────

function validateGradingLocateResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('FAIL:GRADING_LOCATE_JSON_PARSE_FAILED')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
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

  if (locatedQuestions.length === 0) warnings.push('FAIL:GRADING_LOCATE_EMPTY')
  if (withQuestionBboxCount === 0 && withAnswerBboxCount === 0) {
    warnings.push('FAIL:GRADING_LOCATE_BBOX_EMPTY')
  }

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

function validateGradingRecheckResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('FAIL:GRADING_RECHECK_JSON_PARSE_FAILED')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
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

  if (results.length === 0) warnings.push('FAIL:GRADING_RECHECK_RESULTS_EMPTY')
  if (missingQuestionIdCount > 0) warnings.push('GRADING_RECHECK_QUESTION_ID_MISSING')
  if (missingReasonCount > 0) warnings.push('GRADING_RECHECK_REASON_MISSING')

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

function validateAnswerKeyResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('FAIL:ANSWER_KEY_JSON_PARSE_FAILED')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
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
    warnings.push('FAIL:ANSWER_KEY_QUESTIONS_EMPTY')
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

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

// ── ANSWER KEY EXTRACT: deep validation ─────────────────────────────────────
const VALID_QUESTION_CATEGORIES = new Set([
  // Bucket A
  'single_choice', 'multi_choice', 'circle_select_one', 'circle_select_many',
  'single_check', 'multi_check', 'true_false', 'fill_blank', 'multi_fill',
  'matching', 'ordering', 'mark_in_text',
  'calculation', 'word_problem',
  // Bucket B
  'fill_variants', 'map_fill',
  // Bucket C
  'short_answer',
  'map_symbol', 'grid_geometry', 'connect_dots',
  'diagram_draw', 'diagram_color',
  // Bucket D
  'compound_circle_with_explain', 'compound_check_with_explain',
  'compound_writein_with_explain', 'multi_check_other',
  'compound_judge_with_correction', 'compound_judge_with_explain',
  'compound_chain_table'
])

// Categories that MUST have a non-empty answer or referenceAnswer
// 跟 redpenai/src/lib/gemini.ts 的 AK_ANSWER_REQUIRED 同步
const ANSWER_REQUIRED_CATEGORIES = new Set([
  // Bucket A
  'single_choice', 'multi_choice', 'circle_select_one', 'circle_select_many',
  'single_check', 'multi_check', 'true_false', 'fill_blank', 'multi_fill',
  'matching', 'ordering', 'mark_in_text',
  'calculation', 'word_problem',
  // Bucket B
  'fill_variants',
  // Bucket C（referenceAnswer + rubricsDimensions）
  'short_answer',
  'map_symbol', 'grid_geometry', 'connect_dots',
  'diagram_draw', 'diagram_color',
  // Bucket D（compound_chain_table 例外，純 rubric）
  'compound_circle_with_explain', 'compound_check_with_explain',
  'compound_writein_with_explain', 'multi_check_other',
  'compound_judge_with_correction', 'compound_judge_with_explain'
])

/**
 * Deep answer key quality gate — called AFTER parsing answer key extraction result.
 * Validates the extracted answer key for completeness and correctness.
 * @param {object} answerKey - Parsed answer key { questions, totalScore }
 * @param {number} [expectedPageCount] - Number of answer key images (for page-proportional check)
 * Returns { severity, warnings, metrics }
 */
export function validateAnswerKeyQuality(answerKey, expectedPageCount) {
  const warnings = []
  const metrics = {}
  const questions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  const totalScore = toFiniteNumber(answerKey?.totalScore)

  metrics.questionCount = questions.length
  metrics.totalScore = totalScore

  // ── Too few questions ──
  if (questions.length === 0) {
    warnings.push('FAIL:AK_NO_QUESTIONS')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
  }
  if (questions.length < 3) {
    warnings.push('FAIL:AK_TOO_FEW_QUESTIONS(' + questions.length + ')')
  }

  // ── Duplicate questionId ──
  const idCounts = new Map()
  for (const q of questions) {
    const id = String(q?.id || '').trim()
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }
  const duplicateIds = Array.from(idCounts.entries()).filter(([, c]) => c > 1).map(([id]) => id)
  metrics.duplicateIdCount = duplicateIds.length
  if (duplicateIds.length > 0) {
    warnings.push(`FAIL:AK_DUPLICATE_IDS(${duplicateIds.join(',')})`)
  }

  // ── Missing or invalid questionId ──
  const missingIdCount = questions.filter((q) => !String(q?.id || '').trim()).length
  metrics.missingIdCount = missingIdCount
  if (missingIdCount > 0) {
    warnings.push(`FAIL:AK_MISSING_IDS(${missingIdCount})`)
  }

  // ── maxScore validation ──
  const zeroMaxScoreCount = questions.filter((q) => {
    const ms = toFiniteNumber(q?.maxScore)
    return ms === null || ms <= 0
  }).length
  metrics.zeroMaxScoreCount = zeroMaxScoreCount
  if (zeroMaxScoreCount > 0) {
    warnings.push(`AK_ZERO_MAX_SCORE(${zeroMaxScoreCount})`)
  }

  // ── totalScore vs sum check ──
  const scoreSum = questions.reduce((sum, q) => sum + (toFiniteNumber(q?.maxScore) ?? 0), 0)
  metrics.maxScoreSum = scoreSum
  if (totalScore !== null && Math.abs(totalScore - scoreSum) > 1) {
    warnings.push(`FAIL:AK_TOTAL_SCORE_MISMATCH(total=${totalScore},sum=${scoreSum})`)
  }

  // ── Invalid questionCategory ──
  const invalidCategoryCount = questions.filter((q) => {
    const cat = typeof q?.questionCategory === 'string' ? q.questionCategory.trim() : ''
    return cat && !VALID_QUESTION_CATEGORIES.has(cat)
  }).length
  metrics.invalidCategoryCount = invalidCategoryCount
  if (invalidCategoryCount > 0) {
    warnings.push(`FAIL:AK_INVALID_CATEGORY(${invalidCategoryCount})`)
  }

  // ── Missing answer for answer-required categories ──
  // "?" is a common AI placeholder when it can't read the answer — treat as missing
  const PLACEHOLDER_ANSWERS = new Set(['?', '？', '未知', 'unknown', 'N/A', 'n/a'])
  let missingAnswerCount = 0
  for (const q of questions) {
    const cat = typeof q?.questionCategory === 'string' ? q.questionCategory.trim() : ''
    if (!ANSWER_REQUIRED_CATEGORIES.has(cat)) continue
    const answer = typeof q?.answer === 'string' ? q.answer.trim() : ''
    const ref = typeof q?.referenceAnswer === 'string' ? q.referenceAnswer.trim() : ''
    if ((!answer || PLACEHOLDER_ANSWERS.has(answer)) && (!ref || PLACEHOLDER_ANSWERS.has(ref))) missingAnswerCount++
  }
  metrics.missingAnswerCount = missingAnswerCount
  if (missingAnswerCount > 0) {
    warnings.push(`AK_MISSING_ANSWER(${missingAnswerCount})`)
  }

  // ── Page-proportional check (multi-page: expect roughly ≥3 questions per page) ──
  if (expectedPageCount && expectedPageCount > 1) {
    const questionsPerPage = questions.length / expectedPageCount
    metrics.questionsPerPage = +questionsPerPage.toFixed(1)
    if (questionsPerPage < 2) {
      warnings.push(`FAIL:AK_TOO_FEW_PER_PAGE(${metrics.questionsPerPage}/page)`)
    }
  }

  // ── Multi-page ID prefix check (if multi-page, all questions should have page prefix) ──
  if (expectedPageCount && expectedPageCount > 1) {
    const withPrefix = questions.filter((q) => /^\d+-/.test(String(q?.id || ''))).length
    const withoutPrefix = questions.length - withPrefix
    metrics.missingPagePrefix = withoutPrefix
    if (withoutPrefix > 0 && withPrefix > 0) {
      // Mixed: some have prefix, some don't — likely AI inconsistency
      warnings.push(`AK_MIXED_PAGE_PREFIX(${withoutPrefix}_missing)`)
    }
  }

  // ── rubricsDimensions score mismatch (dimension sum != question maxScore) ──
  let dimMismatchCount = 0
  for (const q of questions) {
    const dims = Array.isArray(q?.rubricsDimensions) ? q.rubricsDimensions : []
    if (dims.length === 0) continue
    const dimSum = dims.reduce((sum, d) => sum + (toFiniteNumber(d?.maxScore) ?? 0), 0)
    const qMax = toFiniteNumber(q?.maxScore)
    if (qMax !== null && Math.abs(dimSum - qMax) > 0.5) dimMismatchCount++
  }
  metrics.dimMismatchCount = dimMismatchCount
  if (dimMismatchCount > 0) {
    warnings.push(`AK_DIM_SCORE_MISMATCH(${dimMismatchCount})`)
  }

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

function validateTeacherSummaryResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('FAIL:TEACHER_SUMMARY_JSON_PARSE_FAILED')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
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

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

function validateDomainDiagnosisResponse(data) {
  const warnings = []
  const metrics = {}
  const parsed = tryParseCandidateJson(data)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('FAIL:DOMAIN_DIAGNOSIS_JSON_PARSE_FAILED')
    return { warnings, metrics, severity: QG_SEVERITY.FAIL }
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

  return { warnings, metrics, severity: severityFromWarnings(warnings) }
}

function validateUnknownResponse(data) {
  const warnings = []
  const metrics = {}
  const hasCandidates = Array.isArray(data?.candidates) && data.candidates.length > 0
  metrics.hasCandidates = hasCandidates
  if (!hasCandidates) warnings.push('MODEL_RESPONSE_CANDIDATES_EMPTY')
  return { warnings, metrics, severity: severityFromWarnings(warnings) }
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
