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

function get504RetryConfig() {
  const retryRaw = Number(process.env.GEMINI_504_RETRY_COUNT)
  const baseBackoffRaw = Number(process.env.GEMINI_504_RETRY_BACKOFF_MS)

  // Retry twice on timeout by default (3 total attempts).
  const retryCount = Number.isFinite(retryRaw) ? Math.max(1, Math.round(retryRaw)) : 2
  const baseBackoffMs = Number.isFinite(baseBackoffRaw)
    ? Math.max(100, Math.round(baseBackoffRaw))
    : 800

  return { retryCount, baseBackoffMs }
}

export async function callGeminiGenerateContent({
  apiKey,
  model,
  contents,
  payload = {},
  timeoutMs = 55000
}) {
  const modelPath = String(model).startsWith('models/')
    ? String(model)
    : `models/${model}`
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${apiKey}`
  const { retryCount, baseBackoffMs } = get504RetryConfig()

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => {
      controller.abort()
    }, Math.max(1000, timeoutMs))

    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, ...payload }),
        signal: controller.signal
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        // Pipeline budget exhausted — throw immediately, no retry.
        console.warn(`[ai-model-adapter] timeout status=504 budgetExhausted=true`)
        const timeoutError = new Error('Gemini request timeout')
        timeoutError.status = 504
        throw timeoutError
      }
      throw error
    } finally {
      clearTimeout(timeoutHandle)
    }

    const rawText = await response.text()
    const data = parseResponseBody(rawText)

    if (Number(response.status) === 504 && attempt < retryCount) {
      const backoffMs = Math.min(baseBackoffMs * 2 ** attempt, 8000)
      console.warn(
        `[ai-model-adapter] response status=504 retry=${attempt + 1}/${retryCount} waitMs=${backoffMs}`
      )
      await sleep(backoffMs)
      continue
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      modelPath,
      url
    }
  }

  // Defensive fallback; the loop should always return or throw earlier.
  const timeoutError = new Error('Gemini request timeout')
  timeoutError.status = 504
  throw timeoutError
}
