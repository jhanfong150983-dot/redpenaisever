import { handleCors } from '../server/_cors.js'
// api/proxy.js
// 這段程式碼在 Vercel 的伺服器上執行，前端看不到

// 強制使用 Node.js runtime，避免 Edge runtime 的限制
export const config = {
  runtime: 'nodejs'
}

import { getAuthUser } from '../server/_auth.js'
import { getSupabaseAdmin } from '../server/_supabase.js'
import { getEnvValue } from '../server/_env.js'
import { runAiPipeline } from '../server/ai/orchestrator.js'
import crypto from 'crypto'

// 🆕 AnswerKey 緩存（按 user + hash 存儲）
// 使用 Map 作為簡單的內存緩存，每個 Vercel 實例獨立
// 實際生產環境可考慮使用 Redis/Upstash
const answerKeyCache = new Map()
const ANSWER_KEY_CACHE_TTL = 30 * 60 * 1000 // 30 分鐘過期

/**
 * 計算 AnswerKey 的 hash（用作緩存 key）
 */
function computeAnswerKeyHash(answerKey) {
  const json = JSON.stringify(answerKey)
  return crypto.createHash('md5').update(json).digest('hex').slice(0, 16)
}

function normalizeAnswerKeyPayload(rawAnswerKey, logPrefix = '[proxy]') {
  if (!rawAnswerKey) return null
  if (typeof rawAnswerKey === 'object') return rawAnswerKey
  if (typeof rawAnswerKey === 'string') {
    const trimmed = rawAnswerKey.trim()
    if (!trimmed) return null
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') return parsed
      console.warn(`${logPrefix} answerKey-parse-failed reason=not_object`)
      return null
    } catch (error) {
      console.warn(`${logPrefix} answerKey-parse-failed reason=invalid_json`)
      return null
    }
  }
  console.warn(`${logPrefix} answerKey-parse-failed reason=unsupported_type type=${typeof rawAnswerKey}`)
  return null
}

function readSingleHeaderValue(value) {
  if (Array.isArray(value)) return value[0]
  return value
}

function normalizeGradingPipelineMode(rawMode) {
  const mode = String(rawMode || '')
    .trim()
    .toLowerCase()
  if (!mode) return null
  if (['single', 'single-shot', 'legacy'].includes(mode)) return 'single'
  if (['staged', '4stage', 'four-stage'].includes(mode)) return 'staged'
  if (['auto', 'default'].includes(mode)) return 'auto'
  return null
}

function normalizeReadAnswerSplitMode(rawValue) {
  if (typeof rawValue === 'boolean') return rawValue
  const value = String(rawValue || '')
    .trim()
    .toLowerCase()
  if (!value) return null
  if (['1', 'true', 'on', 'split', 'staged'].includes(value)) return true
  if (['0', 'false', 'off', 'legacy', 'single', 'single-shot'].includes(value)) return false
  return null
}

/**
 * 緩存 AnswerKey
 */
function cacheAnswerKey(userId, hash, answerKey) {
  const cacheKey = `${userId}:${hash}`
  answerKeyCache.set(cacheKey, {
    answerKey,
    expiresAt: Date.now() + ANSWER_KEY_CACHE_TTL
  })
  console.log(`📦 [AnswerKey Cache] 已緩存 ${cacheKey}`)
}

/**
 * 從緩存獲取 AnswerKey
 */
function getCachedAnswerKey(userId, hash) {
  const cacheKey = `${userId}:${hash}`
  const cached = answerKeyCache.get(cacheKey)
  
  if (!cached) {
    console.log(`❌ [AnswerKey Cache] 未找到 ${cacheKey}`)
    return null
  }
  
  if (Date.now() > cached.expiresAt) {
    console.log(`⏰ [AnswerKey Cache] 已過期 ${cacheKey}`)
    answerKeyCache.delete(cacheKey)
    return null
  }
  
  console.log(`✅ [AnswerKey Cache] 命中 ${cacheKey}`)
  return cached.answerKey
}

/**
 * 清理過期的緩存項目（定期執行）
 */
