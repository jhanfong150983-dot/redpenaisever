# AI Grading 4-Stage Router + Pipeline Spec

## 1. Objective

Replace the current single-shot grading flow with a staged pipeline so each AI call focuses on one task only.

Stages:

1. `classify` (question alignment)
2. `ReadAnswer` (student answer extraction)
3. `Accessor` (scoring against answer key; naming kept as requested)
4. `explain` (reason generation)

Each stage output is the next stage input.

---

## 2. Scope

In scope:

- Grading flow only (`grading.evaluate` equivalent path).
- Router + pipeline wiring on server.
- Data contract between stages.
- Error handling and fallback.

Out of scope:

- Answer key extraction flow (`answer_key.extract`, `answer_key.reanalyze`).
- UI redesign.
- Ink billing logic changes.

---

## 3. Compatibility Strategy

To avoid front-end breakage:

- Keep external entry route: `grading.evaluate`.
- Internally execute 4-stage pipeline.
- Return payload compatible with current `GradingResult`.

This means front-end can remain unchanged initially.

---

## 4. Route Keys

Add stage-level route keys:

- `grading.classify`
- `grading.read_answer`
- `grading.accessor`
- `grading.explain`

Keep:

- `grading.evaluate` (external compatibility route, internally orchestrates 4 stages)

---

## 5. Shared Context Contract

All stages receive and return a shared context envelope.

```json
{
  "pipelineRunId": "uuid",
  "assignmentId": "string",
  "submissionId": "string",
  "studentId": "string",
  "domain": "string|null",
  "timestamps": {
    "startedAt": 0,
    "updatedAt": 0
  },
  "assets": {
    "submissionImage": {
      "mimeType": "image/jpeg",
      "base64": "..."
    }
  },
  "answerKey": {
    "questions": [],
    "totalScore": 0
  },
  "trace": []
}
```

Notes:

- `submissionImage` should be prepared once and reused by all stages.
- `trace` appends one record per stage (`latencyMs`, `warnings`, `metrics`, `model`).

---

## 6. Stage Contracts

### 6.1 Stage 1: classify

Purpose:

- Align question IDs from answer key to visible regions in student sheet.

Input:

```json
{
  "questionIds": ["1", "2", "3-1"],
  "submissionImage": {},
  "hints": {
    "layoutMode": "auto"
  }
}
```

Output:

```json
{
  "alignedQuestions": [
    {
      "questionId": "1",
      "visible": true,
      "bbox": { "x": 0.1, "y": 0.2, "w": 0.2, "h": 0.08 },
      "confidence": 92,
      "notes": ""
    }
  ],
  "coverage": 0.9,
  "unmappedQuestionIds": ["3-1"]
}
```

Validation:

- `questionId` must exist in answer key.
- `coverage` in `[0, 1]`.

Fallback:

- If stage fails fully: mark run `needsReview=true`, abort next stages.
- If partial: continue with unmapped questions tagged as unresolved.

### 6.2 Stage 2: ReadAnswer

Purpose:

- Extract raw student answer per aligned question.

Input:

```json
{
  "alignedQuestions": [],
  "submissionImage": {}
}
```

Output:

```json
{
  "answers": [
    {
      "questionId": "1",
      "studentAnswerRaw": "text",
      "readConfidence": 88,
      "status": "read|blank|unreadable",
      "evidence": ""
    }
  ]
}
```

Validation:

- one record max per `questionId`.
- `status` must be enum.

Fallback:

- missing answer -> synthesize:
  - `studentAnswerRaw="unreadable"`
  - `status="unreadable"`
  - `readConfidence=0`

### 6.3 Stage 3: Accessor

Purpose:

- Score each question against answer key (no explanation writing beyond compact scoring reason).

Input:

```json
{
  "answers": [],
  "answerKey": {}
}
```

Output:

```json
{
  "scores": [
    {
      "questionId": "1",
      "score": 2,
      "maxScore": 5,
      "isCorrect": false,
      "matchType": "exact|semantic|rubric|blank|unreadable",
      "scoringReason": "short reason",
      "scoreConfidence": 79
    }
  ],
  "totalScore": 2
}
```

