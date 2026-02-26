import { AI_ROUTE_KEYS } from './routes.js'
import { validateResponseByRoute } from './quality-gates.js'

function createPipeline(key, name) {
  return {
    key,
    name,
    async prepare({ model, contents, payload }) {
      return {
        model,
        contents,
        payload: payload || {}
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
    AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT,
    createPipeline(AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT, 'answer-key-extract-pipeline')
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

