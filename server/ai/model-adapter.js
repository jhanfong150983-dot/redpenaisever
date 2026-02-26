function parseResponseBody(rawText) {
  if (typeof rawText !== 'string') return {}
  try {
    return JSON.parse(rawText)
  } catch {
    return { raw: rawText }
  }
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

  return {
    ok: response.ok,
    status: response.status,
    data,
    modelPath,
    url
  }
}