function cleanupExpiredCache() {
  const now = Date.now()
  let cleaned = 0
  for (const [key, value] of answerKeyCache.entries()) {
    if (now > value.expiresAt) {
      answerKeyCache.delete(key)
      cleaned++
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 [AnswerKey Cache] 清理了 ${cleaned} 個過期項目`)
  }
}

// 每 5 分鐘清理一次過期緩存
setInterval(cleanupExpiredCache, 5 * 60 * 1000)

/**
 * 🆕 將 AnswerKey 注入到 contents 的第一個 text part 中
 * 這樣對 Gemini 模型來說，效果和前端直接傳是一樣的
 */
function injectAnswerKeyToContents(contents, answerKey) {
  // 深拷貝避免修改原始物件
  const newContents = JSON.parse(JSON.stringify(contents))
  
  // 找到第一個 user role 的 message
  for (const content of newContents) {
    if (content.role === 'user' && Array.isArray(content.parts)) {
      // 找到第一個 text part
      for (let i = 0; i < content.parts.length; i++) {
        const part = content.parts[i]
        if (part.text && typeof part.text === 'string') {
          // 在 prompt 開頭注入 AnswerKey JSON
          // 找到適當的注入點（在「標準答案與配分」說明之前）
          const answerKeyJson = JSON.stringify(answerKey)
          const answerKeySection = `
下面是本次作業的標準答案與配分（JSON 格式）：
${answerKeyJson}
`
          // 檢查是否已經有 AnswerKey（避免重複注入）
          if (!part.text.includes('標準答案與配分（JSON 格式）')) {
            // 找到適當的位置插入（在批改流程說明之前）
            const insertMarker = '【批改流程】'
            const insertIndex = part.text.indexOf(insertMarker)
            if (insertIndex > 0) {
              part.text = part.text.slice(0, insertIndex) + answerKeySection + '\n' + part.text.slice(insertIndex)
            } else {
              // 如果找不到標記，在開頭插入
              part.text = answerKeySection + '\n' + part.text
            }
          }
          return newContents
        }
      }
    }
  }
  
  return newContents
}

const INK_EXCHANGE_RATE = 33
const INPUT_USD_PER_MILLION = 0.5
const OUTPUT_USD_PER_MILLION = 3
const PLATFORM_FEE_TWD = 1

function computeInkPoints(usageMetadata) {
  const inputTokens = Number(usageMetadata?.promptTokenCount) || 0
  const outputTokens = Number(usageMetadata?.candidatesTokenCount) || 0
  const totalTokens = Number(usageMetadata?.totalTokenCount) || inputTokens + outputTokens

  const baseUsd =
    (inputTokens / 1_000_000) * INPUT_USD_PER_MILLION +
    (outputTokens / 1_000_000) * OUTPUT_USD_PER_MILLION
  const baseTwd = baseUsd * INK_EXCHANGE_RATE
  const baseTwdRounded = Math.ceil(baseTwd)
  const platformFee = baseTwd >= 1 ? PLATFORM_FEE_TWD : 0
  const points = baseTwdRounded + platformFee

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    baseUsd,
    baseTwd,
    baseTwdRounded,
    platformFee,
    points
  }
}

// Session 有效期限：2 小時
const SESSION_TTL_MINUTES = 120

function createProxyRequestId(req) {
  const headerRequestId = req?.headers?.['x-request-id']
  if (typeof headerRequestId === 'string' && headerRequestId.trim()) {
    return headerRequestId.trim().slice(0, 48)
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function maskUserId(userId) {
  const raw = String(userId || '')
  if (!raw) return 'anonymous'
  return raw.length <= 8 ? raw : `${raw.slice(0, 4)}...${raw.slice(-4)}`
}

async function fetchAnswerSheetImagesForClassify(supabaseAdmin, userId, assignmentId) {
  try {
    const { data: assignment } = await supabaseAdmin
      .from('assignments')
      .select('id, owner_id')
      .eq('id', assignmentId)
      .maybeSingle()
    if (!assignment || assignment.owner_id !== userId) return []

    const images = []
    for (let i = 0; i < 10; i++) {
      const path = `answer-sheets/${assignmentId}/page-${i}.webp`
      const { data, error } = await supabaseAdmin.storage.from('homework-images').download(path)
      if (error || !data) break
      const buffer = Buffer.from(await data.arrayBuffer())
      images.push({ mimeType: 'image/webp', data: buffer.toString('base64') })
    }
    return images
  } catch (err) {
    console.warn('[AnswerSheet] fetchAnswerSheetImagesForClassify failed:', err?.message || err)
    return []
  }
}

async function resolveInkSession(supabaseAdmin, userId, inkSessionId) {
  if (!inkSessionId) return { ok: false, reason: 'no_session_id' }

  const { data, error } = await supabaseAdmin
    .from('ink_sessions')
    .select('id, status, expires_at')
    .eq('id', inkSessionId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.warn('Ink session query error:', error)
    return { ok: false, reason: 'query_error' }
  }
  
  if (!data) {
    console.warn('Ink session not found:', { inkSessionId, userId })
    return { ok: false, reason: 'not_found' }
  }
  
  if (data.status !== 'active') {
    console.warn('Ink session not active:', { inkSessionId, status: data.status })
    return { ok: false, reason: 'not_active', status: data.status }
  }

  const now = Date.now()
  const expiresAtMs = data.expires_at ? Date.parse(data.expires_at) : NaN
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) {
    return { ok: false, expired: true, reason: 'expired' }
  }

  try {
    // 每次活動時延長 session 過期時間（滾動式延長）
    const newExpiresAt = new Date(now + SESSION_TTL_MINUTES * 60 * 1000).toISOString()
    await supabaseAdmin
      .from('ink_sessions')
      .update({ 
        last_activity_at: new Date().toISOString(),
        expires_at: newExpiresAt  // 延長過期時間
      })
      .eq('id', inkSessionId)
      .eq('user_id', userId)
  } catch (error) {
    console.warn('Ink session activity update failed:', error)
  }

  return { ok: true }
}

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const requestId = createProxyRequestId(req)
  const logPrefix = `[proxy][${requestId}]`
  console.log(`${logPrefix} request-start method=${req.method}`)

  let user = null
  try {
    const result = await getAuthUser(req, res)
    user = result.user
  } catch (error) {
    console.error(`${logPrefix} auth-check-failed`, error?.message || error)
    res.status(500).json({ error: 'Auth check failed' })
    return
  }

  if (!user) {
    console.warn(`${logPrefix} unauthorized`)
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  console.log(`${logPrefix} auth-ok user=${maskUserId(user.id)}`)

  // AI_ACTIVE_GEMINI_KEY=primary（預設）→ 用 SECRET_API_KEY，備援 SYSTEM_GEMINI_API_KEY
  // AI_ACTIVE_GEMINI_KEY=secondary         → 用 SYSTEM_GEMINI_API_KEY，備援 SECRET_API_KEY
  const activeGeminiKey = (getEnvValue('AI_ACTIVE_GEMINI_KEY') || 'primary').toLowerCase()
  const apiKey =
    activeGeminiKey === 'secondary'
      ? (getEnvValue('SYSTEM_GEMINI_API_KEY') || getEnvValue('SECRET_API_KEY'))
      : (getEnvValue('SECRET_API_KEY') || getEnvValue('SYSTEM_GEMINI_API_KEY'))
  if (!apiKey) {
    const diagnostics = {
      cwd: process.cwd(),
      activeGeminiKey,
      hasSecretApiKeyEnv: typeof process.env.SECRET_API_KEY === 'string',
      secretApiKeyLength: String(process.env.SECRET_API_KEY || '').length,
      hasSystemApiKeyEnv: typeof process.env.SYSTEM_GEMINI_API_KEY === 'string',
      systemApiKeyLength: String(process.env.SYSTEM_GEMINI_API_KEY || '').length,
      hasSecretApiKeyLocal: Boolean(getEnvValue('SECRET_API_KEY')),
      hasSystemApiKeyLocal: Boolean(getEnvValue('SYSTEM_GEMINI_API_KEY'))
    }
    console.error(`${logPrefix} api-key-missing diagnostics:`, diagnostics)
    res.status(500).json({
      error: 'Server API Key missing (SECRET_API_KEY / SYSTEM_GEMINI_API_KEY)',
      diagnostics
    })
    return
  }

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      console.warn(`${logPrefix} bad-request invalid-json-body`)
      res.status(400).json({ error: 'Invalid JSON body' })
      return
    }
  }

  const {
    model,
    contents,
    inkSessionId,
    answerKey,
    answerKeyRef,
    routeKey,
    gradingMode: requestedGradingMode,
    readAnswerSplitMode: requestedReadAnswerSplitMode,
    ...payload
  } = body || {}
  const normalizedAnswerKeyPayload = normalizeAnswerKeyPayload(answerKey, logPrefix)
  const headerGradingMode = readSingleHeaderValue(req?.headers?.['x-grading-pipeline-mode'])
  const envGradingMode = getEnvValue('AI_GRADING_PIPELINE_MODE') || process.env.AI_GRADING_PIPELINE_MODE
  const gradingMode =
    normalizeGradingPipelineMode(requestedGradingMode) ||
    normalizeGradingPipelineMode(headerGradingMode) ||
    normalizeGradingPipelineMode(envGradingMode) ||
    'staged' // 預設使用分階段批改流程
  const enableStagedGrading = gradingMode !== 'single'

  const headerSplitMode = readSingleHeaderValue(req?.headers?.['x-read-answer-split-mode'])
  const envSplitMode = getEnvValue('READ_ANSWER_SPLIT_MODE')
  const readAnswerSplitMode =
    normalizeReadAnswerSplitMode(requestedReadAnswerSplitMode) ??
    normalizeReadAnswerSplitMode(headerSplitMode) ??
    normalizeReadAnswerSplitMode(envSplitMode)

  if (!model || !Array.isArray(contents)) {
    console.warn(`${logPrefix} bad-request missing model or contents`)
    res.status(400).json({ error: 'Missing model or contents' })
    return
  }
  console.log(
    `${logPrefix} request-body model=${model} routeKey=${routeKey || 'none'} hasAnswerKey=${Boolean(
      answerKey
    )} hasAnswerKeyRef=${Boolean(answerKeyRef)} answerKeyType=${answerKey ? typeof answerKey : 'none'} gradingMode=${gradingMode} staged=${enableStagedGrading} splitModeOverride=${
      readAnswerSplitMode === null ? 'none' : readAnswerSplitMode
    }`
  )

  // 🆕 處理 AnswerKey 緩存邏輯
  let resolvedAnswerKey = null
  let answerKeyHash = null
  
  if (normalizedAnswerKeyPayload) {
    // 前端傳來完整 AnswerKey：緩存並返回 hash
    answerKeyHash = computeAnswerKeyHash(normalizedAnswerKeyPayload)
    cacheAnswerKey(user.id, answerKeyHash, normalizedAnswerKeyPayload)
    resolvedAnswerKey = normalizedAnswerKeyPayload
    console.log(`📥 [AnswerKey] 收到完整 AnswerKey，hash=${answerKeyHash}`)
  } else if (answerKeyRef) {
    // 前端傳來 hash 引用：從緩存獲取
    const cachedAnswerKey = getCachedAnswerKey(user.id, answerKeyRef)
    resolvedAnswerKey = normalizeAnswerKeyPayload(cachedAnswerKey, logPrefix)
    if (!resolvedAnswerKey) {
      console.warn(`⚠️ [AnswerKey] 緩存未命中 ref=${answerKeyRef}，請求前端重傳`)
      res.status(422).json({ 
        error: 'AnswerKey cache miss or invalid format',
        code: 'ANSWER_KEY_CACHE_MISS_OR_INVALID',
        answerKeyRef 
      })
      return
    }
    // 將舊格式（字串）緩存回寫為物件，避免後續再解析失敗
    cacheAnswerKey(user.id, answerKeyRef, resolvedAnswerKey)
    answerKeyHash = answerKeyRef
    console.log(`📤 [AnswerKey] 使用緩存 AnswerKey，ref=${answerKeyRef}`)
  } else if (answerKey) {
    // 有傳 answerKey 但格式不合法（例如非法字串）
    console.warn(`${logPrefix} bad-request invalid-answerKey-format type=${typeof answerKey}`)
    res.status(400).json({
      error: 'Invalid answerKey format. Must be object or JSON-object string.'
    })
    return
  }

  // 🆕 如果有 AnswerKey，注入到 prompt 中
  let processedContents = contents
  if (resolvedAnswerKey) {
    processedContents = injectAnswerKeyToContents(contents, resolvedAnswerKey)
  }

  let supabaseAdmin = null
  let currentBalance = 0
  let hasValidInkSession = false
  try {
    supabaseAdmin = getSupabaseAdmin()
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('ink_balance, role')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) {
      console.error(`${logPrefix} profile-read-failed`, profileError?.message || profileError)
      res.status(500).json({ error: '讀取使用者點數失敗' })
      return
    }

    const isAdmin = profile?.role === 'admin'
    currentBalance =
      typeof profile?.ink_balance === 'number' ? profile.ink_balance : 0

    if (inkSessionId) {
      try {
        const sessionCheck = await resolveInkSession(
          supabaseAdmin,
          user.id,
          inkSessionId
        )
        if (!sessionCheck.ok) {
          let message = '批改會話無效，請重新進入批改頁'
          if (sessionCheck.expired) {
            message = '批改會話已過期，請重新進入批改頁'
          } else if (sessionCheck.reason === 'not_active') {
            message = `批改會話已結束（狀態：${sessionCheck.status}），請重新進入批改頁`
          } else if (sessionCheck.reason === 'not_found') {
            message = '批改會話不存在，請重新進入批改頁'
          }
          console.warn(`${logPrefix} ink-session-invalid reason=${sessionCheck.reason} sessionId=${inkSessionId}`)
          res.status(409).json({ error: message })
          return
        }
        hasValidInkSession = true
      } catch (error) {
        console.warn('Ink session check failed:', error)
        res.status(500).json({ error: '批改會話驗證失敗，請稍後再試' })
        return
      }
    }

    if (!isAdmin && !hasValidInkSession && currentBalance <= 0) {
      const message = inkSessionId
        ? '批改會話已結束或點數不足，請重新進入或補充墨水'
        : '墨水不足，請先補充墨水'
      console.warn(`${logPrefix} insufficient-ink balance=${currentBalance} hasSession=${Boolean(inkSessionId)}`)
      res.status(402).json({ error: message })
      return
    }
  } catch (error) {
    console.error(`${logPrefix} ink-check-failed`, error?.message || error)
    res.status(500).json({ error: '點數檢查失敗' })
    return
  }

  // ── 答案卷參考圖（Phase A classify 使用）────────────────────────────────────
  let answerKeyImages = []
  if (routeKey === 'grading.phase_a' && payload?.assignmentId) {
    answerKeyImages = await fetchAnswerSheetImagesForClassify(
      supabaseAdmin, user.id, payload.assignmentId
    )
    if (answerKeyImages.length > 0) {
      console.log(`📷 [AnswerSheet] 載入 ${answerKeyImages.length} 頁答案卷圖 assignmentId=${payload.assignmentId}`)
    }
  }

  try {
    const pipelineResult = await runAiPipeline({
      apiKey,
      model,
      contents: processedContents,
      payload,
      requestedRouteKey: routeKey,
      routeHint: {
        hasResolvedAnswerKey: Boolean(resolvedAnswerKey),
        hasAnswerKeyRef: Boolean(answerKeyRef),
        hasAnswerKeyPayload: Boolean(normalizedAnswerKeyPayload)
      },
      internalContext: {
        resolvedAnswerKey,
        requestId,
        enableStagedGrading,
        gradingMode,
        readAnswerSplitMode,
        answerKeyImages
      }
    })

    const responseStatus = Number(pipelineResult.status) || 500
    const responseOk = responseStatus >= 200 && responseStatus < 300
    const data = pipelineResult.data

    // 🆕 返回 answerKeyHash 給前端（用於後續請求）
    if (responseOk && answerKeyHash && data && typeof data === 'object') {
      data.answerKeyHash = answerKeyHash
    }

    if (responseOk && data?.usageMetadata) {
      try {
        const cost = computeInkPoints(data.usageMetadata)
        let inkSummary = null

        // Admin 不扣墨水
        if (isAdmin) {
          inkSummary = { chargedPoints: 0, balanceBefore: currentBalance, balanceAfter: currentBalance, applied: true, adminBypass: true }
        } else if (hasValidInkSession && inkSessionId) {
          const { error: usageError } = await supabaseAdmin
            .from('ink_session_usage')
            .insert({
              user_id: user.id,
              session_id: inkSessionId,
              input_tokens: cost.inputTokens,
              output_tokens: cost.outputTokens,
              total_tokens: cost.totalTokens,
              usage_metadata: data.usageMetadata
            })

          if (usageError) {
            console.warn('Ink session usage insert failed:', usageError)
          } else {
            inkSummary = {
              pending: true,
              sessionId: inkSessionId
            }
          }
        }

        if (!inkSummary) {
          if (cost.points > 0) {
            const nextBalance = currentBalance - cost.points
            const { error: updateError } = await supabaseAdmin
              .from('profiles')
              .update({
                ink_balance: nextBalance,
                updated_at: new Date().toISOString()
              })
              .eq('id', user.id)

            if (updateError) {
              console.warn('Ink balance update failed:', updateError)
              inkSummary = {
                chargedPoints: cost.points,
                balanceBefore: currentBalance,
                balanceAfter: currentBalance,
                applied: false
              }
            } else {
              inkSummary = {
                chargedPoints: cost.points,
                balanceBefore: currentBalance,
                balanceAfter: nextBalance,
                applied: true
              }
            }

            const { error: ledgerError } = await supabaseAdmin.from('ink_ledger').insert({
              user_id: user.id,
              delta: -cost.points,
              reason: 'gemini_generate_content',
              metadata: {
                model: model,
                usage: data.usageMetadata,
                cost,
                inkSessionId: inkSessionId || null
              }
            })

            if (ledgerError) {
              console.warn('Ink ledger insert failed:', ledgerError)
            }
          } else {
            inkSummary = {
              chargedPoints: 0,
              balanceBefore: currentBalance,
              balanceAfter: currentBalance,
              applied: true
            }
          }
        }

        if (inkSummary && data && typeof data === 'object') {
          data.ink = inkSummary
        }
      } catch (error) {
        console.warn('Ink billing failed:', error)
      }
    }

    console.log(
      `${logPrefix} response status=${responseStatus} resolvedRoute=${
        pipelineResult.resolvedRouteKey
      } pipeline=${pipelineResult.pipelineMeta?.pipeline || 'unknown'}`
    )

    // 批改結果摘要 log（grading.evaluate 時才輸出）
    if (responseOk && pipelineResult.resolvedRouteKey === 'grading.evaluate' && data) {
      const details = Array.isArray(data.details) ? data.details : []
      const correctCount = details.filter((d) => d.isCorrect === true).length
      const wrongCount = details.length - correctCount
      const perQ = details
        .map((d) => `${d.questionId}:${d.isCorrect ? '✓' : '✗'}${d.score}/${d.maxScore}`)
        .join(' ')
      console.log(
        `${logPrefix} grading-summary totalScore=${data.totalScore} questions=${details.length} correct=${correctCount} wrong=${wrongCount} needsReview=${Boolean(data.needsReview)}`
      )
      if (perQ) {
        console.log(`${logPrefix} grading-per-question ${perQ}`)
      }
      if (Array.isArray(data.reviewReasons) && data.reviewReasons.length > 0) {
        console.log(`${logPrefix} grading-review-reasons ${data.reviewReasons.join(' | ')}`)
      }
    }

    res.status(responseStatus).json(data)
  } catch (error) {
    console.error(`${logPrefix} request-failed`, error)
    if (Number(error?.status) === 504) {
      res.status(504).json({ error: 'Gemini request timeout' })
      return
    }
    res.status(500).json({ error: 'Failed to fetch Gemini API' })
  }
}