Validation:

- `0 <= score <= maxScore`.
- `totalScore == sum(scores[].score)`.

Fallback:

- invalid score row -> clamp to `[0, maxScore]`.
- irrecoverable row -> force `score=0`, `isCorrect=false`, `matchType="unreadable"`.

### 6.4 Stage 4: explain

Purpose:

- Generate review-ready explanations and summary artifacts.

Input:

```json
{
  "answers": [],
  "scores": [],
  "answerKey": {},
  "domain": "string|null"
}
```

Output:

```json
{
  "details": [
    {
      "questionId": "1",
      "reason": "full reason",
      "mistakeType": "concept|calculation|condition|blank|unreadable"
    }
  ],
  "mistakes": [],
  "weaknesses": [],
  "suggestions": []
}
```

Validation:

- `details[].questionId` must exist in `scores`.
- `reason` non-empty for incorrect answers.

Fallback:

- if stage 4 fails, keep scoring result and set generic reason:
  - `"reason": "Explanation unavailable, manual review recommended."`

---

## 7. Final Assembly (Compatibility Output)

Assembler combines stage outputs into existing `GradingResult` schema:

```json
{
  "totalScore": 0,
  "details": [
    {
      "questionId": "1",
      "studentAnswer": "from ReadAnswer",
      "isCorrect": false,
      "score": 0,
      "maxScore": 5,
      "reason": "from explain",
      "confidence": 0
    }
  ],
  "mistakes": [],
  "weaknesses": [],
  "suggestions": [],
  "needsReview": true,
  "reviewReasons": []
}
```

Rules:

- `studentAnswer` strictly from `ReadAnswer`.
- `score/isCorrect` strictly from `Accessor`.
- `reason` primarily from `explain`; fallback to `Accessor.scoringReason`.

---

## 8. Error Model

Per-stage status:

- `ok`
- `partial`
- `failed`

Pipeline stop policy:

- Stop immediately on `classify.failed`.
- Continue on `ReadAnswer.partial`, `Accessor.partial`, `explain.failed`.

Review policy:

- Any non-`ok` stage sets `needsReview=true`.
- Append normalized `reviewReasons` with stage prefix.

---

## 9. Suggested Server Changes

Files to update:

- `server/ai/routes.js`
  - add new stage route keys.
- `server/ai/pipelines.js`
  - register new stage pipelines.
- `server/ai/orchestrator.js`
  - add internal staged orchestrator for `grading.evaluate`.
- `api/proxy.js`
  - keep external API unchanged; invoke staged path for grading.
- `server/ai/quality-gates.js`
  - add per-stage validators.

Minimal architecture:

1. `runAiPipeline` remains generic single-call runner.
2. Add `runGradingEvaluateStaged` orchestrator that calls `runAiPipeline` 4 times internally.
3. Return compatibility response to client.

---

## 10. Rollout Plan

Phase 1: Shadow mode

- Run staged pipeline in parallel for sampled requests.
- Do not affect user-visible grading result.
- Log diff vs current single-shot output.

Phase 2: Soft switch

- Enable staged output for internal/test accounts.
- Keep single-shot fallback toggle.

Phase 3: Full switch

- Default staged path for all users.
- Keep emergency fallback flag for one release cycle.

---

## 11. Test Checklist

Contract tests:

- each stage schema validation passes for normal and edge cases.
- missing field / wrong enum is caught.

Flow tests:

- full success path.
- classify partial + downstream continuation.
- explain failure + scoring preserved.

Consistency tests:

- final `totalScore` equals detail score sum.
- no missing `questionId` in final details.

Regression tests:

- front-end can parse staged compatibility output with no UI code change.

---

## 12. Naming Note

Requested stage name is `Accessor`.

If you want clearer semantics later, rename internally to `Assessor` while preserving external route alias:

- `grading.accessor` (external alias, backward compatible)
- `grading.assessor` (internal canonical)

