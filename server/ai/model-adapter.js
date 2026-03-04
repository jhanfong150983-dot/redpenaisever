function parseResponseBody(rawText) {
  if (typeof rawText !== 'string') return {}
  try {
    return JSON.parse(rawText)
  } catch {
    return { raw: rawText }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getRetryConfig() {
  const retryRaw = Number(process.env.GEMINI_504_RETRY_COUNT)
  const baseBackoffRaw = Number(process.env.GEMINI_504_RETRY_BACKOFF_MS)

  // Retry twice on timeout/overload by default (3 total attempts).
  const retryCount = Number.isFinite(retryRaw) ? Math.max(1, Math.round(retryRaw)) : 2
  const baseBackoffMs = Number.isFinite(baseBackoffRaw)
    ? Math.max(100, Math.round(baseBackoffRaw))
    : 800

  return { retryCount, baseBackoffMs }
}

// Calls a single model. Returns { ok, status, data, modelPath, url, is503 }.
// 504 is retried on the same model with exponential backoff.
// 503 is NOT retried here — caller should switch to a fallback model.
async function callSingleModel({ apiKey, model, contents, payload, timeoutMs }) {
  const modelPath = String(model).startsWith('models/')
    ? String(model)
    : `models/${model}`
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${apiKey}`
  const { retryCount, baseBackoffMs } = getRetryConfig()
  const hasTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
  const effectiveTimeoutMs = hasTimeout ? Math.max(1000, Number(timeoutMs)) : null

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = hasTimeout ? new AbortController() : null
    const timeoutHandle = hasTimeout
      ? setTimeout(() => {
          controller.abort()
        }, effectiveTimeoutMs)
      : null

    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, ...payload }),
        ...(controller ? { signal: controller.signal } : {})
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        // Pipeline budget exhausted — throw immediately, no retry.
        console.warn(`[ai-model-adapter] timeout status=504 model=${model} budgetExhausted=true`)
        const timeoutError = new Error('Gemini request timeout')
        timeoutError.status = 504
        throw timeoutError
      }
      throw error
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    }

    const rawText = await response.text()
    const data = parseResponseBody(rawText)

    // 503 = model overloaded — signal caller to switch to fallback model, don't retry same model.
    if (Number(response.status) === 503) {
      return { ok: false, status: 503, data, modelPath, url, is503: true }
    }

    // 504 = timeout — retry the same model with exponential backoff.
    if (Number(response.status) === 504 && attempt < retryCount) {
      const backoffMs = Math.min(baseBackoffMs * 2 ** attempt, 8000)
      console.warn(
        `[ai-model-adapter] response status=504 model=${model} retry=${attempt + 1}/${retryCount} waitMs=${backoffMs}`
      )
      await sleep(backoffMs)
      continue
    }

    return { ok: response.ok, status: response.status, data, modelPath, url }
  }

  // Defensive fallback; the loop should always return or throw earlier.
  const timeoutError = new Error('Gemini request timeout')
  timeoutError.status = 504
  throw timeoutError
}

function stripThinkingConfig(payload) {
  if (!payload?.generationConfig?.thinkingConfig) return payload
  const { thinkingConfig: _removed, ...restGenConfig } = payload.generationConfig
  return { ...payload, generationConfig: restGenConfig }
}

// Calls Gemini with automatic model fallback on 503.
// If the primary model returns 503, tries each model in fallbackModels in order.
// thinkingConfig is stripped from the payload for fallback models, as they may
// use different thinking APIs or not support it at all.
export async function callGeminiGenerateContent({
  apiKey,
  model,
  contents,
  payload = {},
  timeoutMs,
  fallbackModels = []
}) {
  const allModels = [model, ...fallbackModels]
  let lastResult = null

  for (let i = 0; i < allModels.length; i++) {
    const currentModel = allModels[i]
    const effectivePayload = i > 0 ? stripThinkingConfig(payload) : payload
    if (i > 0) {
      console.warn(
        `[ai-model-adapter] 503-fallback switching to model=${currentModel} fallbackIndex=${i}`
      )
    }

    const result = await callSingleModel({
      apiKey,
      model: currentModel,
      contents,
      payload: effectivePayload,
      timeoutMs
    })
    lastResult = result

    if (result.is503 && i < allModels.length - 1) {
      console.warn(
        `[ai-model-adapter] 503 on model=${currentModel} will try fallback=${allModels[i + 1]}`
      )
      continue
    }

    // Success or no more fallbacks — strip internal flag and return.
    const { is503, ...cleanResult } = result
    return cleanResult
  }

  // All models returned 503.
  console.warn(
    `[ai-model-adapter] all models exhausted on 503 lastModel=${allModels[allModels.length - 1]}`
  )
  const { is503, ...cleanResult } = lastResult
  return cleanResult
}
