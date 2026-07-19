import {
  isVertexEnabled,
  buildVertexModelUrl,
  getVertexAccessToken
} from './vertex-auth.js'

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

function get429RetryConfig() {
  const retryRaw = Number(process.env.GEMINI_429_RETRY_COUNT)
  const backoffRaw = Number(process.env.GEMINI_429_RETRY_BACKOFF_MS)
  // 2026-06-29 預設 2→4：併發提高後撞 429 機率上升，多重試幾次（搭配 Retry-After 精準等待）才不會直接失敗。
  const retryCount = Number.isFinite(retryRaw) ? Math.max(0, Math.round(retryRaw)) : 4
  const backoffMs = Number.isFinite(backoffRaw) ? Math.max(1000, Math.round(backoffRaw)) : 15000
  return { retryCount, backoffMs }
}

// 429 等多久：優先用伺服器給的 Retry-After header / Google RetryInfo（精準）；否則回 null 由呼叫端用 jitter 退避。
function parse429RetryAfterMs(response, data) {
  try {
    const h = response?.headers?.get?.('retry-after')
    if (h) {
      const secs = Number(h)
      if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
      const dateMs = Date.parse(h)
      if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
    }
  } catch { /* ignore */ }
  try {
    const details = data?.error?.details
    if (Array.isArray(details)) {
      for (const d of details) {
        const rd = d?.retryDelay
        if (typeof rd === 'string') {
          const m = rd.match(/^([\d.]+)s$/)
          if (m) return Math.round(parseFloat(m[1]) * 1000)
        }
      }
    }
  } catch { /* ignore */ }
  return null
}

