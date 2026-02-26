import { getPipeline } from './pipelines.js'
import { callGeminiGenerateContent } from './model-adapter.js'
import { normalizeRouteKey, resolveRouteKey } from './routes.js'

export async function runAiPipeline({
  apiKey,
  model,
  contents,
  payload = {},
  requestedRouteKey = null,
  routeHint = {},
  timeoutMs = 55000
}) {
  const normalizedRequestedRouteKey = normalizeRouteKey(requestedRouteKey)
  const resolvedRouteKey = resolveRouteKey({
    requestedRouteKey: normalizedRequestedRouteKey,
    contents,
    routeHint
  })

  const pipeline = getPipeline(resolvedRouteKey)
  const prepareStartedAt = Date.now()
  const preparedRequest = await pipeline.prepare({
    model,
    contents,
    payload,
    routeHint
  })
  const prepareLatencyMs = Date.now() - prepareStartedAt

  const modelStartedAt = Date.now()
  const modelResponse = await callGeminiGenerateContent({
    apiKey,
    model: preparedRequest.model,
    contents: preparedRequest.contents,
    payload: preparedRequest.payload,
    timeoutMs
  })
  const modelLatencyMs = Date.now() - modelStartedAt

  let validation = { warnings: [], metrics: {} }
  if (modelResponse.ok && modelResponse.data && typeof modelResponse.data === 'object') {
    validation = await pipeline.validate({
      data: modelResponse.data,
      request: preparedRequest,
      routeHint
    })
  }

  const warnings = Array.isArray(validation?.warnings) ? validation.warnings : []
  const metrics = validation?.metrics && typeof validation.metrics === 'object'
    ? validation.metrics
    : {}

  const pipelineMeta = {
    requestedRouteKey: normalizedRequestedRouteKey || null,
    resolvedRouteKey,
    pipeline: pipeline.name,
    prepareLatencyMs,
    modelLatencyMs,
    warnings,
    metrics
  }

  if (modelResponse.data && typeof modelResponse.data === 'object') {
    modelResponse.data._pipeline = pipelineMeta
    modelResponse.data.routeKey = resolvedRouteKey
  }

  return {
    status: modelResponse.status,
    data: modelResponse.data,
    resolvedRouteKey,
    pipelineMeta
  }
}

