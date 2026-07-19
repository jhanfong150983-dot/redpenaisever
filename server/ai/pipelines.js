import { AI_ROUTE_KEYS } from './routes.js'
import { validateResponseByRoute } from './quality-gates.js'

// Gemini generateContent 允許的 body 欄位；app 層欄位（assignmentId/submissionId 等）
// 若隨 payload spread 進 Gemini body 會 400（Unknown name）。單次呼叫路徑（executeSinglePipelineCall）
// 會把 preparedRequest.payload 原樣 spread 給 Gemini，故在此白名單過濾。
// 2026-07-19：report.parent_diagnosis 是第一個在此路徑帶 assignmentId 的 route，才踩出此 latent bug。
const GEMINI_PAYLOAD_FIELDS = new Set([
  'generationConfig', 'generation_config',
  'safetySettings', 'safety_settings',
  'systemInstruction', 'system_instruction',
  'tools', 'toolConfig', 'tool_config',
  'cachedContent', 'cached_content', 'labels'
])
function pickGeminiPayload(payload) {
  if (!payload || typeof payload !== 'object') return {}
  const out = {}
  for (const k of Object.keys(payload)) if (GEMINI_PAYLOAD_FIELDS.has(k)) out[k] = payload[k]
  return out
}

function createPipeline(key, name) {
  return {
    key,
    name,
    async prepare({ model, contents, payload }) {
      return {
        model,
        contents,
        payload: pickGeminiPayload(payload)
      }
    },
    async validate({ data }) {
      return validateResponseByRoute(key, data)
    }
  }
}

const PIPELINE_REGISTRY = new Map([
  [
    AI_ROUTE_KEYS.GRADING_EVALUATE,
    createPipeline(AI_ROUTE_KEYS.GRADING_EVALUATE, 'grading-evaluate-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_CLASSIFY,
    createPipeline(AI_ROUTE_KEYS.GRADING_CLASSIFY, 'grading-classify-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_READ_ANSWER,
    createPipeline(AI_ROUTE_KEYS.GRADING_READ_ANSWER, 'grading-read-answer-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_ACCESSOR,
    createPipeline(AI_ROUTE_KEYS.GRADING_ACCESSOR, 'grading-accessor-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_LOCATE,
    createPipeline(AI_ROUTE_KEYS.GRADING_LOCATE, 'grading-locate-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_PHASE_A_CLASSIFY,
    createPipeline(AI_ROUTE_KEYS.GRADING_PHASE_A_CLASSIFY, 'grading-phase-a-classify-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_PHASE_A_READ,
    createPipeline(AI_ROUTE_KEYS.GRADING_PHASE_A_READ, 'grading-phase-a-read-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_PHASE_A_ARBITER,
    createPipeline(AI_ROUTE_KEYS.GRADING_PHASE_A_ARBITER, 'grading-phase-a-arbiter-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_PHASE_B_ACCESSOR,
    createPipeline(AI_ROUTE_KEYS.GRADING_PHASE_B_ACCESSOR, 'grading-phase-b-accessor-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_PHASE_B_EXPLAIN,
    createPipeline(AI_ROUTE_KEYS.GRADING_PHASE_B_EXPLAIN, 'grading-phase-b-explain-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_EXPLAIN,
    createPipeline(AI_ROUTE_KEYS.GRADING_EXPLAIN, 'grading-explain-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_ERROR_GUIDANCE,
    createPipeline(AI_ROUTE_KEYS.GRADING_ERROR_GUIDANCE, 'grading-error-guidance-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_GRADE_ONE,
    createPipeline(AI_ROUTE_KEYS.GRADING_GRADE_ONE, 'grading-grade-one-pipeline')
  ],
  [
    AI_ROUTE_KEYS.GRADING_RECHECK,
    createPipeline(AI_ROUTE_KEYS.GRADING_RECHECK, 'grading-recheck-pipeline')
  ],
  [
    AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT,
    createPipeline(AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT, 'answer-key-extract-pipeline')
  ],
  [
    AI_ROUTE_KEYS.ANSWER_KEY_LOCATE,
    createPipeline(AI_ROUTE_KEYS.ANSWER_KEY_LOCATE, 'answer-key-locate-pipeline')
  ],
  [
    AI_ROUTE_KEYS.ANSWER_KEY_REANALYZE,
    createPipeline(AI_ROUTE_KEYS.ANSWER_KEY_REANALYZE, 'answer-key-reanalyze-pipeline')
  ],
  [
    AI_ROUTE_KEYS.REPORT_TEACHER_SUMMARY,
    createPipeline(AI_ROUTE_KEYS.REPORT_TEACHER_SUMMARY, 'report-teacher-summary-pipeline')
  ],
  [
    AI_ROUTE_KEYS.REPORT_DOMAIN_DIAGNOSIS,
    createPipeline(AI_ROUTE_KEYS.REPORT_DOMAIN_DIAGNOSIS, 'report-domain-diagnosis-pipeline')
  ],
  [
    AI_ROUTE_KEYS.ADMIN_TAG_AGGREGATION,
    createPipeline(AI_ROUTE_KEYS.ADMIN_TAG_AGGREGATION, 'admin-tag-aggregation-pipeline')
  ],
  [
    AI_ROUTE_KEYS.UNKNOWN,
    createPipeline(AI_ROUTE_KEYS.UNKNOWN, 'generic-passthrough-pipeline')
  ]
])

export function getPipeline(routeKey) {
  return PIPELINE_REGISTRY.get(routeKey) || PIPELINE_REGISTRY.get(AI_ROUTE_KEYS.UNKNOWN)
}