// Calls a single model. Returns { ok, status, data, modelPath, url, is503 }.
// 504 is retried on the same model with exponential backoff.
// 429 is retried with a fixed backoff (rate limit).
// 503 is NOT retried here — caller should switch to a fallback model.
async function callSingleModel({ apiKey, model, contents, payload, timeoutMs }) {
  const modelPath = String(model).startsWith('models/')
    ? String(model)
    : `models/${model}`
  // 2026-07-16: AI_PROVIDER=vertex → 走廠商 Vertex AI（SA JSON 認證、global endpoint）。
  //   request/response body 兩邊 schema 相同，只差 URL 與 auth header；重試邏輯共用。
  //   kill switch：Vercel 拿掉 AI_PROVIDER 即回退 generativelanguage + API key。
  const useVertex = isVertexEnabled()
  const url = useVertex
    ? buildVertexModelUrl(model)
    : `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${apiKey}`
  const { retryCount, baseBackoffMs } = getRetryConfig()
  const { retryCount: retry429Count, backoffMs: backoff429Ms } = get429RetryConfig()
  const hasTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
  const effectiveTimeoutMs = hasTimeout ? Math.max(1000, Number(timeoutMs)) : null

  let attempts429 = 0
  let attempts401 = 0

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = hasTimeout ? new AbortController() : null
    const timeoutHandle = hasTimeout
      ? setTimeout(() => {
          controller.abort()
        }, effectiveTimeoutMs)
      : null

    let response
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (useVertex) {
        headers.Authorization = `Bearer ${await getVertexAccessToken()}`
      }
      response = await fetch(url, {
        method: 'POST',
        headers,
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
      // 2026-06-30: 網路層 "fetch failed"（ECONNRESET / socket hang up / 連線被斷）= 暫時性 → 比照 504 重試。
      //   高併發時偶發連線斷掉，不重試會讓整份卷的 read 失敗(500)。耗盡 504 retry budget 才丟。
      if (attempt < retryCount) {
        const backoffMs = Math.min(baseBackoffMs * 2 ** attempt, 8000)
        console.warn(`[ai-model-adapter] fetch failed model=${model} retry=${attempt + 1}/${retryCount} waitMs=${backoffMs} err=${error?.message || error}`)
        if (timeoutHandle) clearTimeout(timeoutHandle)
        await sleep(backoffMs)
        continue
      }
      throw error
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    }

    const rawText = await response.text()
    const data = parseResponseBody(rawText)

    // 401 = Vertex token 失效（提早撤銷/時鐘漂移）— 強制刷新一次再試，不消耗 504 retry budget。
    if (useVertex && Number(response.status) === 401 && attempts401 < 1) {
      attempts401 += 1
      console.warn(`[ai-model-adapter] vertex 401 model=${model} — force token refresh and retry`)
      await getVertexAccessToken({ forceRefresh: true })
      attempt -= 1
      continue
    }

    // 503 = model overloaded — 2026-06-30：改成「同模型退避重試」，不降階換模型。
    //   原因：降階到別的 model 會讓批改結果在不同 model 間不一致（違反「精準度跨次一致」目標）。
    //   重試耗盡仍 503 → 下方回傳失敗（不切換 model）。
    if (Number(response.status) === 503 && attempt < retryCount) {
      const backoffMs = Math.min(baseBackoffMs * 2 ** attempt, 8000)
      console.warn(
        `[ai-model-adapter] response status=503 model=${model} retry=${attempt + 1}/${retryCount} waitMs=${backoffMs} (overload, same-model retry)`
      )
      await sleep(backoffMs)
      continue
    }

    // 429 = rate limit — 優先依 Retry-After 精準等待；否則 jitter 退避（破解 thundering herd：併發下多 call 同時被擋，
    // 若都等同一固定時間會一起重試又一起撞）。獨立於 504 retry counter。
    if (Number(response.status) === 429 && attempts429 < retry429Count) {
      attempts429 += 1
      const retryAfterMs = parse429RetryAfterMs(response, data)
      const jittered = Math.round(backoff429Ms * (0.5 + Math.random())) // 0.5x–1.5x
      const waitMs = Math.min(
        retryAfterMs != null ? retryAfterMs + Math.round(Math.random() * 1000) : jittered,
        60000
      )
      console.warn(
        `[ai-model-adapter] response status=429 model=${model} retry429=${attempts429}/${retry429Count} waitMs=${waitMs}${retryAfterMs != null ? ' (Retry-After)' : ' (jitter)'}`
      )
      await sleep(waitMs)
      attempt -= 1  // don't consume 504 retry budget
      continue
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
  const tc = payload?.generationConfig?.thinkingConfig
  if (!tc) return payload
  // 只移除 thinking LEVEL（thinking_level/thinkingLevel）——2.5-flash 等不支援、會 400
  // （"Thinking level is not supported"）。保留 thinkingBudget（整數預算、2.5-flash 也吃、實測 status 200），
  // 讓家長報告診斷等 route 能在 2.5-flash 上限制 thinking 預算（治 dynamic thinking 拖到 ~100s）。
  const { thinking_level: _l1, thinkingLevel: _l2, ...restTc } = tc
  const newGen = { ...payload.generationConfig }
  if (Object.keys(restTc).length > 0) newGen.thinkingConfig = restTc
  else delete newGen.thinkingConfig
  return { ...payload, generationConfig: newGen }
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

  // 2026-07-17: 3.5-flash 解除 strip（exp-read-thinking-2026-07-17 判決）：read 開 MINIMAL 品質同或略好
  //   （L1 放行真錯 5.1%→3.8%、NR 持平）、call 快 2.3x、thoughts 歸零（兩讀成本 -28%）。
  //   探針：3.5-flash 吃 MINIMAL/LOW；2.5-flash 仍 400（"Thinking level is not supported"）；Pro 未驗證。
  //   → 白名單只放 3.5-flash；帶 thinkingConfig 進來的只有 READ_ANSWER/VJ_GRADE 兩個 config
  //   （classify 不帶、5/20 pixel bbox 舊案不受影響）。kill switch：THINKING_STRIP_ALL='1' 回全 strip。
  const supportsThinkingLevel = (m) => typeof m === 'string' && /3\.5-flash/i.test(m)
    && process.env.THINKING_STRIP_ALL !== '1'

  for (let i = 0; i < allModels.length; i++) {
    const currentModel = allModels[i]
    const shouldStrip = i > 0 || !supportsThinkingLevel(currentModel)
    const effectivePayload = shouldStrip ? stripThinkingConfig(payload) : payload
    if (i > 0) {
      console.warn(
        `[ai-model-adapter] 503-fallback switching to model=${currentModel} fallbackIndex=${i}`
      )
    }
    // 2026-05-17: 拿掉 strip thinkingConfig log（每個 Pro call 都印一次、純雜訊）

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
